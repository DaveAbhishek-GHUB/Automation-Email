const express = require('express');
const { queries, run, get, all } = require('../db');

const router = express.Router();

// GET /api/campaigns
router.get('/', async (req, res) => {
  try { res.json({ campaigns: await queries.getAllCampaigns() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/campaigns/:id
router.get('/:id', async (req, res) => {
  try {
    const campaign = await queries.getCampaignById(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const followups = await queries.getFollowupsByCampaign(campaign.id);
    const logs = await all('SELECT * FROM email_logs WHERE campaign_id=? ORDER BY sent_at DESC LIMIT 100', [campaign.id]);
    res.json({ campaign, followups, logs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/campaigns/:id/logs — filtered logs (for date lookup in followups page)
router.get('/:id/logs', async (req, res) => {
  try {
    const { step, limit = 1, order = 'ASC' } = req.query;
    const stepClause = (step !== undefined) ? `AND followup_step=${parseInt(step)}` : '';
    const logs = await all(
      `SELECT * FROM email_logs WHERE campaign_id=? ${stepClause}
       AND status IN ('sent','opened','clicked')
       ORDER BY sent_at ${order === 'DESC' ? 'DESC' : 'ASC'} LIMIT ?`,
      [req.params.id, parseInt(limit)]
    );
    res.json({ logs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/campaigns
router.post('/', async (req, res) => {
  try {
    const { name, subject, body_html, body_text, from_name, from_email, reply_to,
      send_mode = 'once', scheduled_at, daily_time, list_ids = [], contact_ids = [], followups = [] } = req.body;

    if (!name || !subject || !body_html) return res.status(400).json({ error: 'name, subject, and body_html are required' });

    const result = await queries.insertCampaign({
      name, subject, body_html, body_text: body_text || '',
      from_name: from_name || process.env.FROM_NAME || 'Email Marketing',
      from_email: from_email || process.env.FROM_EMAIL || process.env.SMTP_USER || '',
      reply_to: reply_to || from_email || process.env.SMTP_USER || '',
      send_mode: send_mode || 'sequence',
      scheduled_at: scheduled_at || null,
      daily_time: null,
      list_ids: JSON.stringify(list_ids),
      contact_ids: JSON.stringify(contact_ids),
    });
    const campaignId = result.lastID;

    // Save follow-up steps
    for (const fu of followups) {
      await queries.insertFollowup({
        campaign_id: campaignId,
        step_number: fu.step_number,
        delay_days: Math.max(1, parseInt(fu.delay_days) || 1),
        subject: fu.subject,
        body_html: fu.body_html || '',
        body_text: fu.body_text || '',
      });
    }

    // If scheduled for later, mark as scheduled
    if (scheduled_at) {
      await queries.updateCampaignStatus('scheduled', campaignId);
    }
    // Otherwise stays as 'draft' until /send is called

    const campaign = await queries.getCampaignById(campaignId);
    res.json({ success: true, campaign });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/campaigns/:id
router.put('/:id', async (req, res) => {
  try {
    const campaign = await queries.getCampaignById(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.status === 'running') return res.status(400).json({ error: 'Cannot edit a running campaign' });

    const { name, subject, body_html, body_text, from_name, from_email, reply_to,
      send_mode, scheduled_at, daily_time, list_ids, contact_ids, followups } = req.body;

    await run(`UPDATE campaigns SET
      name=COALESCE(?,name), subject=COALESCE(?,subject), body_html=COALESCE(?,body_html),
      body_text=COALESCE(?,body_text), from_name=COALESCE(?,from_name), from_email=COALESCE(?,from_email),
      reply_to=COALESCE(?,reply_to), send_mode=COALESCE(?,send_mode),
      scheduled_at=COALESCE(?,scheduled_at), daily_time=COALESCE(?,daily_time),
      list_ids=COALESCE(?,list_ids), contact_ids=COALESCE(?,contact_ids),
      updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [name, subject, body_html, body_text, from_name, from_email, reply_to, send_mode, scheduled_at, daily_time,
       list_ids ? JSON.stringify(list_ids) : null, contact_ids ? JSON.stringify(contact_ids) : null, req.params.id]);

    if (followups) {
      await queries.deleteFollowupsByCampaign(req.params.id);
      for (const fu of followups) {
        await queries.insertFollowup({ campaign_id: req.params.id, step_number: fu.step_number, delay_days: fu.delay_days, subject: fu.subject, body_html: fu.body_html || '', body_text: fu.body_text || '' });
      }
    }

    const updated = await queries.getCampaignById(req.params.id);
    res.json({ success: true, campaign: updated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/campaigns/:id/send — trigger initial blast immediately
router.post('/:id/send', async (req, res) => {
  try {
    const { triggerCampaignNow } = require('../scheduler');
    await triggerCampaignNow(parseInt(req.params.id));
    res.json({ success: true, message: 'Campaign launched — follow-ups will send automatically' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/campaigns/:id/resend — reset and re-trigger (retry campaigns that failed or sent 0)
router.post('/:id/resend', async (req, res) => {
  try {
    const { triggerCampaignNow } = require('../scheduler');
    // Reset status to draft so triggerCampaignNow can pick it up
    await queries.updateCampaignStatus('draft', req.params.id);
    await triggerCampaignNow(parseInt(req.params.id));
    res.json({ success: true, message: 'Campaign re-triggered successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/campaigns/:id/pause
router.post('/:id/pause', async (req, res) => {
  try { await queries.updateCampaignStatus('paused', req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/campaigns/:id/resume
router.post('/:id/resume', async (req, res) => {
  try { await queries.updateCampaignStatus('scheduled', req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/campaigns/:id/schedule
router.post('/:id/schedule', async (req, res) => {
  try {
    const { scheduled_at, send_mode, daily_time } = req.body;
    await run(`UPDATE campaigns SET scheduled_at=?,send_mode=COALESCE(?,send_mode),daily_time=COALESCE(?,daily_time),status='scheduled',updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [scheduled_at, send_mode, daily_time, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/campaigns/:id
router.delete('/:id', async (req, res) => {
  try {
    const campaign = await queries.getCampaignById(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.status === 'running') return res.status(400).json({ error: 'Cannot delete running campaign' });
    await queries.deleteCampaign(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/campaigns/:id/logs
router.get('/:id/logs', async (req, res) => {
  try { res.json({ logs: await queries.getLogsByCampaign(req.params.id) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
