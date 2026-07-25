/**
 * TitanMail — Configuration
 * Set these in Render Dashboard → Your Service → Environment Variables.
 */
module.exports = {
  // ── Resend API (sends via HTTPS port 443 — works on all cloud hosts) ─────────
  // Get free key at: https://resend.com → API Keys → Create API Key
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',

  // ── Sender identity ────────────────────────────────────────────────────────
  FROM_EMAIL: process.env.FROM_EMAIL || 'info@varadatech.com',
  FROM_NAME:  process.env.FROM_NAME  || 'VaradaTech',

  // ── Public app URL (for email open/click tracking) ─────────────────────────
  APP_URL: process.env.APP_URL || 'https://automation-email-u0b2.onrender.com',
};
