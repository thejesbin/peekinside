/**
 * nodemailer, for the local dashboard's Mail page: every sendMail() of a transporter is recorded
 * (see MailCapture), whatever its transport (SMTP, SES, sendmail, JSON, a stream or a plugin).
 *
 * The patch is on Mailer, the class createTransport() returns, so transporters made before
 * PeekInside started are covered too. nodemailer 10 ships a CommonJS and an ES module build, each
 * with its own Mailer: both are patched. The message is read at nodemailer's "stream" step, once
 * the app's "compile" plugins (templates) have run and the MIME message is built; a message that
 * fails before that is read as the app passed it.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { MailCapture } from '../mail/mail-capture.js';

const kPatched = Symbol.for('peekinside.nodemailer');
// The sendMail() call a message belongs to, while nodemailer builds and sends it.
const sends = new AsyncLocalStorage();

export const MailInstrumentation = {
  /**
   * Patches nodemailer's Mailer, from its mailer module (`nodemailer/lib/mailer`, either build).
   *
   * @param {*} value - The module, or the Mailer class
   * @returns {boolean} Whether it was nodemailer's Mailer
   */
  mailer(value) {
    const Mailer = typeof value === 'function' ? value : value && typeof value.default === 'function' ? value.default : null;
    return Mailer ? patchMailer(Mailer.prototype) : false;
  },

  /**
   * Patches nodemailer from its main module, given by the app (PeekInside#instrument()): its Mailer
   * is reached through a transporter that never sends anything.
   *
   * @param {*} nodemailer
   * @returns {boolean}
   */
  main(nodemailer) {
    if (!nodemailer || typeof nodemailer.createTransport !== 'function' || typeof nodemailer.createTestAccount !== 'function') return false;
    try {
      return patchMailer(Object.getPrototypeOf(nodemailer.createTransport({ jsonTransport: true })));
    } catch (error) {
      return false;
    }
  }
};

function patchMailer(proto) {
  if (!proto || typeof proto.sendMail !== 'function') return false;
  if (proto[kPatched]) return true;
  const sendMail = proto.sendMail;
  const processPlugins = proto._processPlugins;

  proto.sendMail = function peekInsideSendMail(data, callback) {
    let send = null;
    try {
      const capture = MailCapture.current();
      send = capture ? capture.begin(data, peekInsideSendMail) : null;
    } catch (error) {
      send = null;
    }
    if (!send) return sendMail.apply(this, arguments);

    const transporter = this.transporter;
    if (typeof callback === 'function') {
      return sends.run(send, () =>
        sendMail.call(this, data, function (error, info) {
          send.finish(error, info, data, transporter);
          return callback.apply(this, arguments);
        })
      );
    }
    const promise = sends.run(send, () => sendMail.call(this, data));
    if (promise && typeof promise.then === 'function') {
      // Watched, not changed: the app gets nodemailer's own promise.
      promise.then((info) => send.finish(null, info, data, transporter), (error) => send.finish(error, null, data, transporter));
    }
    return promise;
  };

  if (typeof processPlugins === 'function') {
    proto._processPlugins = function peekInsideProcessPlugins(step, mail) {
      if (step === 'stream') {
        const send = sends.getStore();
        if (send) send.message(mail);
      }
      return processPlugins.apply(this, arguments);
    };
  }

  Object.defineProperty(proto, kPatched, { value: true });
  return true;
}
