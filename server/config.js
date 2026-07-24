/**
 * TitanMail — Default Configuration
 * Credentials are loaded from Railway Variables (set once, work forever).
 * Fallback values are used if env vars are not set.
 */
module.exports = {
  // ── Brevo API (Primary email sender — works on Railway 24/7) ───────────────
  // Set BREVO_API_KEY in Railway Variables → persists forever, never needs re-entry
  BREVO_API_KEY: process.env.BREVO_API_KEY || '',

  // ── Sender identity ────────────────────────────────────────────────────────
  FROM_EMAIL: process.env.FROM_EMAIL || 'info@varadatech.com',
  FROM_NAME:  process.env.FROM_NAME  || 'VaradaTech',

  // ── Public app URL (for Gmail open tracking) ───────────────────────────────
  APP_URL: process.env.APP_URL || 'https://automation-email-production.up.railway.app',

  // ── GoDaddy SMTP (fallback for local use) ──────────────────────────────────
  SMTP_HOST:   process.env.SMTP_HOST   || 'smtpout.secureserver.net',
  SMTP_PORT:   process.env.SMTP_PORT   || '465',
  SMTP_SECURE: process.env.SMTP_SECURE || 'true',
  SMTP_USER:   process.env.SMTP_USER   || 'info@varadatech.com',
  SMTP_PASS:   process.env.SMTP_PASS   || '',
};
