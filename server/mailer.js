const nodemailer = require('nodemailer');
const handlebars = require('handlebars');
const { queries, run, get, all } = require('./db');

let transporter = null;

function getSmtpConfig() {
  return {
    host: process.env.SMTP_HOST || 'smtp.titan.email',
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: (process.env.SMTP_SECURE || 'true') === 'true',
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
    console.warn('⚠️  SMTP credentials not configured. Please set up in Settings.');
    transporter = null;
    return null;
  }
  transporter = nodemailer.createTransport(config);
  return transporter;
}

async function verifyConnection() {
  try {
    const t = createTransporter();
    if (!t) return { success: false, message: 'SMTP credentials not configured' };
    await t.verify();
    await queries.setSetting('smtp_configured', 'true');
    return { success: true, message: 'TitanMail SMTP connection verified ✅' };
  } catch (err) {
    await queries.setSetting('smtp_configured', 'false');
    return { success: false, message: err.message };
  }
}

function compileTemplate(htmlTemplate, data) {
  try {
    return handlebars.compile(htmlTemplate || '')(data);
  } catch (e) { return htmlTemplate || ''; }
}

function addViewInBrowserLink(html, trackingId, appUrl) {
  // This link goes through click tracker → counts as opened when clicked in Gmail
  const viewUrl = `${appUrl}/track/click/${trackingId}?url=${encodeURIComponent(appUrl + '/view/' + trackingId)}`;
  const banner = `<div style="text-align:center;padding:8px;background:#f8faff;font-family:Arial,sans-serif;font-size:11px;color:#64748b;border-bottom:1px solid #e2e8f0;">Having trouble viewing this email? <a href="${viewUrl}" style="color:#2563eb;">View in browser</a></div>`;
  return html.includes('<body') ? html.replace(/<body([^>]*)>/i, `<body$1>${banner}`) : banner + html;
}

function addUnsubscribeLink(html, trackingId, appUrl) {
  // Route unsubscribe through click tracker first so Gmail opens are detected
  const unsubUrl    = `${appUrl}/unsubscribe/${trackingId}`;
  const trackedUrl  = `${appUrl}/track/click/${trackingId}?url=${encodeURIComponent(unsubUrl)}`;
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

async function sendEmail({ to, toName, subject, htmlBody, textBody, fromName, fromEmail, replyTo, trackingId, appUrl }) {
  if (!transporter) createTransporter();
  if (!transporter) throw new Error('SMTP not configured. Please go to Settings.');

  // Read app_url from DB settings (so Gmail recipients can click tracking links)
  let dbAppUrl = null;
  try {
    const setting = await get("SELECT value FROM settings WHERE key='app_url'");
    dbAppUrl = setting?.value || null;
  } catch(e) {}
  const resolvedAppUrl = dbAppUrl || appUrl || process.env.APP_URL || 'http://localhost:3000';
  const resolvedFromName = fromName || process.env.FROM_NAME || 'Email Marketing';
  const resolvedFromEmail = fromEmail || process.env.FROM_EMAIL || process.env.SMTP_USER;

  let finalHtml = htmlBody || '';
  if (trackingId) {
    finalHtml = addTrackingPixel(finalHtml, trackingId, resolvedAppUrl);
    finalHtml = addClickTracking(finalHtml, trackingId, resolvedAppUrl);
    finalHtml = addUnsubscribeLink(finalHtml, trackingId, resolvedAppUrl);
  }

  return transporter.sendMail({
    from: `"${resolvedFromName}" <${resolvedFromEmail}>`,
    to: toName ? `"${toName}" <${to}>` : to,
    replyTo: replyTo || resolvedFromEmail,
    subject,
    html: finalHtml,
    text: textBody || finalHtml.replace(/<[^>]*>/g, ''),
  });
}

async function sendBulkCampaign({ campaign, contacts, followupStep = 0, followupSequenceId = null }) {
  const { v4: uuidv4 } = require('uuid');
  const appUrl = process.env.APP_URL || 'http://localhost:3000';

  const batchSizeRow = await queries.getSetting('batch_size');
  const batchDelayRow = await queries.getSetting('batch_delay_ms');
  const batchSize = parseInt(batchSizeRow?.value || '50');
  const batchDelay = parseInt(batchDelayRow?.value || '1000');

  let sentCount = 0, failedCount = 0;

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    const trackingId = uuidv4();

    let customFields = {};
    try { customFields = JSON.parse(contact.custom_fields || '{}'); } catch(e) {}

    const templateData = {
      name: contact.name || contact.email.split('@')[0],
      email: contact.email,
      company: contact.company || '',
      phone: contact.phone || '',
      ...customFields,
    };

    const personalizedHtml = compileTemplate(campaign.body_html, templateData);
    const personalizedText = compileTemplate(campaign.body_text, templateData);
    const personalizedSubject = compileTemplate(campaign.subject, templateData);

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

module.exports = { createTransporter, verifyConnection, sendEmail, sendBulkCampaign, compileTemplate, getSmtpConfig };
