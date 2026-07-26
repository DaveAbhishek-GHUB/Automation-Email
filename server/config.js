/**
 * TitanMail — Configuration
 * Set these as Environment Variables in Render Dashboard → Service → Environment.
 * Values here are defaults used if env vars are not set.
 */
module.exports = {
  // ── Titan Mail SMTP (Primary sender) ───────────────────────────────────────
  SMTP_HOST:   process.env.SMTP_HOST   || 'smtp.titan.email',
  SMTP_PORT:   process.env.SMTP_PORT   || '587',
  SMTP_SECURE: process.env.SMTP_SECURE || 'false',   // false = STARTTLS on port 587
  SMTP_USER:   process.env.SMTP_USER   || '',         // your Titan email: info@varadatech.com
  SMTP_PASS:   process.env.SMTP_PASS   || '',         // your Titan email password

  // ── Sender identity ────────────────────────────────────────────────────────
  FROM_EMAIL: process.env.FROM_EMAIL || 'info@varadatech.com',
  FROM_NAME:  process.env.FROM_NAME  || 'VaradaTech',

  // ── Public app URL (for email open/click tracking) ─────────────────────────
  APP_URL: process.env.APP_URL || 'https://automation-email-u0b2.onrender.com',
};
