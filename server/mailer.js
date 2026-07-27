const nodemailer = require('nodemailer');
const handlebars = require('handlebars');
const { queries, run, get } = require('./db');

const APP_URL = process.env.APP_URL || 'https://automation-email-u0b2.onrender.com';

let transporter = null;

// ─── SMTP Config ───────────────────────────────────────────────────────
function getSmtpConfig() {
  const rawSecure = process.env.SMTP_SECURE || 'false';
  const rawPort   = process.env.SMTP_PORT   || '587';

  // 'smtp-secure' dropdown sends '2525' for port 2525 (not a boolean)
  // In that case: port = 2525, secure = false (plain/STARTTLS)
  let port, secure;
  if (rawSecure === '2525' || rawPort === '2525') {
    port   = 2525;
    secure = false;
  } else {
    port   = parseInt(rawPort);
    secure = rawSecure === 'true'; // true = SSL (465), false = STARTTLS (587)
  }

  return {
    host:   process.env.SMTP_HOST || 'smtp.titan.email',
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
    tls: { rejectUnauthorized: false },
    pool:              false,    // no pool — avoids connection hangs on cloud
    connectionTimeout: 12000,   // 12s to establish TCP connection
    greetingTimeout:   12000,   // 12s to receive SMTP greeting
    socketTimeout:     20000,   // 20s per socket operation
  };
}

function createTransporter() {
  const config = getSmtpConfig();
  if (!config.auth.user || !config.auth.pass) {
    console.warn('⚠️  SMTP credentials not configured — set SMTP_USER and SMTP_PASS in Render Environment Variables.');
    transporter = null;
    return null;
  }
  transporter = nodemailer.createTransport(config);
  console.log(`📧 SMTP transporter created: ${config.host}:${config.port}`);
  return transporter;
}

// Load SMTP settings from DB into process.env, then create transporter
async function createTransporterFromDB() {
  try {
    const keys = ['smtp_host','smtp_port','smtp_user','smtp_pass','smtp_secure','from_name','from_email'];
    for (const key of keys) {
      const row = await get(`SELECT value FROM settings WHERE key='${key}'`);
      if (row?.value) process.env[key.toUpperCase()] = row.value;
    }
  } catch(e) { /* DB not ready yet */ }
  return createTransporter();
}

// ─── Verify SMTP connection ──────────────────────────────────────────────
async function verifyConnection() {
  try {
    // Reload latest credentials from DB
    const keys = ['smtp_host','smtp_port','smtp_user','smtp_pass','smtp_secure'];
    for (const key of keys) {
      const row = await get(`SELECT value FROM settings WHERE key='${key}'`).catch(() => null);
      if (row?.value) process.env[key.toUpperCase()] = row.value;
    }

    const t = createTransporter();
    if (!t) return {
      success: false,
      message: '\u274c SMTP credentials missing. Enter Host, Port, Email, Password above and click Save SMTP Settings first.'
    };

    // Test with a 20s timeout — if it times out, the host/port is unreachable
    await Promise.race([
      t.verify(),
      new Promise((_, rej) => setTimeout(() =>
        rej(new Error(
          'SMTP timed out (20s). Possible causes:\n' +
          '1. Wrong password — double-check your Titan email password\n' +
          '2. Try Port 465 with SSL instead of 587\n' +
          '3. Your Render plan may block SMTP — try upgrading or contact Render support'
        )), 20000))
    ]);
    await queries.setSetting('smtp_configured', 'true');
    return { success: true, message: `\u2705 SMTP connected successfully via ${process.env.SMTP_HOST}:${process.env.SMTP_PORT}!` };
  } catch (err) {
    await queries.setSetting('smtp_configured', 'false').catch(() => {});
    return { success: false, message: `\u274c ${err.message}` };
  }
}

// ─── Template helpers ──────────────────────────────────────────────────────────
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

// ─── Send a single email via Titan SMTP ───────────────────────────────────────
async function sendEmail({ to, toName, subject, htmlBody, textBody, fromName, fromEmail, replyTo, trackingId, appUrl }) {
  // Resolve app URL from DB → env → Render default
  let resolvedAppUrl = appUrl || process.env.APP_URL || APP_URL;
  try {
    const s = await get("SELECT value FROM settings WHERE key='app_url'");
    if (s?.value) resolvedAppUrl = s.value;
  } catch(e) {}

  // Resolve sender identity
  let dbFromEmail = null, dbFromName = null;
  try {
    const fe = await get("SELECT value FROM settings WHERE key='from_email'");
    const fn = await get("SELECT value FROM settings WHERE key='from_name'");
    dbFromEmail = fe?.value || null;
    dbFromName  = fn?.value || null;
  } catch(e) {}
  const resolvedFromName  = fromName  || dbFromName  || process.env.FROM_NAME  || 'VaradaTech';
  const resolvedFromEmail = fromEmail || dbFromEmail || process.env.FROM_EMAIL || process.env.SMTP_USER || 'info@varadatech.com';

  // Add tracking
  let finalHtml = htmlBody || '';
  if (trackingId) {
    finalHtml = addTrackingPixel(finalHtml, trackingId, resolvedAppUrl);
    finalHtml = addClickTracking(finalHtml, trackingId, resolvedAppUrl);
    finalHtml = addUnsubscribeLink(finalHtml, trackingId, resolvedAppUrl);
  }

  // Always create a FRESH transporter for every individual send
  // (reusing stale connections causes "Unexpected socket close" from GoDaddy)
  const freshTransporter = nodemailer.createTransport(getSmtpConfig());
  if (!freshTransporter) throw new Error('SMTP not configured. Enter credentials in Settings → SMTP section → Save SMTP Settings.');

  const mailOptions = {
    from:    `"${resolvedFromName}" <${resolvedFromEmail}>`,
    to:      toName ? `"${toName}" <${to}>` : to,
    replyTo: replyTo || resolvedFromEmail,
    subject,
    html:    finalHtml,
    text:    textBody || finalHtml.replace(/<[^>]*>/g, ''),
    headers: { 'X-Priority': '3', 'X-Mailer': 'TitanMail-1.0' },
  };

  return Promise.race([
    freshTransporter.sendMail(mailOptions),
    new Promise((_, rej) => setTimeout(() =>
      rej(new Error('Email send timed out (30s). SMTP may be unreachable.')), 30000))
  ]);
}

// ─── Bulk campaign sender ──────────────────────────────────────────────────────
async function sendBulkCampaign({ campaign, contacts, followupStep = 0, followupSequenceId = null }) {
  const { v4: uuidv4 } = require('uuid');

  // Always use the DB/env app URL for tracking links
  let resolvedAppUrl = process.env.APP_URL || APP_URL;
  try {
    const s = await get("SELECT value FROM settings WHERE key='app_url'");
    if (s?.value) resolvedAppUrl = s.value;
  } catch(e) {}

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
        replyTo: campaign.reply_to, trackingId, appUrl: resolvedAppUrl,
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

    // Batch delay to avoid SMTP rate limiting
    if ((i + 1) % batchSize === 0 && i < contacts.length - 1) {
      console.log(`⏳ Batch delay ${batchDelay}ms…`);
      await new Promise(r => setTimeout(r, batchDelay));
    } else if (i < contacts.length - 1) {
      await new Promise(r => setTimeout(r, 300)); // 300ms between each email
    }
  }

  return { sentCount, failedCount };
}

module.exports = {
  createTransporter, createTransporterFromDB,
  verifyConnection,
  sendEmail, sendBulkCampaign, compileTemplate, getSmtpConfig,
};
