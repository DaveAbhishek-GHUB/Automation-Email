const handlebars = require('handlebars');
const { queries, get } = require('./db');

const APP_URL = 'https://automation-email-u0b2.onrender.com';

// ─── Resend HTTP API ───────────────────────────────────────────────────────────
// Uses port 443 (HTTPS) — works on ALL cloud hosts including Render free tier
async function sendViaResend({ to, toName, subject, html, text, fromName, fromEmail, replyTo }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('Resend API key not configured. Go to Settings and add your Resend API key.');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:     `${fromName} <${fromEmail}>`,
      to:       [to],
      subject,
      html,
      text:     text || html.replace(/<[^>]*>/g, ''),
      reply_to: replyTo || fromEmail,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(`Resend error: ${err.message || JSON.stringify(err)}`);
  }
  return res.json();
}

// ─── Verify Resend API key ─────────────────────────────────────────────────────
async function verifyResendKey(apiKey) {
  const key = apiKey || process.env.RESEND_API_KEY;
  if (!key) return { success: false, message: '❌ No API key provided' };

  const res = await fetch('https://api.resend.com/domains', {
    headers: { 'Authorization': `Bearer ${key}` },
  });
  if (res.ok) return { success: true, message: '✅ Resend API key verified! Ready to send emails.' };
  const err = await res.json().catch(() => ({ message: 'Invalid key' }));
  return { success: false, message: `❌ ${err.message || 'Invalid Resend API key'}` };
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

// ─── Load Resend key from DB into env ─────────────────────────────────────────
async function loadResendKeyFromDB() {
  try {
    if (!process.env.RESEND_API_KEY) {
      const row = await get("SELECT value FROM settings WHERE key='resend_api_key'");
      if (row?.value) process.env.RESEND_API_KEY = row.value;
    }
  } catch(e) {}
}

// ─── Send a single email ───────────────────────────────────────────────────────
async function sendEmail({ to, toName, subject, htmlBody, textBody, fromName, fromEmail, replyTo, trackingId, appUrl }) {
  await loadResendKeyFromDB();

  // Resolve app URL
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
  const resolvedFromEmail = fromEmail || dbFromEmail || process.env.FROM_EMAIL  || 'info@varadatech.com';

  // Add tracking
  let finalHtml = htmlBody || '';
  if (trackingId) {
    finalHtml = addTrackingPixel(finalHtml, trackingId, resolvedAppUrl);
    finalHtml = addClickTracking(finalHtml, trackingId, resolvedAppUrl);
    finalHtml = addUnsubscribeLink(finalHtml, trackingId, resolvedAppUrl);
  }

  return sendViaResend({
    to, toName, subject,
    html: finalHtml,
    text: textBody,
    fromName:  resolvedFromName,
    fromEmail: resolvedFromEmail,
    replyTo,
  });
}

// ─── Bulk campaign sender ──────────────────────────────────────────────────────
async function sendBulkCampaign({ campaign, contacts, followupStep = 0, followupSequenceId = null }) {
  const { v4: uuidv4 } = require('uuid');
  await loadResendKeyFromDB();

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
    const contact   = contacts[i];
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

    if ((i + 1) % batchSize === 0 && i < contacts.length - 1) {
      console.log(`⏳ Batch delay ${batchDelay}ms…`);
      await new Promise(r => setTimeout(r, batchDelay));
    } else if (i < contacts.length - 1) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return { sentCount, failedCount };
}

module.exports = { sendEmail, sendBulkCampaign, compileTemplate, verifyResendKey, loadResendKeyFromDB };
