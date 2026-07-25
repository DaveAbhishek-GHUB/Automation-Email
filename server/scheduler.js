const cron = require('node-cron');
const { queries, all, get, run } = require('./db');
const { sendBulkCampaign } = require('./mailer');

// ─── Helper: get all contacts for a campaign ──────────────────
async function getContactsForCampaign(campaign) {
  const listIds  = JSON.parse(campaign.list_ids  || '[]');
  const contactIds = JSON.parse(campaign.contact_ids || '[]');
  let contacts = [];

  if (listIds.length > 0) {
    for (const listId of listIds) {
      const lc = await queries.getListContacts(listId);
      contacts.push(...lc);
    }
  }
  if (contactIds.length > 0) {
    const ph = contactIds.map(() => '?').join(',');
    const idContacts = await all(
      `SELECT * FROM contacts WHERE id IN (${ph}) AND status='active'`, contactIds);
    contacts.push(...idContacts);
  }
  if (listIds.length === 0 && contactIds.length === 0) {
    contacts = await queries.getActiveContacts();
  }

  const seen = new Set();
  return contacts.filter(c => { if (seen.has(c.email)) return false; seen.add(c.email); return true; });
}

// ─── Execute the initial (step-0) email blast ─────────────────
async function executeCampaign(campaign) {
  console.log(`\n📧 Executing campaign: "${campaign.name}" (ID: ${campaign.id})`);
  await queries.updateCampaignStatus('running', campaign.id);

  const contacts = await getContactsForCampaign(campaign);
  if (!contacts.length) {
    console.warn(`⚠️  Campaign "${campaign.name}" (ID:${campaign.id}) has NO CONTACTS — nothing to send.`);
    console.warn(`   Fix: Add contacts on the Contacts page, then launch the campaign again.`);
    await queries.updateCampaignStatus('draft', campaign.id); // reset to draft so user can re-launch
    return;
  }

  console.log(`📋 ${contacts.length} contacts to send to`);
  try {
    const result = await sendBulkCampaign({ campaign, contacts, followupStep: 0 });
    console.log(`✅ Campaign "${campaign.name}": ${result.sentCount} sent, ${result.failedCount} failed`);

    // Mark as 'sequence_active' so follow-ups keep running
    const hasFollowups = await get(
      `SELECT id FROM followup_sequences WHERE campaign_id=? AND status='active' LIMIT 1`,
      [campaign.id]
    );
    if (hasFollowups) {
      await queries.updateCampaignStatus('sequence_active', campaign.id);
      console.log(`🔄 Follow-up sequence armed for "${campaign.name}"`);
    } else {
      await queries.updateCampaignStatus('completed', campaign.id);
      await run('UPDATE campaigns SET completed_at=CURRENT_TIMESTAMP WHERE id=?', [campaign.id]);
    }
  } catch (err) {
    console.error(`❌ Campaign error:`, err.message);
    await queries.updateCampaignStatus('failed', campaign.id);
  }
}

