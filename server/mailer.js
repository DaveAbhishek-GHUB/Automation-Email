const nodemailer = require('nodemailer');
const handlebars = require('handlebars');
const { queries, run, get, all } = require('./db');
const DEFAULTS = require('./config');

// ── Apply defaults to process.env if not already set ─────────────────────────
// This means the app works 24/7 out of the box — no manual configuration needed
const ENV_KEYS = ['BREVO_API_KEY','FROM_EMAIL','FROM_NAME','APP_URL',
                  'SMTP_HOST','SMTP_PORT','SMTP_SECURE','SMTP_USER','SMTP_PASS'];
for (const key of ENV_KEYS) {
  if (!process.env[key] && DEFAULTS[key]) process.env[key] = DEFAULTS[key];
}

let transporter = null;

// ─── SMTP Config (fallback when no Brevo API key) ────────────────────────────
function getSmtpConfig() {
  return {
    host:   process.env.SMTP_HOST || 'smtpout.secureserver.net',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: (process.env.SMTP_SECURE || 'false') === 'true',
    auth: {
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
    tls: { rejectUnauthorized: false },
    pool: true,
    maxConnections: 3,
    maxMessages: 10,
    rateDelta: 1000,
    rateLimit: 1,
  };
}

function createTransporter() {
  const config = getSmtpConfig();
  if (!config.auth.user || !config.auth.pass) {
    console.warn('⚠️  SMTP credentials not configured.');
    transporter = null;
    return null;
  }
  transporter = nodemailer.createTransport(config);
  return transporter;
}

async function createTransporterFromDB() {
  try {
    const keys = ['smtp_host','smtp_port','smtp_user','smtp_pass','smtp_secure',
                  'from_name','from_email','brevo_api_key'];
    for (const key of keys) {
      const row = await get(`SELECT value FROM settings WHERE key='${key}'`);
      if (row?.value) process.env[key.toUpperCase()] = row.value;
    }
  } catch(e) { /* DB not ready yet */ }
  return createTransporter();
}

// ─── Brevo HTTP API (bypasses all SMTP port blocking on Railway) ──────────────
async function sendViaBrevoAPI({ to, toName, subject, html, text, fromName, fromEmail, replyTo }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error('Brevo API key not configured');

  const senderEmail = fromEmail || process.env.FROM_EMAIL || process.env.SMTP_USER;
  const senderName  = fromName  || process.env.FROM_NAME  || 'VaradaTech';

  const body = {
    sender: { name: senderName, email: senderEmail },
    to: [{ email: to, name: toName || to }],
    replyTo: { email: replyTo || senderEmail, name: senderName },
    subject,
    htmlContent: html,
    textContent: text,
    // Headers that help land in Primary inbox instead of Promotions
    headers: {
      'X-Priority':          '3',
      'X-Mailer':            'TitanMail-1.0',
      'List-Unsubscribe':    `<mailto:unsubscribe@varadatech.com>`,
      'Precedence':          'bulk',
    },
  };

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
    body:    JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(`Brevo API error: ${err.message || res.statusText}`);
  }
  return await res.json();
}

async function verifyBrevoAPIKey(apiKey) {
  const key = apiKey || process.env.BREVO_API_KEY;
  if (!key) return { success: false, message: 'Brevo API key not set' };

  const res = await fetch('https://api.brevo.com/v3/account', {
    headers: { 'api-key': key },
  });

  if (res.ok) {
    const data = await res.json();
    return { success: true, message: `✅ Brevo API connected! Account: ${data.email || data.companyName || 'Verified'}` };
  }
  const err = await res.json().catch(() => ({ message: 'Invalid API key' }));
  return { success: false, message: `Brevo API error: ${err.message}` };
}

