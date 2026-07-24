require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { initializeDatabase, queries, run, get, all } = require('./db');
const { initializeScheduler } = require('./scheduler');
const { createTransporter, createTransporterFromDB, verifyConnection } = require('./mailer');


const app = express();
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
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/analytics', require('./routes/analytics'));

// ─── Tracking ────────────────────────────────────────────────────────────────

// Open Pixel
app.get('/track/open/:trackingId', async (req, res) => {
  try {
    await queries.updateLogOpened(req.params.trackingId);
    const log = await queries.getLogByTracking(req.params.trackingId);
    if (log?.campaign_id) {
      await run("UPDATE campaigns SET open_count=open_count+1,updated_at=CURRENT_TIMESTAMP WHERE id=?", [log.campaign_id]);
    }
  } catch (e) { /* silent */ }
  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.set({ 'Content-Type': 'image/gif', 'Content-Length': pixel.length, 'Cache-Control': 'no-cache' });
  res.end(pixel);
});

// Click Redirect — also marks as "opened" (fixes Gmail where image tracking is blocked)
app.get('/track/click/:trackingId', async (req, res) => {
  const { trackingId } = req.params;
  const { url } = req.query;
  try {
    // Get log BEFORE updating so we know if it was already opened
    const logBefore = await queries.getLogByTracking(trackingId);
    const wasAlreadyOpened = !!logBefore?.opened_at;

    // Click = implicit open (works in Gmail where images are blocked)
    await queries.updateLogOpened(trackingId);
    await queries.updateLogClicked(trackingId);
    await run('INSERT INTO click_logs (tracking_id,url) VALUES (?,?)', [trackingId, url]);

    if (logBefore?.campaign_id) {
      // Increment click count always
      // Increment open count only if this is the FIRST open (avoids double-counting)
      if (!wasAlreadyOpened) {
        await run(
          "UPDATE campaigns SET click_count=click_count+1, open_count=open_count+1, updated_at=CURRENT_TIMESTAMP WHERE id=?",
          [logBefore.campaign_id]
        );
      } else {
        await run(
          "UPDATE campaigns SET click_count=click_count+1, updated_at=CURRENT_TIMESTAMP WHERE id=?",
          [logBefore.campaign_id]
        );
      }
    }
  } catch (e) { /* silent */ }
  if (url) res.redirect(decodeURIComponent(url)); else res.redirect('/');
});

// View in Browser — renders email HTML so Gmail users can view it
// (open tracking already happened via the click tracker before reaching here)
app.get('/view/:trackingId', async (req, res) => {
  try {
    const log = await queries.getLogByTracking(req.params.trackingId);
    if (log?.campaign_id) {
      const campaign = await queries.getCampaignById(log.campaign_id);
      if (campaign?.body_html) return res.send(campaign.body_html);
    }
  } catch (e) { }
  res.send('<html><body style="font-family:Arial,sans-serif;padding:32px;color:#64748b;text-align:center"><h2 style="color:#2563eb">TitanMail</h2><p>This preview link has expired or the email was not found.</p></body></html>');
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

// POST /api/settings/smtp
app.post('/api/settings/smtp', async (req, res) => {
  try {
    const { host, port, user, pass, secure, fromName } = req.body;
    const map = { smtp_host: host, smtp_port: port, smtp_user: user, smtp_secure: secure, from_name: fromName };
    if (pass) map.smtp_pass = pass;
    for (const [key, val] of Object.entries(map)) {
      if (val !== undefined) await queries.setSetting(key, String(val));
    }
    if (host) process.env.SMTP_HOST = host;
    if (port) process.env.SMTP_PORT = port;
    if (user) process.env.SMTP_USER = user;
    if (pass) process.env.SMTP_PASS = pass;
    if (secure !== undefined) process.env.SMTP_SECURE = String(secure);
    if (fromName) process.env.FROM_NAME = fromName;
    createTransporter();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/settings/test-smtp
app.post('/api/settings/test-smtp', async (req, res) => {
  try {
    const result = await verifyConnection();
    res.json({ success: result.success, message: result.message || 'Connection successful!' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/settings/sending
app.post('/api/settings/sending', async (req, res) => {
  try {
    const { batchSize, batchDelayMs } = req.body;
    if (batchSize) await queries.setSetting('batch_size', String(batchSize));
    if (batchDelayMs) await queries.setSetting('batch_delay_ms', String(batchDelayMs));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/settings/app-url — save public URL for Gmail open tracking
app.post('/api/settings/app-url', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    await queries.setSetting('app_url', url.trim().replace(/\/$/, ''));
    res.json({ success: true, message: 'App URL saved' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/settings/brevo — save Brevo API key
app.post('/api/settings/brevo', async (req, res) => {
  try {
    const { apiKey, fromEmail } = req.body;
    if (!apiKey) return res.status(400).json({ error: 'apiKey required' });
    await queries.setSetting('brevo_api_key', apiKey.trim());
    if (fromEmail) {
      await queries.setSetting('from_email', fromEmail.trim());
      process.env.FROM_EMAIL = fromEmail.trim();
    }
    process.env.BREVO_API_KEY = apiKey.trim();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/settings/test-brevo — verify Brevo API key via HTTPS (works on Railway)
app.post('/api/settings/test-brevo', async (req, res) => {
  try {
    const { verifyBrevoAPIKey } = require('./mailer');
    const result = await verifyBrevoAPIKey();
    res.json({ success: result.success, message: result.message });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});


// ─── Frontend Routes ──────────────────────────────────────────────────────────
const pages = ['contacts', 'campaigns', 'followups', 'analytics', 'settings'];
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
pages.forEach(p => app.get(`/${p}`, (req, res) => res.sendFile(path.join(__dirname, `../public/${p}.html`))));

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  await initializeDatabase();

  // Auto-recover: fix campaigns stuck in 'running' from a previous crash
  const stuck = await all("SELECT id, name FROM campaigns WHERE status='running'");
  if (stuck.length > 0) {
    for (const c of stuck) {
      await run("UPDATE campaigns SET status='completed', completed_at=CURRENT_TIMESTAMP WHERE id=?", [c.id]);
      console.log(`⚠️  Auto-recovered stuck campaign: "${c.name}"`);
    }
  }

  await createTransporterFromDB(); // loads SMTP from DB → survives Railway restarts

  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════╗
║    📧  TitanMail Marketing Tool — Running!           ║
║    🌐  http://localhost:${PORT}                      ║
║    ⚙️   Configure SMTP at /settings first            ║
╚══════════════════════════════════════════════════════╝
    `);
    initializeScheduler();
  });
}

start().catch(err => { console.error('Startup error:', err); process.exit(1); });

module.exports = app;
