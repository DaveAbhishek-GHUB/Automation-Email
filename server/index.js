require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { initializeDatabase, queries, run, get, all } = require('./db');
const { initializeScheduler } = require('./scheduler');
const { sendEmail, verifyResendKey, loadResendKeyFromDB } = require('./mailer');

const app  = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// Uploads directory
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// API Routes
app.use('/api/contacts',  require('./routes/contacts'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/analytics', require('./routes/analytics'));

// ─── Tracking ─────────────────────────────────────────────────────────────────

// Open Pixel — bot-filtered to prevent false opens from Gmail proxy, Outlook SafeLink etc.
app.get('/track/open/:trackingId', async (req, res) => {
  const ua    = req.headers['user-agent'] || '';
  const isBot = /googleimageproxy|yahoo.*mail|outlook.*link|preview|bot|crawl|spider|facebookexternalhit/i.test(ua);

  if (!isBot) {
    try {
      await queries.updateLogOpened(req.params.trackingId);
      const log = await queries.getLogByTracking(req.params.trackingId);
      if (log?.campaign_id) {
        await run("UPDATE campaigns SET open_count=open_count+1,updated_at=CURRENT_TIMESTAMP WHERE id=?", [log.campaign_id]);
      }
    } catch (e) { /* silent */ }
  }
  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.set({ 'Content-Type': 'image/gif', 'Content-Length': pixel.length, 'Cache-Control': 'no-store, no-cache' });
  res.end(pixel);
});

// Click Redirect — also marks as opened (fixes Gmail where image tracking is blocked)
app.get('/track/click/:trackingId', async (req, res) => {
  const { trackingId } = req.params;
  const { url } = req.query;
  try {
    const logBefore       = await queries.getLogByTracking(trackingId);
    const wasAlreadyOpened = !!logBefore?.opened_at;
    await queries.updateLogOpened(trackingId);
    await queries.updateLogClicked(trackingId);
    await run('INSERT INTO click_logs (tracking_id,url) VALUES (?,?)', [trackingId, url]);
    if (logBefore?.campaign_id) {
      if (!wasAlreadyOpened) {
        await run("UPDATE campaigns SET click_count=click_count+1, open_count=open_count+1, updated_at=CURRENT_TIMESTAMP WHERE id=?", [logBefore.campaign_id]);
      } else {
        await run("UPDATE campaigns SET click_count=click_count+1, updated_at=CURRENT_TIMESTAMP WHERE id=?", [logBefore.campaign_id]);
      }
    }
  } catch (e) { /* silent */ }
  if (url) res.redirect(decodeURIComponent(url)); else res.redirect('/');
});

// View in Browser
app.get('/view/:trackingId', async (req, res) => {
  try {
    const log = await queries.getLogByTracking(req.params.trackingId);
    if (log?.campaign_id) {
      const campaign = await queries.getCampaignById(log.campaign_id);
      if (campaign?.body_html) return res.send(campaign.body_html);
    }
  } catch (e) { }
  res.send('<html><body style="font-family:Arial,sans-serif;padding:32px;color:#64748b;text-align:center"><h2 style="color:#2563eb">TitanMail</h2><p>This preview link has expired.</p></body></html>');
});

// Unsubscribe
app.get('/unsubscribe/:trackingId', async (req, res) => {
  try {
    const log = await queries.getLogByTracking(req.params.trackingId);
    if (log) {
      await queries.updateContactStatus('unsubscribed', log.email);
      await run("UPDATE contacts SET unsubscribed_at=CURRENT_TIMESTAMP WHERE email=?", [log.email]);
    }
  } catch (e) { /* silent */ }
  res.send(`
    <!DOCTYPE html><html><head><title>Unsubscribed</title>
    <style>body{font-family:Arial,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f172a;color:#e2e8f0;}
    .card{text-align:center;padding:48px;background:#1e293b;border-radius:16px;border:1px solid #334155;}
    h2{color:#10b981;margin-bottom:12px;} p{color:#94a3b8;}</style></head>
    <body><div class="card"><h2>✅ Unsubscribed Successfully</h2>
    <p>You've been removed from our mailing list.</p></div></body></html>
  `);
});

// ─── Settings API ─────────────────────────────────────────────────────────────

// POST /api/settings/resend — save Resend API key
app.post('/api/settings/resend', async (req, res) => {
  try {
    const { apiKey, fromEmail, fromName } = req.body;
    if (!apiKey) return res.status(400).json({ error: 'apiKey required' });
    await queries.setSetting('resend_api_key', apiKey.trim());
    if (fromEmail) { await queries.setSetting('from_email', fromEmail.trim()); process.env.FROM_EMAIL = fromEmail.trim(); }
    if (fromName)  { await queries.setSetting('from_name',  fromName.trim());  process.env.FROM_NAME  = fromName.trim(); }
    process.env.RESEND_API_KEY = apiKey.trim();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/settings/test-resend — verify Resend API key
app.post('/api/settings/test-resend', async (req, res) => {
  try {
    const { apiKey } = req.body;
    if (apiKey) process.env.RESEND_API_KEY = apiKey.trim();
    else await loadResendKeyFromDB();
    const result = await verifyResendKey();
    res.json({ success: result.success, message: result.message });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/settings/sending — batch size and delay
app.post('/api/settings/sending', async (req, res) => {
  try {
    const { batchSize, batchDelayMs } = req.body;
    if (batchSize)    await queries.setSetting('batch_size',     String(batchSize));
    if (batchDelayMs) await queries.setSetting('batch_delay_ms', String(batchDelayMs));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/settings/app-url — save public URL for open/click tracking
app.post('/api/settings/app-url', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    await queries.setSetting('app_url', url.trim().replace(/\/$/, ''));
    process.env.APP_URL = url.trim().replace(/\/$/, '');
    res.json({ success: true, message: 'App URL saved' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/settings/status — check what's configured
app.get('/api/settings/status', async (req, res) => {
  await loadResendKeyFromDB();
  const hasResend = !!process.env.RESEND_API_KEY;
  res.json({ hasResend, method: hasResend ? 'resend' : 'none' });
});

// GET /api/settings — return all settings (for the settings page to load)
app.get('/api/settings', async (req, res) => {
  try {
    const rows = await all("SELECT key, value FROM settings");
    const s = {};
    rows.forEach(r => { s[r.key] = r.value; });
    // Mask the API key — only show first 8 chars
    if (s.resend_api_key && s.resend_api_key.length > 8) {
      s.resend_api_key_preview = s.resend_api_key.substring(0, 8) + '••••••••';
      s.resend_api_key = ''; // don't send full key to browser
    }
    res.json({ settings: s });
  } catch (e) { res.json({ settings: {} }); }
});

// POST /api/settings/send-test — send a real test email
app.post('/api/settings/send-test', async (req, res) => {
  try {
    const { to, from_email, from_name } = req.body;
    if (!to) return res.status(400).json({ success: false, message: 'to email required' });
    await loadResendKeyFromDB();
    await sendEmail({
      to,
      toName:    'Test Recipient',
      subject:   '✅ TitanMail is Working!',
      htmlBody: `<div style="font-family:Arial,sans-serif;padding:32px;background:#f8fafc;border-radius:12px">
        <h2 style="color:#10b981;margin-bottom:8px">✅ TitanMail is Working!</h2>
        <p>This test email was sent at <strong>${new Date().toLocaleString()}</strong> via <strong>Resend API</strong>.</p>
        <p>Your email marketing tool is fully operational on Render 🚀</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"/>
        <p style="color:#9ca3af;font-size:12px">Sent from TitanMail — automation-email-u0b2.onrender.com</p>
      </div>`,
      fromName:  from_name  || process.env.FROM_NAME  || 'VaradaTech',
      fromEmail: from_email || process.env.FROM_EMAIL || 'info@varadatech.com',
    });
    res.json({ success: true, message: `✅ Test email sent to ${to} via Resend! Check your inbox.` });
  } catch (e) {
    res.json({ success: false, message: `❌ ${e.message}` });
  }
});

// GET /api/settings/failed-logs
app.get('/api/settings/failed-logs', async (req, res) => {
  try {
    const logs = await all(`SELECT email, subject, error_message, sent_at FROM email_logs WHERE status='failed' ORDER BY id DESC LIMIT 10`);
    res.json({ logs });
  } catch (e) { res.json({ logs: [] }); }
});

// ─── Frontend Routes ───────────────────────────────────────────────────────────
const pages = ['contacts', 'campaigns', 'followups', 'analytics', 'settings'];
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
pages.forEach(p => app.get(`/${p}`, (req, res) => res.sendFile(path.join(__dirname, `../public/${p}.html`))));

// ─── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  await initializeDatabase();

  // Auto-recover: fix campaigns stuck in 'running' from a previous crash
  const stuck = await all("SELECT id, name FROM campaigns WHERE status='running'");
  for (const c of stuck) {
    await run("UPDATE campaigns SET status='completed', completed_at=CURRENT_TIMESTAMP WHERE id=?", [c.id]);
    console.log(`⚠️  Auto-recovered stuck campaign: "${c.name}"`);
  }

  // ── Auto-seed settings from env vars (runs every startup) ─────────────────
  const autoSeed = [
    ['app_url',        process.env.APP_URL        || 'https://automation-email-u0b2.onrender.com'],
    ['from_email',     process.env.FROM_EMAIL      || 'info@varadatech.com'],
    ['from_name',      process.env.FROM_NAME       || 'VaradaTech'],
    ['resend_api_key', process.env.RESEND_API_KEY  ],
  ];
  for (const [key, val] of autoSeed) {
    if (val) await queries.setSetting(key, val);
  }

  await loadResendKeyFromDB();
  if (process.env.RESEND_API_KEY) console.log('📧 Resend API key loaded ✅');
  else console.warn('⚠️  RESEND_API_KEY not set — add it in Render Environment Variables');
  if (process.env.APP_URL) console.log(`🌐 App URL: ${process.env.APP_URL}`);

  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════╗
║    📧  TitanMail Marketing Tool — Running!           ║
║    🌐  http://localhost:${PORT}                      ║
║    🔑  Add RESEND_API_KEY in Render env vars         ║
╚══════════════════════════════════════════════════════╝
    `);
    initializeScheduler();
  });
}

start().catch(err => { console.error('Startup error:', err); process.exit(1); });

module.exports = app;
