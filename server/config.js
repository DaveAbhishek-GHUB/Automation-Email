/**
 * TitanMail — Configuration
 * Set these as Environment Variables in Render Dashboard → Service → Environment.
 * Values here are defaults used if env vars are not set.
 */
module.exports = {
  // ── GoDaddy / cPanel SMTP (your email provider for info@varadatech.com) ──────────
  SMTP_HOST:   process.env.SMTP_HOST   || 'smtpout.secureserver.net',
  SMTP_PORT:   process.env.SMTP_PORT   || '465',
  SMTP_SECURE: process.env.SMTP_SECURE || 'true',   // true = SSL on port 465 (verified working)
  SMTP_USER:   process.env.SMTP_USER   || 'info@varadatech.com',
  SMTP_PASS:   process.env.SMTP_PASS   || '',

  // ── Sender identity ────────────────────────────────────────────────────────
  FROM_EMAIL: process.env.FROM_EMAIL || 'info@varadatech.com',
  FROM_NAME:  process.env.FROM_NAME  || 'VaradaTech',

  // ── Public app URL (for email open/click tracking) ─────────────────────────
  APP_URL: process.env.APP_URL || 'https://automation-email-u0b2.onrender.com',
};
