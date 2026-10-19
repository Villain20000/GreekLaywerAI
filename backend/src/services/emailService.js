// Phase 23 + 24 + P0-6: Email service.
//
// Transports (selected by EMAIL_TRANSPORT):
//   - 'console' (default, dev/test only): logs the reset / verify URL with a
//     [DEV-EMAIL] prefix. REFUSES to run when NODE_ENV=production — the log
//     line contains a raw bearer credential.
//   - 'smtp': nodemailer transport configured via SMTP_HOST / SMTP_PORT /
//     SMTP_SECURE / SMTP_USER / SMTP_PASS + EMAIL_FROM.
//
// Production posture: this module HARD-THROWS at load time when
// NODE_ENV=production and SMTP is not fully configured (same fail-fast style
// as authMiddleware's JWT_SECRET guard). The pre-fix behavior — return 200
// while sending zero emails — shipped unverifiable accounts and unrecoverable
// passwords; a crashing deploy is strictly better than a silent one.

const nodemailer = require('nodemailer');

const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:4200';
const EMAIL_TRANSPORT = (process.env.EMAIL_TRANSPORT || 'console').toLowerCase();
const EMAIL_FROM = process.env.EMAIL_FROM || 'NomosAI <no-reply@nomos.ai>';

if (process.env.NODE_ENV === 'production') {
  const problems = [];
  if (EMAIL_TRANSPORT !== 'smtp') {
    problems.push(`EMAIL_TRANSPORT must be 'smtp' (got '${EMAIL_TRANSPORT}')`);
  }
  if (!process.env.SMTP_HOST) problems.push('SMTP_HOST is required');
  if (!process.env.EMAIL_FROM) problems.push('EMAIL_FROM is required');
  if (problems.length) {
    throw new Error(
      `[emailService] production email is not configured: ${problems.join('; ')}. ` +
      'Refusing to boot.'
    );
  }
}

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || 'false') === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined
    });
  }
  return transporter;
}

/**
 * Bounded exponential-backoff retry for transient SMTP failures (connection
 * resets, 4xx greylisting). Non-transient auth errors fail after the same
 * attempts — callers already treat send failures as non-fatal (fire-and-
 * forget with a .catch() that logs).
 */
async function sendWithRetry(sendFn, { attempts = 3, baseDelayMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await sendFn();
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastErr;
}

async function sendMail({ to, subject, text, html }) {
  const info = await sendWithRetry(() =>
    getTransporter().sendMail({ from: EMAIL_FROM, to, subject, text, html })
  );
  return info;
}

/**
 * Console-transport guard. Unreachable when the load-time production guard
 * ran, but defense-in-depth: never print a raw token to production logs.
 */
function assertConsoleSafe() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[emailService] the console email transport refuses to run with NODE_ENV=production.'
    );
  }
}

/**
 * Send a password-reset email.
 * @param {string} toEmail  Recipient's email address.
 * @param {string} resetToken Plaintext reset token (32-byte hex); the caller
 *                            stored only its SHA-256.
 * @returns {Promise<void>}
 */
async function sendPasswordReset(toEmail, resetToken) {
  const resetUrl = `${APP_BASE_URL}/reset-password?token=${encodeURIComponent(resetToken)}`;

  if (EMAIL_TRANSPORT === 'smtp') {
    await sendMail({
      to: toEmail,
      subject: 'NomosAI — Επαναφορά κωδικού πρόσβασης',
      text:
        'Ζητήσατε επαναφορά κωδικού πρόσβασης για τον λογαριασμό σας στο NomosAI.\n\n' +
        `Ορίστε νέο κωδικό από τον παρακάτω σύνδεσμο (ισχύει 1 ώρα):\n${resetUrl}\n\n` +
        'Αν δεν υποβάλατε εσείς αυτό το αίτημα, αγνοήστε αυτό το email.'
    });
    return;
  }

  assertConsoleSafe();
  console.log(
    `[DEV-EMAIL] Password-reset requested for ${toEmail}.\n` +
    `             Reset URL: ${resetUrl}\n` +
    `             (Dev console transport; never run with NODE_ENV=production.)`
  );
}

/**
 * Phase 24: send an email-verification link.
 * @param {string} toEmail  Recipient.
 * @param {string} verifyToken Plaintext 32-byte hex token; caller SHA256-hashed it for DB.
 * @returns {Promise<void>}
 */
async function sendEmailVerification(toEmail, verifyToken) {
  const verifyUrl = `${APP_BASE_URL}/verify-email?token=${encodeURIComponent(verifyToken)}`;

  if (EMAIL_TRANSPORT === 'smtp') {
    await sendMail({
      to: toEmail,
      subject: 'NomosAI — Επιβεβαίωση email',
      text:
        'Καλώς ήρθατε στο NomosAI.\n\n' +
        `Επιβεβαιώστε τη διεύθυνση email σας από τον παρακάτω σύνδεσμο (ισχύει 24 ώρες):\n${verifyUrl}\n\n` +
        'Αν δεν δημιουργήσατε εσείς αυτόν τον λογαριασμό, αγνοήστε αυτό το email.'
    });
    return;
  }

  assertConsoleSafe();
  console.log(
    `[DEV-EMAIL] Email-verification requested for ${toEmail}.\n` +
    `             Verify URL: ${verifyUrl}\n` +
    `             (Dev console transport; never run with NODE_ENV=production.)`
  );
}

module.exports = {
  sendPasswordReset,
  sendEmailVerification,
  APP_BASE_URL
};
