/**
 * What PeekInside keeps of an email the app sent with nodemailer, read from the message as its
 * transport got it: after the app's plugins rendered its templates, with the transporter's
 * defaults applied. Nothing in the message is changed.
 *
 * Bodies are kept as text up to a limit. Attachments are kept by name, type and size: never their
 * content. A body given as a file, a URL or a stream is named, not read: reading it again could
 * have effects, and the transport is reading it.
 */

export const MAIL_LIMITS = Object.freeze({
  html: 256 * 1024,
  text: 64 * 1024,
  subject: 1000,
  addresses: 100,
  headers: 100,
  header: 2000,
  attachments: 50,
  response: 1000,
  summaryTo: 3
});

const ADDRESS_FIELDS = [['from', 'from'], ['sender', 'sender'], ['replyTo', 'reply-to'], ['to', 'to'], ['cc', 'cc'], ['bcc', 'bcc']];

/**
 * @typedef {{ name: string, address: string }} MailAddress
 */

export class MailReader {
  /**
   * The message as the transport got it.
   *
   * @param {Object} mail - nodemailer's MailMessage: `data` with the message's fields, `message` its
   *   built MIME tree (absent when building it failed)
   * @returns {{ summary: Object, detail: Object }}
   */
  static read(mail) {
    const data = (mail && mail.data) || {};
    const message = mail && mail.message;
    const addresses = MailReader.addresses(data, message);
    const html = body(data.html, MAIL_LIMITS.html);
    const text = body(data.text, MAIL_LIMITS.text);
    const attachments = Array.isArray(data.attachments) ? data.attachments : [];
    const subject = typeof data.subject === 'string' ? cut(data.subject, MAIL_LIMITS.subject) : '';

    return {
      summary: {
        subject,
        from: addresses.from.length ? display(addresses.from[0]) : null,
        to: [...addresses.to, ...addresses.cc].slice(0, MAIL_LIMITS.summaryTo).map(display),
        recipients: addresses.to.length + addresses.cc.length + addresses.bcc.length,
        attachments: attachments.length,
        html: html.text !== null || html.source !== null
      },
      detail: {
        ...addresses,
        subject,
        html: html.text,
        htmlTruncated: html.truncated,
        htmlSource: html.source,
        text: text.text,
        textTruncated: text.truncated,
        textSource: text.source,
        headers: headers(data.headers),
        attachments: attachments.slice(0, MAIL_LIMITS.attachments).map(attachment),
        messageId: message ? safe(() => message.messageId(), null) : null,
        envelope: message ? safe(() => envelope(message.getEnvelope()), null) : null
      }
    };
  }

  /**
   * The message's addresses, with their names: parsed by nodemailer when the message was built,
   * else from what the app gave.
   *
   * @param {Object} data
   * @param {Object} [message] - The built MIME tree
   * @returns {{ from: MailAddress[], sender: MailAddress[], replyTo: MailAddress[], to: MailAddress[], cc: MailAddress[], bcc: MailAddress[] }}
   */
  static addresses(data, message) {
    const parsed = message ? safe(() => message.getAddresses(), null) : null;
    const result = {};
    for (const [field, header] of ADDRESS_FIELDS) {
      const list = parsed ? parsed[header] : given(data[field]);
      result[field] = flatten(list).slice(0, MAIL_LIMITS.addresses);
    }
    // nodemailer keeps Bcc off the built message: the app's field says who got a blind copy.
    if (parsed && !result.bcc.length) result.bcc = flatten(given(data.bcc)).slice(0, MAIL_LIMITS.addresses);
    return result;
  }

  /**
   * How the transport answered: the recipients it accepted and rejected, and its response, or the
   * error it failed with.
   *
   * @param {*} info - What sendMail() resolved with
   * @param {*} error - What it failed with
   * @returns {{ status: 'sent'|'failed', accepted: string[], rejected: string[], response: string|null, messageId: string|null, error: Object|null }}
   */
  static outcome(info, error) {
    if (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      return {
        status: 'failed',
        accepted: [],
        rejected: [],
        response: typeof failure.response === 'string' ? cut(failure.response, MAIL_LIMITS.response) : null,
        messageId: null,
        error: {
          name: cut(String(failure.name || 'Error'), 200),
          message: cut(String(failure.message || ''), 2000),
          code: typeof failure.code === 'string' ? failure.code.slice(0, 64) : null,
          command: typeof failure.command === 'string' ? failure.command.slice(0, 64) : null
        }
      };
    }
    const answer = info && typeof info === 'object' ? info : {};
    return {
      status: 'sent',
      accepted: recipients(answer.accepted),
      rejected: recipients(answer.rejected),
      response: typeof answer.response === 'string' ? cut(answer.response, MAIL_LIMITS.response) : null,
      messageId: typeof answer.messageId === 'string' ? answer.messageId.slice(0, 998) : null,
      error: null
    };
  }
}

