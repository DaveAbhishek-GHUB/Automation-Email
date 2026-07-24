const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const { queries, run, get, all } = require('../db');

const router = express.Router();
const upload = multer({ dest: path.join(__dirname, '../../uploads/') });

// GET /api/contacts
router.get('/', async (req, res) => {
  try {
    const { status, search, limit = 100, offset = 0 } = req.query;
    let contacts, total;

    if (search) {
      const p = `%${search}%`;
      const statusClause = status ? `AND status=?` : '';
      const params = [p, p, p, ...(status ? [status] : []), parseInt(limit), parseInt(offset)];
      contacts = await all(`SELECT * FROM contacts WHERE (email LIKE ? OR name LIKE ? OR company LIKE ?) ${statusClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`, params);
      const row = await get(`SELECT COUNT(*) as count FROM contacts WHERE (email LIKE ? OR name LIKE ? OR company LIKE ?) ${statusClause}`, [p, p, p, ...(status ? [status] : [])]);
      total = row.count;
    } else {
      const statusClause = status ? 'WHERE status=?' : '';
      const params = [...(status ? [status] : []), parseInt(limit), parseInt(offset)];
      contacts = await all(`SELECT * FROM contacts ${statusClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`, params);
      const row = await get(`SELECT COUNT(*) as count FROM contacts ${statusClause}`, status ? [status] : []);
      total = row.count;
    }
    res.json({ contacts, total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/contacts/upload OR /api/contacts/import — CSV import (both routes supported)
const csvImportHandler = upload.single('csv');
router.post('/upload', csvImportHandler, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const listName = req.body.listName || `Import ${new Date().toLocaleDateString()}`;
  const results = [];
  const errors = [];

  try {
    await new Promise((resolve, reject) => {
      fs.createReadStream(req.file.path).pipe(csv())
        .on('data', (row) => {
          const keys = Object.keys(row);
          const emailKey = keys.find(k => k.toLowerCase().includes('email'));
          const nameKey = keys.find(k => k.toLowerCase().includes('name'));
          const companyKey = keys.find(k => k.toLowerCase().includes('company') || k.toLowerCase().includes('org'));
          const phoneKey = keys.find(k => k.toLowerCase().includes('phone') || k.toLowerCase().includes('mobile'));
          if (!emailKey || !row[emailKey]) return;

          const email = row[emailKey].trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errors.push({ email, reason: 'Invalid format' }); return; }

          const knownKeys = [emailKey, nameKey, companyKey, phoneKey].filter(Boolean);
          const customFields = {};
          for (const [k, v] of Object.entries(row)) { if (!knownKeys.includes(k) && v) customFields[k] = v; }

          results.push({
            name: nameKey ? row[nameKey].trim() : '',
            email, company: companyKey ? row[companyKey].trim() : '',
            phone: phoneKey ? row[phoneKey].trim() : '',
            custom_fields: JSON.stringify(customFields), tags: '[]',
          });
        })
        .on('end', resolve).on('error', reject);
    });

    const listResult = await run('INSERT INTO contact_lists (name,description,contact_count) VALUES (?,?,?)', [listName, 'Imported from CSV', results.length]);
    const listId = listResult.lastID;

    let inserted = 0, skipped = 0;
    for (const contact of results) {
      const result = await queries.insertContact(contact);
      const c = await queries.getContactByEmail(contact.email);
      if (c) await run('INSERT OR IGNORE INTO contact_list_members (contact_id,list_id) VALUES (?,?)', [c.id, listId]);
      if (result.changes > 0) inserted++;
      else skipped++;
    }

    await run('UPDATE contact_lists SET contact_count=? WHERE id=?', [inserted + skipped, listId]);
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    res.json({ success: true, listId, listName, total: results.length, inserted, skipped, errors: errors.length, errorDetails: errors.slice(0, 10) });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/contacts
router.post('/', async (req, res) => {
  try {
    const { name, email, company, phone, custom_fields = {} } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const result = await queries.insertContact({ name: name||'', email: email.trim().toLowerCase(), company: company||'', phone: phone||'', custom_fields: JSON.stringify(custom_fields), tags: '[]' });
    if (result.changes === 0) return res.status(409).json({ error: 'Contact already exists' });
    const contact = await queries.getContactByEmail(email);
    res.json({ success: true, contact });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/contacts/:id
router.delete('/:id', async (req, res) => {
  try { await queries.deleteContact(req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/contacts/:id/unsubscribe
router.post('/:id/unsubscribe', async (req, res) => {
  try {
    const contact = await queries.getContactById(req.params.id);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    await queries.updateContactStatus('unsubscribed', contact.email);
    await run("UPDATE contacts SET unsubscribed_at=CURRENT_TIMESTAMP WHERE id=?", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/contacts/lists/all
router.get('/lists/all', async (req, res) => {
  try { res.json({ lists: await queries.getAllLists() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/contacts/lists
router.post('/lists', async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'List name required' });
    const result = await queries.insertList(name, description);
    res.json({ success: true, listId: result.lastID });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/contacts/lists/:id
router.delete('/lists/:id', async (req, res) => {
  try {
    await queries.deleteList(req.params.id);
    // Also remove all members from this list
    await run('DELETE FROM contact_list_members WHERE list_id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/contacts/lists/:id/members — get contacts in a specific list
router.get('/lists/:id/members', async (req, res) => {
  try {
    const contacts = await queries.getListContacts(req.params.id);
    res.json({ contacts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/contacts/lists/:listId/members/:contactId
router.delete('/lists/:listId/members/:contactId', async (req, res) => {
  try {
    await run('DELETE FROM contact_list_members WHERE list_id=? AND contact_id=?', [req.params.listId, req.params.contactId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/contacts/stats/summary
router.get('/stats/summary', async (req, res) => {
  try {
    const total = await get("SELECT COUNT(*) as count FROM contacts");
    const active = await get("SELECT COUNT(*) as count FROM contacts WHERE status='active'");
    const unsubscribed = await get("SELECT COUNT(*) as count FROM contacts WHERE status='unsubscribed'");
    const lists = await get("SELECT COUNT(*) as count FROM contact_lists");
    res.json({ total: total.count, active: active.count, unsubscribed: unsubscribed.count, lists: lists.count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