// ─── Unified verifyConnection (tries Brevo API first, then SMTP) ──────────────
async function verifyConnection() {
  try {
    // Try Brevo API key first (always works on Railway)
    const brevoKeyRow = await get("SELECT value FROM settings WHERE key='brevo_api_key'").catch(() => null);
    const brevoKey = brevoKeyRow?.value || process.env.BREVO_API_KEY;

    if (brevoKey) {
      process.env.BREVO_API_KEY = brevoKey;
      return await verifyBrevoAPIKey(brevoKey);
    }

    // Fall back to SMTP with 25s timeout
    const rows = await Promise.all([
      get("SELECT value FROM settings WHERE key='smtp_host'"),
      get("SELECT value FROM settings WHERE key='smtp_pass'"),
      get("SELECT value FROM settings WHERE key='smtp_user'"),
      get("SELECT value FROM settings WHERE key='smtp_port'"),
      get("SELECT value FROM settings WHERE key='smtp_secure'"),
    ]);
    if (rows[0]?.value) process.env.SMTP_HOST   = rows[0].value;
    if (rows[1]?.value) process.env.SMTP_PASS   = rows[1].value;
    if (rows[2]?.value) process.env.SMTP_USER   = rows[2].value;
    if (rows[3]?.value) process.env.SMTP_PORT   = rows[3].value;
    if (rows[4]?.value) process.env.SMTP_SECURE = rows[4].value;

    const t = createTransporter();
    if (!t) return { success: false, message: 'No credentials configured. Add a Brevo API key or SMTP password in Settings.' };

    await Promise.race([
      t.verify(),
      new Promise((_, rej) => setTimeout(() =>
        rej(new Error('SMTP timed out after 25s — Railway blocks SMTP ports. Use a Brevo API key instead (see Settings).')), 25000))
    ]);
    await queries.setSetting('smtp_configured', 'true');
    return { success: true, message: '✅ SMTP connection verified! Emails will send successfully.' };
  } catch (err) {
    await queries.setSetting('smtp_configured', 'false').catch(() => {});
    return { success: false, message: err.message };
  }
}

// ─── Template helpers ─────────────────────────────────────────────────────────
function compileTemplate(htmlTemplate, data) {
  try { return handlebars.compile(htmlTemplate || '')(data); }
  catch (e) { return htmlTemplate || ''; }
}

function addUnsubscribeLink(html, trackingId, appUrl) {
  const unsubUrl   = `${appUrl}/unsubscribe/${trackingId}`;
  const trackedUrl = `${appUrl}/track/click/${trackingId}?url=${encodeURIComponent(unsubUrl)}`;
  return html + `<div style="margin-top:40px;padding-top:20px;border-top:1px solid #e5e7eb;text-align:center;font-family:Arial,sans-serif;font-size:12px;color:#9ca3af;"><p>You're receiving this email because you opted in.</p><p><a href="${trackedUrl}" style="color:#6b7280;">Unsubscribe</a></p></div>`;
}

function addTrackingPixel(html, trackingId, appUrl) {
  const pixel = `<img src="${appUrl}/track/open/${trackingId}" width="1" height="1" style="display:none;" alt="" />`;
  return html.includes('</body>') ? html.replace('</body>', `${pixel}</body>`) : html + pixel;
}

function addClickTracking(html, trackingId, appUrl) {
  return html.replace(/<a\s+([^>]*?)href="(https?:\/\/[^"]+)"([^>]*?)>/gi, (match, before, url, after) => {
    if (url.includes('/unsubscribe/') || url.includes('/track/')) return match;
    return `<a ${before}href="${appUrl}/track/click/${trackingId}?url=${encodeURIComponent(url)}"${after}>`;
  });
}