// A body as text, or what it was given as when it isn't kept: a file, a URL, a stream.
function body(value, limit) {
  if (typeof value === 'string') return keep(value, limit);
  if (Buffer.isBuffer(value)) return keep(value.toString('utf8'), limit);
  if (value && typeof value === 'object') {
    if (typeof value.content === 'string' || Buffer.isBuffer(value.content)) return body(value.content, limit);
    if (typeof value.path === 'string') return { text: null, truncated: false, source: 'file' };
    if (typeof value.href === 'string') return { text: null, truncated: false, source: 'url' };
    if (typeof value.pipe === 'function' || (value.content && typeof value.content.pipe === 'function')) return { text: null, truncated: false, source: 'stream' };
  }
  return { text: null, truncated: false, source: null };
}

function keep(text, limit) {
  return text.length > limit ? { text: text.slice(0, limit), truncated: true, source: null } : { text, truncated: false, source: null };
}

// An attachment's name, type, size and how it's referenced in the HTML; never its content.
function attachment(value) {
  const item = value && typeof value === 'object' ? value : {};
  let source = 'content';
  let size = null;
  if (typeof item.content === 'string') {
    size = item.encoding === 'base64' ? Math.floor((item.content.replace(/[\s=]/g, '').length * 3) / 4) : Buffer.byteLength(item.content, 'utf8');
  } else if (Buffer.isBuffer(item.content)) {
    size = item.content.length;
  } else if (item.content && typeof item.content.pipe === 'function') {
    source = 'stream';
  } else if (typeof item.path === 'string') {
    source = /^(https?|data):/i.test(item.path) ? 'url' : 'file';
  } else if (typeof item.href === 'string') {
    source = 'url';
  } else if (item.raw !== undefined) {
    source = 'raw';
  }
  const filename = typeof item.filename === 'string' ? item.filename : typeof item.path === 'string' && source === 'file' ? item.path.split(/[\\/]/).pop() : null;
  const cid = typeof item.cid === 'string' ? item.cid.slice(0, 256) : null;
  return {
    filename: filename ? filename.slice(0, 256) : null,
    contentType: typeof item.contentType === 'string' ? item.contentType.slice(0, 128) : null,
    size,
    cid,
    inline: item.contentDisposition === 'inline' || cid !== null,
    source
  };
}

// The app's own headers, as name and value: an object (values may be lists, or { prepared, value })
// or a list of { key, value }.
function headers(value) {
  const pairs = [];
  const add = (name, entry) => {
    if (pairs.length >= MAIL_LIMITS.headers || typeof name !== 'string') return;
    const text = entry && typeof entry === 'object' && !Array.isArray(entry) && 'value' in entry ? entry.value : entry;
    for (const one of Array.isArray(text) ? text : [text]) {
      if (one === undefined || one === null || pairs.length >= MAIL_LIMITS.headers) continue;
      pairs.push([name.slice(0, 200), cut(String(one), MAIL_LIMITS.header)]);
    }
  };
  if (Array.isArray(value)) {
    for (const entry of value) if (entry && typeof entry === 'object') add(entry.key, entry.value);
  } else if (value && typeof value === 'object') {
    for (const name of Object.keys(value)) add(name, value[name]);
  }
  return pairs;
}

// Addresses as the app gave them: a string (a list, "Name <address>" or a bare address),
// { name, address }, or a list of either.
function given(value) {
  if (value === undefined || value === null || value === false) return [];
  if (Array.isArray(value)) return value.flatMap(given);
  if (typeof value === 'string') return splitList(value).map(parseAddress).filter(Boolean);
  if (typeof value === 'object' && typeof value.address === 'string') return [{ name: typeof value.name === 'string' ? value.name : '', address: value.address }];
  return [];
}

// "Ada <ada@x.test>, bob@y.test" as its entries: commas inside quotes or angle brackets don't split.
function splitList(text) {
  const parts = [];
  let current = '';
  let quoted = false;
  let angle = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (char === '<' && !quoted) angle = true;
    else if (char === '>' && !quoted) angle = false;
    if ((char === ',' || char === ';') && !quoted && !angle) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function parseAddress(part) {
  const text = part.trim();
  if (!text) return null;
  const named = /^(.*?)\s*<([^<>]+)>$/.exec(text);
  return named ? { name: named[1].trim().replace(/^"(.*)"$/, '$1'), address: named[2].trim() } : { name: '', address: text };
}

// nodemailer lists a group's members under it.
function flatten(list) {
  const result = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || typeof entry !== 'object') continue;
    if (Array.isArray(entry.group)) result.push(...flatten(entry.group));
    else if (typeof entry.address === 'string') result.push({ name: typeof entry.name === 'string' ? entry.name.slice(0, 256) : '', address: entry.address.slice(0, 320) });
  }
  return result;
}

function display(address) {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

function envelope(value) {
  if (!value || typeof value !== 'object') return null;
  return { from: typeof value.from === 'string' ? value.from.slice(0, 320) : null, to: recipients(value.to) };
}

function recipients(value) {
  return (Array.isArray(value) ? value : []).filter((item) => typeof item === 'string').slice(0, MAIL_LIMITS.addresses).map((item) => item.slice(0, 320));
}

function cut(text, limit) {
  return text.length > limit ? text.slice(0, limit) : text;
}

function safe(read, fallback) {
  try {
    return read();
  } catch (error) {
    return fallback;
  }
}
