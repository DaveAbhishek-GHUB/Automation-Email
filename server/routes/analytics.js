const express = require('express');
const { queries, run, get, all } = require('../db');
const { verifyConnection } = require('../mailer');

const router = express.Router();

// GET /api/analytics/overview
router.get('/overview', async (req, res) => {
  try {
    const stats = await queries.getOverallStats();
    const total = await get("SELECT COUNT(*) as count FROM contacts");
    const active = await get("SELECT COUNT(*) as count FROM contacts WHERE status='active'");
    const unsubscribed = await get("SELECT COUNT(*) as count FROM contacts WHERE status='unsubscribed'");
    const totalCamp = await get("SELECT COUNT(*) as count FROM campaigns");
    const activeCamp = await get("SELECT COUNT(*) as count FROM campaigns WHERE status IN ('scheduled','running')");
    const completedCamp = await get("SELECT COUNT(*) as count FROM campaigns WHERE status='completed'");

    const openRate = stats.total_sent > 0 ? ((stats.total_opened / stats.total_sent) * 100).toFixed(1) : 0;
    const clickRate = stats.total_sent > 0 ? ((stats.total_clicked / stats.total_sent) * 100).toFixed(1) : 0;

    res.json({
      stats,
      contactStats: { total: total.count, active: active.count, unsubscribed: unsubscribed.count },
      campaignCount: { total: totalCamp.count, active: activeCamp.count, completed: completedCamp.count },
      openRate, clickRate,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/analytics/daily
router.get('/daily', async (req, res) => {
  try { res.json({ data: await queries.getDailyStats() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/analytics/campaigns
router.get('/campaigns', async (req, res) => {
  try { res.json({ data: await queries.getCampaignStats() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/analytics/recent-activity
router.get('/recent-activity', async (req, res) => {
  try {
    const recent = await all(`
      SELECT el.*, c.name as campaign_name FROM email_logs el
      LEFT JOIN campaigns c ON el.campaign_id=c.id
      ORDER BY COALESCE(el.sent_at, el.rowid) DESC LIMIT 20
    `);
    res.json({ recent });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/analytics/settings
router.get('/settings', async (req, res) => {
  try {
    const rows = await queries.getAllSettings();
    const settings = {};
    for (const row of rows) settings[row.key] = row.value;
    delete settings.smtp_pass;
    delete settings.imap_pass;
    res.json({ settings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/analytics/settings
router.post('/settings', async (req, res) => {
  try {
    const { settings } = req.body;
    if (!settings) return res.status(400).json({ error: 'settings object required' });
    for (const [key, value] of Object.entries(settings)) {
      await queries.setSetting(key, String(value));
      if (key === 'smtp_host') process.env.SMTP_HOST = value;
      if (key === 'smtp_port') process.env.SMTP_PORT = value;
      if (key === 'smtp_user') process.env.SMTP_USER = value;
      if (key === 'smtp_pass') process.env.SMTP_PASS = value;
      if (key === 'smtp_secure') process.env.SMTP_SECURE = value;
      if (key === 'from_name') process.env.FROM_NAME = value;
      if (key === 'from_email') process.env.FROM_EMAIL = value;
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/analytics/settings/test-smtp
router.post('/settings/test-smtp', async (req, res) => {
  try {
    if (req.body) {
      const { smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure } = req.body;
      if (smtp_host) process.env.SMTP_HOST = smtp_host;
      if (smtp_port) process.env.SMTP_PORT = smtp_port;
      if (smtp_user) process.env.SMTP_USER = smtp_user;
      if (smtp_pass) process.env.SMTP_PASS = smtp_pass;
      if (smtp_secure !== undefined) process.env.SMTP_SECURE = String(smtp_secure);
    }
    const result = await verifyConnection();
    res.json(result);
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
