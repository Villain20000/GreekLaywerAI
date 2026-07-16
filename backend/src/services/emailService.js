// Phase 23: Email service.
//
// MVP posture:
//   - The project does not yet ship a transactional email provider (no
//     nodemailer/@sendgrid/mail in backend/package.json). To keep the
//     /forgot-password → /reset-password flow testable end-to-end without an
//     SMTP dependency, sendPasswordReset() in this module logs the reset
//     URL to the server console with a clearly-marked DEV prefix. In dev
//     environments the implementer copies the URL out of the logs and pastes
//     it into the browser.
//
// Production swap-in (one-file change, no caller edits):
//   - Set EMAIL_TRANSPORT=smtp + SMTP_HOST / SMTP_PORT / SMTP_USER /
//     SMTP_PASS / EMAIL_FROM env vars; swap the body of sendPasswordReset
//     for a nodemailer createTransport(...).sendMail(...) call. The exported
//     signature is intentionally minimal (to, resetUrl) so any provider
//     plugs in cleanly.

const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:4200';

/**
 * Shared prod-guard + dev-transport switch — every email-sending function
 * below calls this so we can't accidentally leak a plaintext token in
 * production logs.
 */
function assertSafeSend() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[emailService] send called in production without SMTP configured. ' +
      'Set EMAIL_TRANSPORT=smtp + SMTP_HOST/PORT/USER/PASS/EMAIL_FROM env vars.'
    );
  }
  if (process.env.EMAIL_TRANSPORT && process.env.EMAIL_TRANSPORT !== 'console') {
    throw new Error(
      `[emailService] EMAIL_TRANSPORT=${process.env.EMAIL_TRANSPORT} is not yet implemented. ` +
      'Currently only the dev "console" transport is available.'
    );
  }
}

/**
 * Send a password-reset email.
 * @param {string} toEmail  Recipient's email address (already verified to exist in users table).
 * @param {string} resetToken Plaintext reset token (32-byte hex). The caller built and
 *                          SHA256-hashed this token for DB storage; the plaintext is the
 *                          secret only this function consumes.
 * @returns {Promise<void>}
 */
async function sendPasswordReset(toEmail, resetToken) {
  const resetUrl = `${APP_BASE_URL}/reset-password?token=${encodeURIComponent(resetToken)}`;
  // Hard guard: the dev transport prints the raw reset token to logs. If
  // this function ever runs in production (NODE_ENV=production) it would
  // leak the bearer credential to anyone with log access. assertSafeSend()
  // refuses to send rather than silently leak.
  assertSafeSend();
  console.log(
    `[DEV-EMAIL] Password-reset requested for ${toEmail}.\n` +
    `             Reset URL: ${resetUrl}\n` +
    `             (Dev console transport; never run with NODE_ENV=production.)`
  );
  return Promise.resolve();
}

/**
 * Phase 24: send an email-verification link.
 * @param {string} toEmail  Recipient.
 * @param {string} verifyToken Plaintext 32-byte hex token; caller SHA256-hashed it for DB.
 * @returns {Promise<void>}
 */
async function sendEmailVerification(toEmail, verifyToken) {
  const verifyUrl = `${APP_BASE_URL}/verify-email?token=${encodeURIComponent(verifyToken)}`;
  assertSafeSend();
  console.log(
    `[DEV-EMAIL] Email-verification requested for ${toEmail}.\n` +
    `             Verify URL: ${verifyUrl}\n` +
    `             (Dev console transport; never run with NODE_ENV=production.)`
  );
  return Promise.resolve();
}

module.exports = {
  sendPasswordReset,
  sendEmailVerification,
  APP_BASE_URL
};
