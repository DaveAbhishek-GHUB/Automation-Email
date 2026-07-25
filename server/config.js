/**
 * TitanMail — Default Configuration
 * Values are loaded from environment variables (Render / Railway / .env).
 * Set these in your hosting dashboard → Environment Variables.
 */
module.exports = {
  // ── Primary Email Sender ────────────────────────────────────────────────────
  // Option A: Titan SMTP (works on Render, local — does NOT work on Railway)
  SMTP_HOST:   process.env.SMTP_HOST   || 'smtp.titan.email',
  SMTP_PORT:   process.env.SMTP_PORT   || '587',
  SMTP_SECURE: process.env.SMTP_SECURE || 'false',   // false = TLS/STARTTLS on 587
  SMTP_USER:   process.env.SMTP_USER   || '',         // info@varadatech.com
  SMTP_PASS:   process.env.SMTP_PASS   || '',         // your Titan email password

  // Option B: Brevo HTTP API (works on Railway — leave blank if using Titan SMTP)
  BREVO_API_KEY: process.env.BREVO_API_KEY || '',

  // ── Sender identity ────────────────────────────────────────────────────────
  FROM_EMAIL: process.env.FROM_EMAIL || 'info@varadatech.com',
  FROM_NAME:  process.env.FROM_NAME  || 'VaradaTech',

  // ── Public app URL (for email open/click tracking) ─────────────────────────
  // Set this to your Render URL: https://your-app-name.onrender.com
  APP_URL: process.env.APP_URL || '',
};