// ─── Send a single email (Brevo API → SMTP fallback) ─────────────────────────
async function sendEmail({ to, toName, subject, htmlBody, textBody, fromName, fromEmail, replyTo, trackingId, appUrl }) {
  // Always resolve app URL from DB → env → hardcoded Railway URL
  let dbAppUrl = null;
  try {
    const s = await get("SELECT value FROM settings WHERE key='app_url'");
    dbAppUrl = s?.value || null;
  } catch(e) {}
  const resolvedAppUrl = dbAppUrl || appUrl || process.env.APP_URL || 'https://automation-email-production.up.railway.app';

  // Always resolve from_email — never let it be empty (Brevo rejects empty sender)
  let dbFromEmail = null, dbFromName = null;
  try {
    const fe = await get("SELECT value FROM settings WHERE key='from_email'");
    const fn = await get("SELECT value FROM settings WHERE key='from_name'");
    dbFromEmail = fe?.value || null;
    dbFromName  = fn?.value || null;
  } catch(e) {}
  const resolvedFromName  = fromName  || dbFromName  || process.env.FROM_NAME  || 'VaradaTech';
  const resolvedFromEmail = fromEmail || dbFromEmail || process.env.FROM_EMAIL || process.env.SMTP_USER || 'info@varadatech.com';

  let finalHtml = htmlBody || '';
  if (trackingId) {
    finalHtml = addTrackingPixel(finalHtml, trackingId, resolvedAppUrl);
    finalHtml = addClickTracking(finalHtml, trackingId, resolvedAppUrl);
    finalHtml = addUnsubscribeLink(finalHtml, trackingId, resolvedAppUrl);
  }

  // Use Brevo HTTP API if key is available (bypasses Railway's SMTP block)
  const brevoKey = process.env.BREVO_API_KEY;
  if (brevoKey) {
    return sendViaBrevoAPI({
      to, toName, subject,
      html: finalHtml,
      text: textBody || finalHtml.replace(/<[^>]*>/g, ''),
      fromName: resolvedFromName,
      fromEmail: resolvedFromEmail,
      replyTo,
    });
  }

  // SMTP fallback
  if (!transporter) createTransporter();
  if (!transporter) throw new Error('Email not configured. Add a Brevo API key or SMTP credentials in Settings.');

  return transporter.sendMail({
    from:    `"${resolvedFromName}" <${resolvedFromEmail}>`,
    to:      toName ? `"${toName}" <${to}>` : to,
    replyTo: replyTo || resolvedFromEmail,
    subject,
    html:    finalHtml,
    text:    textBody || finalHtml.replace(/<[^>]*>/g, ''),
  });
}

// ─── Bulk campaign sender ─────────────────────────────────────────────────────
async function sendBulkCampaign({ campaign, contacts, followupStep = 0, followupSequenceId = null }) {
  const { v4: uuidv4 } = require('uuid');
  const appUrl = process.env.APP_URL || 'http://localhost:3000';

  const batchSizeRow  = await queries.getSetting('batch_size');
  const batchDelayRow = await queries.getSetting('batch_delay_ms');
  const batchSize  = parseInt(batchSizeRow?.value  || '50');
  const batchDelay = parseInt(batchDelayRow?.value || '1000');

  let sentCount = 0, failedCount = 0;

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    const trackingId = uuidv4();

    let customFields = {};
    try { customFields = JSON.parse(contact.custom_fields || '{}'); } catch(e) {}

    const templateData = {
      name:    contact.name || contact.email.split('@')[0],
      email:   contact.email,
      company: contact.company || '',
      phone:   contact.phone   || '',
      ...customFields,
    };

    const personalizedHtml    = compileTemplate(campaign.body_html, templateData);
    const personalizedText    = compileTemplate(campaign.body_text, templateData);
    const personalizedSubject = compileTemplate(campaign.subject,   templateData);

    await queries.insertLog({
      campaign_id: campaign.id, contact_id: contact.id || null,
      followup_sequence_id: followupSequenceId, followup_step: followupStep,
      email: contact.email, name: contact.name, subject: personalizedSubject,
      tracking_id: trackingId, status: 'pending',
    });

    try {
      await sendEmail({
        to: contact.email, toName: contact.name,
        subject: personalizedSubject,
        htmlBody: personalizedHtml, textBody: personalizedText,
        fromName: campaign.from_name, fromEmail: campaign.from_email,
        replyTo: campaign.reply_to, trackingId, appUrl,
      });
      await queries.updateLogSent(trackingId);
      await queries.updateCampaignStats(campaign.id);
      sentCount++;
      console.log(`✅ Sent to ${contact.email} [${sentCount}/${contacts.length}]`);
    } catch (err) {
      await queries.updateLogFailed(err.message, trackingId);
      await queries.updateCampaignFailed(campaign.id);
      failedCount++;
      console.error(`❌ Failed: ${contact.email} — ${err.message}`);
    }

    if ((i + 1) % batchSize === 0 && i < contacts.length - 1) {
      console.log(`⏳ Batch delay ${batchDelay}ms…`);
      await new Promise(r => setTimeout(r, batchDelay));
    } else if (i < contacts.length - 1) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return { sentCount, failedCount };
}

module.exports = {
  createTransporter, createTransporterFromDB,
  verifyConnection, verifyBrevoAPIKey,
  sendEmail, sendBulkCampaign, compileTemplate, getSmtpConfig,
};
