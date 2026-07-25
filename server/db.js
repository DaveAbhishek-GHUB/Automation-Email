const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// On Railway: volume is mounted at /app/data → DB persists across redeploys
// Locally: uses ./data/database.sqlite
const dataDir = process.env.DB_PATH
  ? path.dirname(process.env.DB_PATH)
  : (fs.existsSync('/app') ? '/app/data' : path.join(__dirname, '..', 'data'));

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.DB_PATH || path.join(dataDir, 'database.sqlite');
console.log(`📂 Database path: ${dbPath}`);
const db = new sqlite3.Database(dbPath);


// Promise wrappers
const run = (sql, params = []) => new Promise((res, rej) =>
  db.run(sql, params, function(err) { if (err) rej(err); else res({ lastID: this.lastID, changes: this.changes }); }));

const get = (sql, params = []) => new Promise((res, rej) =>
  db.get(sql, params, (err, row) => { if (err) rej(err); else res(row); }));

const all = (sql, params = []) => new Promise((res, rej) =>
  db.all(sql, params, (err, rows) => { if (err) rej(err); else res(rows); }));

async function initializeDatabase() {
  await run("PRAGMA foreign_keys = ON");
  await run("PRAGMA journal_mode = WAL");

  await run(`CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, email TEXT UNIQUE NOT NULL, company TEXT, phone TEXT,
    custom_fields TEXT DEFAULT '{}', tags TEXT DEFAULT '[]',
    status TEXT DEFAULT 'active', unsubscribed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS contact_lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, description TEXT, contact_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS contact_list_members (
    contact_id INTEGER, list_id INTEGER,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (contact_id, list_id),
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    FOREIGN KEY (list_id) REFERENCES contact_lists(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, subject TEXT NOT NULL,
    body_html TEXT, body_text TEXT, from_name TEXT, from_email TEXT, reply_to TEXT,
    status TEXT DEFAULT 'draft', send_mode TEXT DEFAULT 'once',
    scheduled_at DATETIME, daily_time TEXT,
    list_ids TEXT DEFAULT '[]', contact_ids TEXT DEFAULT '[]',
    total_recipients INTEGER DEFAULT 0,
    sent_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0,
    open_count INTEGER DEFAULT 0, click_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, completed_at DATETIME
  )`);

  await run(`CREATE TABLE IF NOT EXISTS followup_sequences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL, step_number INTEGER NOT NULL,
    delay_days INTEGER NOT NULL DEFAULT 3, subject TEXT NOT NULL,
    body_html TEXT, body_text TEXT, status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS email_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER, contact_id INTEGER,
    followup_sequence_id INTEGER, followup_step INTEGER DEFAULT 0,
    email TEXT NOT NULL, name TEXT, subject TEXT,
    status TEXT DEFAULT 'pending', tracking_id TEXT UNIQUE,
    sent_at DATETIME, opened_at DATETIME, clicked_at DATETIME, error_message TEXT,
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS click_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tracking_id TEXT, url TEXT, clicked_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Indexes
  await run(`CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_email_logs_campaign ON email_logs(campaign_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_email_logs_tracking ON email_logs(tracking_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_email_logs_status ON email_logs(status)`);

  // Default settings
  const defaults = [
    ['daily_send_time','09:00'],['batch_size','50'],['batch_delay_ms','1000'],
    ['unsubscribe_text','To unsubscribe, click here'],['app_url','http://localhost:3000'],
    ['smtp_configured','false']
  ];
  for (const [k, v] of defaults) {
    await run(`INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)`, [k, v]);
  }

  console.log('✅ Database initialized successfully');
}

// Queries object — all async
const queries = {
  getAllContacts: () => all('SELECT * FROM contacts ORDER BY created_at DESC'),
  getContactById: (id) => get('SELECT * FROM contacts WHERE id = ?', [id]),
  getContactByEmail: (email) => get('SELECT * FROM contacts WHERE email = ?', [email]),
  getActiveContacts: () => all("SELECT * FROM contacts WHERE status = 'active'"),
  insertContact: (c) => run(
    `INSERT OR IGNORE INTO contacts (name,email,company,phone,custom_fields,tags) VALUES (?,?,?,?,?,?)`,
    [c.name, c.email, c.company, c.phone, c.custom_fields, c.tags]
  ),
  updateContactStatus: (status, email) => run('UPDATE contacts SET status=?,updated_at=CURRENT_TIMESTAMP WHERE email=?', [status, email]),
  deleteContact: (id) => run('DELETE FROM contacts WHERE id=?', [id]),
  countContacts: () => get("SELECT COUNT(*) as count FROM contacts WHERE status='active'"),

  getAllLists: () => all('SELECT * FROM contact_lists ORDER BY created_at DESC'),
  insertList: (name, description) => run('INSERT INTO contact_lists (name,description) VALUES (?,?)', [name, description||'']),
  deleteList: (id) => run('DELETE FROM contact_lists WHERE id=?', [id]),
  getListContacts: (listId) => all(
    `SELECT c.* FROM contacts c JOIN contact_list_members m ON c.id=m.contact_id WHERE m.list_id=? AND c.status='active'`,
    [listId]
  ),

  getAllCampaigns: () => all('SELECT * FROM campaigns ORDER BY created_at DESC'),
  getCampaignById: (id) => get('SELECT * FROM campaigns WHERE id=?', [id]),
  insertCampaign: (c) => run(
    `INSERT INTO campaigns (name,subject,body_html,body_text,from_name,from_email,reply_to,send_mode,scheduled_at,daily_time,list_ids,contact_ids) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [c.name,c.subject,c.body_html,c.body_text,c.from_name,c.from_email,c.reply_to,c.send_mode,c.scheduled_at,c.daily_time,c.list_ids,c.contact_ids]
  ),
  updateCampaignStatus: (status, id) => run(`UPDATE campaigns SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`, [status, id]),
  updateCampaignStats: (id) => run(`UPDATE campaigns SET sent_count=sent_count+1,updated_at=CURRENT_TIMESTAMP WHERE id=?`, [id]),
  updateCampaignFailed: (id) => run(`UPDATE campaigns SET failed_count=failed_count+1,updated_at=CURRENT_TIMESTAMP WHERE id=?`, [id]),
  deleteCampaign: (id) => run('DELETE FROM campaigns WHERE id=?', [id]),

  getFollowupsByCampaign: (campaignId) => all('SELECT * FROM followup_sequences WHERE campaign_id=? ORDER BY step_number ASC', [campaignId]),
  insertFollowup: (fu) => run(
    `INSERT INTO followup_sequences (campaign_id,step_number,delay_days,subject,body_html,body_text) VALUES (?,?,?,?,?,?)`,
    [fu.campaign_id,fu.step_number,fu.delay_days,fu.subject,fu.body_html,fu.body_text]
  ),
  deleteFollowupsByCampaign: (campaignId) => run('DELETE FROM followup_sequences WHERE campaign_id=?', [campaignId]),

  insertLog: (l) => run(
    `INSERT INTO email_logs (campaign_id,contact_id,followup_sequence_id,followup_step,email,name,subject,tracking_id,status) VALUES (?,?,?,?,?,?,?,?,?)`,
    [l.campaign_id,l.contact_id,l.followup_sequence_id,l.followup_step,l.email,l.name,l.subject,l.tracking_id,l.status]
  ),
  updateLogSent: (trackingId) => run(`UPDATE email_logs SET status='sent',sent_at=CURRENT_TIMESTAMP WHERE tracking_id=?`, [trackingId]),
  updateLogFailed: (msg, trackingId) => run(`UPDATE email_logs SET status='failed',error_message=? WHERE tracking_id=?`, [msg, trackingId]),
  updateLogOpened: (trackingId) => run(`UPDATE email_logs SET status='opened',opened_at=CURRENT_TIMESTAMP WHERE tracking_id=? AND opened_at IS NULL`, [trackingId]),
  updateLogClicked: (trackingId) => run(`UPDATE email_logs SET clicked_at=CURRENT_TIMESTAMP WHERE tracking_id=? AND clicked_at IS NULL`, [trackingId]),
  getLogByTracking: (trackingId) => get('SELECT * FROM email_logs WHERE tracking_id=?', [trackingId]),
  getLogsByCampaign: (campaignId) => all('SELECT * FROM email_logs WHERE campaign_id=? ORDER BY sent_at DESC', [campaignId]),

  wasFollowupSent: (campaignId, email, step) => get(
    `SELECT id FROM email_logs WHERE campaign_id=? AND email=? AND followup_step=? AND status IN ('sent','opened','clicked')`,
    [campaignId, email, step]
  ),
  getPendingFollowups: (campaignId, prevStep, days) => all(
    `SELECT el.*,c.name as contact_name FROM email_logs el
     LEFT JOIN contacts c ON el.contact_id=c.id
     WHERE el.campaign_id=? AND el.followup_step=? AND el.status IN ('sent','opened')
       AND el.sent_at<=datetime('now','-'||?||' days')`,
    [campaignId, prevStep, days]
  ),

  getOverallStats: () => get(`
    SELECT
      COUNT(CASE WHEN status IN ('sent','opened','clicked') THEN 1 END) as total_sent,
      COUNT(CASE WHEN status='opened' THEN 1 END) as total_opened,
      COUNT(CASE WHEN status='clicked' THEN 1 END) as total_clicked,
      COUNT(CASE WHEN status='failed' THEN 1 END) as total_failed
    FROM email_logs
  `),
  getDailyStats: () => all(`
    SELECT DATE(sent_at) as date,
      COUNT(CASE WHEN status IN ('sent','opened','clicked') THEN 1 END) as sent,
      COUNT(CASE WHEN status='opened' THEN 1 END) as opened,
      COUNT(CASE WHEN status='failed' THEN 1 END) as failed
    FROM email_logs WHERE sent_at>=datetime('now','-30 days')
    GROUP BY DATE(sent_at) ORDER BY date ASC
  `),
  getCampaignStats: () => all(`
    SELECT c.id,c.name,c.status,
      COUNT(CASE WHEN el.status IN ('sent','opened','clicked') THEN 1 END) as sent,
      COUNT(CASE WHEN el.status='opened' THEN 1 END) as opened,
      COUNT(CASE WHEN el.status='clicked' THEN 1 END) as clicked,
      COUNT(CASE WHEN el.status='failed' THEN 1 END) as failed
    FROM campaigns c LEFT JOIN email_logs el ON c.id=el.campaign_id
    GROUP BY c.id ORDER BY c.created_at DESC LIMIT 10
  `),

  getSetting: (key) => get('SELECT value FROM settings WHERE key=?', [key]),
  setSetting: (key, value) => run('INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)', [key, value]),
  getAllSettings: () => all('SELECT key,value FROM settings'),
};

module.exports = { db, queries, initializeDatabase, run, get, all };
