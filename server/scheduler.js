const cron = require('node-cron');
const { queries, all, get, run } = require('./db');
const { sendBulkCampaign } = require('./mailer');

// ─── Helper: current time as "HH:MM" in local timezone ───────────────────────
function nowHHMM() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
}

function todayDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}

// ─── Helper: get all contacts for a campaign ──────────────────────────────────
async function getContactsForCampaign(campaign) {
  const listIds    = JSON.parse(campaign.list_ids    || '[]');
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

// ─── Execute the initial (step-0) email blast ─────────────────────────────────
async function executeCampaign(campaign) {
  console.log(`\n📧 Executing campaign: "${campaign.name}" (ID: ${campaign.id})`);
  await queries.updateCampaignStatus('running', campaign.id);

  const contacts = await getContactsForCampaign(campaign);
  if (!contacts.length) {
    console.warn(`⚠️  Campaign "${campaign.name}" has NO CONTACTS — resetting to draft.`);
    await queries.updateCampaignStatus('draft', campaign.id);
    return;
  }

  console.log(`📋 ${contacts.length} contacts to send to`);
  try {
    const result = await sendBulkCampaign({ campaign, contacts, followupStep: 0 });
    console.log(`✅ Campaign "${campaign.name}": ${result.sentCount} sent, ${result.failedCount} failed`);

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

// ─── Process follow-up sequences ─────────────────────────────────────────────
// Runs every minute. Time-gated per campaign (send at or after the configured
// send_time). Catch-up: if app was off when the time passed, sends immediately
// on first run that is >= send_time. Never sends the same step twice to the
// same contact on the same calendar day.
async function processFollowups({ catchup = false } = {}) {
  const currentTime = nowHHMM();
  const today       = todayDate();

  const campaigns = await all(
    `SELECT * FROM campaigns WHERE status IN ('sequence_active','completed')`
  );

  for (const campaign of campaigns) {
    // Resolve the send time for this campaign's follow-ups
    // Priority: campaign.followup_send_time → campaign.daily_time → '09:00'
    const sendTime = campaign.followup_send_time || campaign.daily_time || '09:00';

    // Time gate: only proceed if current time >= send_time (HH:MM string compare)
    // On catch-up startup pass we always proceed regardless of time
    if (!catchup && currentTime < sendTime) {
      continue; // Too early — wait for the scheduled time
    }

    const sequences = await queries.getFollowupsByCampaign(campaign.id);
    const activeSeqs = sequences.filter(s => s.status === 'active');
    if (!activeSeqs.length) continue;

    activeSeqs.sort((a, b) => a.step_number - b.step_number);

    let processedAStep = false;

    for (const seq of activeSeqs) {
      if (processedAStep) break;

      const prevStep = seq.step_number - 1;

      // Find contacts whose previous step was sent at least delay_days ago
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

      // Build send list — skip anyone who already has ANY log entry for this step
      // (sent/opened/clicked = already sent; failed/pending = already attempted, don't hammer SMTP)
      const toSend = [];
      for (const log of prevLogs) {
        const alreadyAttempted = await get(
          `SELECT id FROM email_logs
           WHERE campaign_id=? AND email=? AND followup_step=?`,
          [campaign.id, log.email, seq.step_number]
        );
        if (alreadyAttempted) continue;

        const contact = await get(
          `SELECT * FROM contacts WHERE email=? AND status='active'`, [log.email]
        );
        if (contact) toSend.push(contact);
      }

      if (!toSend.length) continue;

      const label = catchup ? '🔄 Catch-up' : '📨 Scheduled';
      console.log(`${label} follow-up step ${seq.step_number} for "${campaign.name}" [${sendTime}]: ${toSend.length} contacts`);

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

      processedAStep = true;
    }

    // Mark campaign completed if all follow-up steps are exhausted
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
        console.log(`✅ All follow-up steps complete for "${campaign.name}"`);
      }
    }
  }
}

// ─── Scheduler bootstrap ──────────────────────────────────────────────────────
function initializeScheduler() {
  console.log('⏰ Initializing email scheduler…');

  // Check for scheduled/one-time campaigns every minute
  cron.schedule('* * * * *', async () => {
    try {
      // One-time scheduled campaigns whose time has arrived
      const scheduled = await all(
        `SELECT * FROM campaigns WHERE status='scheduled' AND send_mode IN ('once','sequence') AND scheduled_at<=datetime('now')`
      );
      for (const c of scheduled) await executeCampaign(c);

      // Follow-up time check — runs every minute, time-gated per campaign
      await processFollowups({ catchup: false });

    } catch (err) { console.error('Scheduler (1min) error:', err.message); }
  });

  // ── STARTUP CATCH-UP (runs 5s after boot) ────────────────────────────────
  // If the app was off during the scheduled send time, this fires immediately.
  // Example: scheduled 09:00, app started at 10:00 → sends now as catch-up.
  setTimeout(async () => {
    try {
      console.log('🔄 Startup catch-up check — sending any missed follow-ups…');
      await processFollowups({ catchup: true });
      console.log('✅ Catch-up check complete');
    } catch(e) { console.error('Catch-up error:', e.message); }
  }, 5000);

  console.log('✅ Scheduler active — follow-ups check every minute, catch-up on startup');
}

// ─── Manual trigger from API ──────────────────────────────────────────────────
async function triggerCampaignNow(campaignId) {
  const campaign = await queries.getCampaignById(campaignId);
  if (!campaign) throw new Error('Campaign not found');
  if (campaign.status === 'running') throw new Error('Campaign is already running');
  await queries.updateCampaignStatus('draft', campaign.id);
  await executeCampaign({ ...campaign, status: 'draft' });
}

module.exports = { initializeScheduler, triggerCampaignNow, processFollowups };
