/**
 * Tells local development apart from a deployed server, request by request.
 *
 * The free local dashboard records local development only. A request that reached the app
 * through a public domain or IP address, or that a proxy forwarded from a public client, means
 * the app runs on a server: those requests need PeekInside Cloud and are not recorded locally.
 *
 * Local means: localhost and *.localhost, reserved and LAN names (*.test, *.local, *.internal...),
 * single-label names (Docker services, machine names), loopback and private addresses, the
 * networks this machine is on, and development tunnels such as ngrok (webhooks to a laptop).
 */

import net from 'net';
import os from 'os';

const LOCAL_SUFFIXES = ['.localhost', '.test', '.local', '.localdomain', '.internal', '.lan', '.home.arpa', '.example', '.invalid'];
const TUNNEL_SUFFIXES = [
  '.ngrok.io', '.ngrok.app', '.ngrok.dev', '.ngrok-free.app', '.ngrok-free.dev',
  '.trycloudflare.com', '.loca.lt', '.sharedwithexpose.com', '.lhr.life', '.app.github.dev', '.gitpod.io'
];
const PRIVATE_SUBNETS = [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'], ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'],
  ['::', 128, 'ipv6'], ['::1', 128, 'ipv6'], ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6']
];
// Network interfaces change (Wi-Fi, VPN), but reading them on every request would be wasteful.
const NETWORKS_TTL_MS = 60_000;

/**
 * @typedef {Object} ServerSignal
 * @property {'host'|'client'} kind - What gave the server away: the public host name the request
 *   was sent to, or the public client address behind a proxy
 * @property {string} value - That host name or address
 */

/**
 * Classifies requests as local development or server traffic.
 *
 * Keeps the networks this machine is on (refreshed every minute), since addresses on them are
 * local too.
 */
export class TrafficClassifier {
  /**
   * The machine's networks are read on first use, not here.
   */
  constructor() {
    this._networks = null;
    this._networksAt = 0;
  }

  /**
   * @param {import('http').IncomingMessage} req
   * @returns {ServerSignal|null} What shows the request came to a server, or null when it is local
   */
  serverSignal(req) {
    const headers = req.headers || {};
    const hosts = [headers.host, first(headers['x-forwarded-host']), ...forwardedValues(headers.forwarded, 'host')]
      .map(hostnameOf)
      .filter(Boolean);

    // A tunnel brings outside requests (webhooks, a shared link) to a developer's machine.
    if (hosts.some(isTunnel)) return null;

    const publicHost = hosts.find((host) => !this.isLocalHostname(host));
    if (publicHost) return { kind: 'host', value: publicHost };

    // Proxies often rewrite Host (nginx sends the upstream address by default), but the client
    // address still shows where the request came from.
    const clients = [
      req.socket && req.socket.remoteAddress,
      ...list(headers['x-forwarded-for']),
      first(headers['x-real-ip']),
      ...forwardedValues(headers.forwarded, 'for')
    ];
    for (const client of clients) {
      const ip = ipOf(client);
      if (ip && !this.isLocalAddress(ip)) return { kind: 'client', value: ip };
    }
    return null;
  }

  /**
   * @param {string} hostname - Host name or address, without the port
   * @returns {boolean} Whether the name only makes sense in local development
   */
  isLocalHostname(hostname) {
    const host = String(hostname).toLowerCase().replace(/\.$/, '');
    if (!host || host === 'localhost') return true;
    if (net.isIP(host)) return this.isLocalAddress(host);
    if (!host.includes('.')) return true;
    return LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix)) || isTunnel(host);
  }

  /**
   * @param {string} address - IPv4 or IPv6 address
   * @returns {boolean} Whether the address is private, loopback, or on one of this machine's networks
   */
  isLocalAddress(address) {
    const ip = unmapIPv4(address);
    const family = net.isIP(ip);
    if (!family) return false;
    return this._localNetworks().check(ip, family === 6 ? 'ipv6' : 'ipv4');
  }

  // Private ranges plus the networks this machine is on (e.g. public IPv6 addresses on home Wi-Fi).
  _localNetworks() {
    if (this._networks && Date.now() - this._networksAt < NETWORKS_TTL_MS) return this._networks;
    const list = new net.BlockList();
    for (const [address, prefix, type] of PRIVATE_SUBNETS) list.addSubnet(address, prefix, type);
    try {
      for (const iface of Object.values(os.networkInterfaces()).flat()) {
        if (!iface || !iface.cidr) continue;
        const [address, prefix] = iface.cidr.split('/');
        const type = net.isIP(address) === 6 ? 'ipv6' : 'ipv4';
        list.addSubnet(address.split('%')[0], Number(prefix), type);
      }
    } catch (error) {
      // Interface details are optional: private ranges still apply.
    }
    this._networks = list;
    this._networksAt = Date.now();
    return list;
  }
}

function isTunnel(host) {
  return TUNNEL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

// "host:port", "[::1]:port" or a bare host -> host name or address, without the port.
function hostnameOf(value) {
  if (typeof value !== 'string') return '';
  const host = value.trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end > 0 ? host.slice(1, end) : '';
  }
  const colons = host.split(':').length - 1;
  if (colons === 1) return host.slice(0, host.indexOf(':'));
  return host; // a bare name, or an IPv6 address without brackets
}

// Client addresses as proxies write them: "203.0.113.7", "203.0.113.7:51234", "[2001:db8::1]:443".
function ipOf(value) {
  if (typeof value !== 'string') return '';
  let address = value.trim().replace(/^"|"$/g, '');
  if (address.startsWith('[')) address = address.slice(1, address.indexOf(']'));
  else if (address.split(':').length === 2) address = address.slice(0, address.indexOf(':'));
  address = unmapIPv4(address.split('%')[0]);
  return net.isIP(address) ? address : '';
}

// "::ffff:192.168.1.7" (IPv4 on a dual-stack socket) -> "192.168.1.7"
function unmapIPv4(address) {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return match ? match[1] : address;
}

// First value of a header that may be repeated or comma-separated.
function first(value) {
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === 'string' ? text.split(',')[0].trim() : undefined;
}

// All values of a header that may be repeated or comma-separated.
function list(value) {
  const text = Array.isArray(value) ? value.join(',') : value;
  return typeof text === 'string' ? text.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

// RFC 7239: Forwarded: for=192.0.2.60;proto=http;host=example.com, for=198.51.100.17
function forwardedValues(value, key) {
  const values = [];
  for (const element of list(value)) {
    for (const pair of element.split(';')) {
      const index = pair.indexOf('=');
      if (index > 0 && pair.slice(0, index).trim().toLowerCase() === key) {
        values.push(pair.slice(index + 1).trim().replace(/^"|"$/g, ''));
      }
    }
  }
  return values;
}