// ─── Process follow-up sequences (runs every hour) ───────────
async function processFollowups() {
  const campaigns = await all(
    `SELECT * FROM campaigns WHERE status IN ('sequence_active','completed')`
  );

  for (const campaign of campaigns) {
    const sequences = await queries.getFollowupsByCampaign(campaign.id);
    const activeSeqs = sequences.filter(s => s.status === 'active');
    if (!activeSeqs.length) continue;

    // ── KEY FIX: Only process ONE step per campaign per run ──────────────────
    // Sort by step number and find the FIRST step that has contacts ready.
    // This ensures Step 2 never fires in the same run as Step 1.
    activeSeqs.sort((a, b) => a.step_number - b.step_number);

    let processedAStep = false;

    for (const seq of activeSeqs) {
      if (processedAStep) break; // Only one step per campaign per hourly run

      const prevStep = seq.step_number - 1;

      // Find logs from the PREVIOUS step that are old enough (delay_days)
      const prevLogs = await all(
        `SELECT el.email, el.contact_id, el.sent_at
         FROM email_logs el
         WHERE el.campaign_id = ?
           AND el.followup_step = ?
           AND el.status IN ('sent','opened','clicked')
           AND el.sent_at <= datetime('now', '-' || ? || ' days')`,
        [campaign.id, prevStep, seq.delay_days]
      );

      if (!prevLogs.length) continue;

      // Filter out contacts who already got THIS follow-up step
      const toSend = [];
      for (const log of prevLogs) {
        const alreadySent = await get(
          `SELECT id FROM email_logs
           WHERE campaign_id=? AND email=? AND followup_step=?
             AND status IN ('sent','opened','clicked','pending')`,
          [campaign.id, log.email, seq.step_number]
        );
        if (alreadySent) continue;

        const contact = await get(
          `SELECT * FROM contacts WHERE email=? AND status='active'`,
          [log.email]
        );
        if (contact) toSend.push(contact);
      }

      if (!toSend.length) continue;

      console.log(`📨 Follow-up step ${seq.step_number} for "${campaign.name}": ${toSend.length} contacts (delay: ${seq.delay_days}d)`);

      const followupCampaign = {
        ...campaign,
        subject:   seq.subject,
        body_html: seq.body_html,
        body_text: seq.body_text,
      };

      await sendBulkCampaign({
        campaign: followupCampaign,
        contacts: toSend,
        followupStep: seq.step_number,
        followupSequenceId: seq.id,
      });

      processedAStep = true; // ← stop here; next step handled in next hourly run
    }

    // Check if all follow-up steps are now exhausted for this campaign
    if (campaign.status === 'sequence_active') {
      const lastSeq = activeSeqs[activeSeqs.length - 1];
      const allSent = await get(
        `SELECT COUNT(*) as cnt FROM email_logs
         WHERE campaign_id=? AND followup_step=?
           AND status IN ('sent','opened','clicked')`,
        [campaign.id, lastSeq.step_number]
      );
      const initialSent = await get(
        `SELECT COUNT(*) as cnt FROM email_logs
         WHERE campaign_id=? AND followup_step=0
           AND status IN ('sent','opened','clicked')`,
        [campaign.id]
      );
      if (allSent?.cnt > 0 && initialSent?.cnt > 0 && allSent.cnt >= initialSent.cnt) {
        await queries.updateCampaignStatus('completed', campaign.id);
        await run('UPDATE campaigns SET completed_at=CURRENT_TIMESTAMP WHERE id=?', [campaign.id]);
        console.log(`✅ Sequence complete for "${campaign.name}"`);
      }
    }
  }
}

// ─── Scheduler bootstrap ──────────────────────────────────────
function initializeScheduler() {
  console.log('⏰ Initializing email scheduler…');

  // Check for scheduled/one-time campaigns every minute
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
      const currentTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

      // One-time scheduled campaigns whose time has arrived
      const scheduled = await all(
        `SELECT * FROM campaigns WHERE status='scheduled' AND send_mode IN ('once','sequence') AND scheduled_at<=datetime('now')`
      );
      for (const c of scheduled) await executeCampaign(c);
    } catch (err) { console.error('Scheduler (1min) error:', err.message); }
  });

  // Process follow-up sequences every hour (at :00 of every hour)
  cron.schedule('0 * * * *', async () => {
    try {
      console.log('⏰ Hourly follow-up check…');
      await processFollowups();
    } catch (err) { console.error('Follow-up scheduler error:', err.message); }
  });

  // Also run follow-ups on startup (after a short delay)
  setTimeout(async () => {
    try { await processFollowups(); } catch(e) {}
  }, 5000);

  console.log('✅ Scheduler active — follow-ups run every hour automatically');
}

// ─── Manual trigger from API ──────────────────────────────────
async function triggerCampaignNow(campaignId) {
  const campaign = await queries.getCampaignById(campaignId);
  if (!campaign) throw new Error('Campaign not found');
  if (campaign.status === 'running') throw new Error('Campaign is already running');
  // Mark as scheduled→now so executeCampaign picks it up
  await queries.updateCampaignStatus('draft', campaign.id);
  await executeCampaign({ ...campaign, status: 'draft' });
}

module.exports = { initializeScheduler, triggerCampaignNow, processFollowups };
