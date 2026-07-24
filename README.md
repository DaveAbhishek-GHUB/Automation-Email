# TitanMail Email Marketing Automation Tool

A self-hosted, full-stack Email Marketing Automation Tool powered by your **TitanMail SMTP** account.

## ✨ Features

- 📤 **CSV Upload** — Drag-and-drop CSV import with auto-detection of columns
- 📋 **Contact Lists** — Organize contacts into groups
- 📧 **Campaign Creator** — Rich HTML email builder with live preview
- ⚡ **Send Immediately** or **Schedule for Later**
- 🔁 **Daily Repeat Mode** — Automatically sends every day at your chosen time
- 🔄 **Automatic Follow-ups** — Multi-step sequences triggered after X days
- 📊 **Analytics** — Open rates, click rates, 30-day charts
- 👁 **Open & Click Tracking** — Know who opened and clicked your emails
- 🚫 **Unsubscribe Handling** — One-click unsubscribe links built-in

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Your TitanMail Credentials
```bash
cp .env.example .env
```
Edit `.env` and fill in:
```
SMTP_HOST=smtp.titan.email
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your@email.com
SMTP_PASS=your_password
FROM_NAME=Your Name
FROM_EMAIL=your@email.com
APP_URL=http://localhost:3000
```

### 3. Enable Third-Party Access in TitanMail
- Login to **mail.titan.email**
- Go to **Settings → Security**
- Enable **"Allow third-party email access"**
- If you have 2FA, disable it or create an app-specific password

### 4. Start the Tool
```bash
npm run dev      # Development (with auto-restart)
npm start        # Production
```

### 5. Open the Dashboard
Visit: **http://localhost:3000**

---

## 📁 Project Structure

```
├── server/
│   ├── index.js          # Express server + tracking routes
│   ├── db.js             # SQLite database + queries
│   ├── mailer.js         # Nodemailer + TitanMail SMTP
│   ├── scheduler.js      # node-cron daily/follow-up jobs
│   └── routes/
│       ├── contacts.js   # Contact + CSV API
│       ├── campaigns.js  # Campaign API
│       └── analytics.js  # Stats + Settings API
├── public/               # Frontend (HTML/CSS/JS)
│   ├── index.html        # Dashboard
│   ├── contacts.html     # CSV upload + contacts
│   ├── campaigns.html    # Campaign creator
│   ├── followups.html    # Follow-up sequences
│   ├── analytics.html    # Analytics charts
│   └── settings.html     # SMTP + scheduling config
├── data/                 # SQLite database (auto-created)
├── uploads/              # Temp CSV files (auto-cleaned)
├── .env                  # Your credentials (DO NOT commit)
└── .env.example          # Template
```

---

## 📧 TitanMail Sending Limits

| Plan | Per Day | Per Hour |
|------|---------|----------|
| Free | ~100 | ~50 |
| Business | 500–1,000 | 200–500 |

The tool automatically batches emails with delays to stay within limits.

---

## 🔧 Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express |
| Email | Nodemailer (TitanMail SMTP) |
| Database | SQLite (better-sqlite3) |
| Scheduler | node-cron |
| CSV Parser | csv-parser |
| Templates | Handlebars |
| Frontend | HTML + CSS + Vanilla JS |
| Charts | Chart.js |

---

## 📋 CSV Format

Your CSV should have these columns (case-insensitive):

```csv
name,email,company,phone
John Doe,john@company.com,Acme Corp,+91 98765 43210
Jane Smith,jane@startup.io,Startup Inc,
```

Additional columns are stored as custom fields and available as `{{columnName}}` in templates.
