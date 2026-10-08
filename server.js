/**
 * Deposit Money — Paystack Backend
 * Deploy on Render.com as a Web Service.
 *
 * Environment variables to set on Render:
 *   PAYSTACK_SECRET_KEY  = your sk_live_... key (NEVER put this in frontend code)
 *   ADMIN_PASSWORD       = password for the /xxadmin dashboard (optional, default below)
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'deposit-admin-2026';
const BASE_URL = (process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PAYSTACK_API = 'https://api.paystack.co';

/* ---------------- Middleware ---------------- */
app.use(cors());
// Raw body ONLY for the webhook (needed to verify Paystack signature)
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '100kb' }));

/* ---------------- Simple JSON transaction store ---------------- */
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'transactions.json');

let transactions = [];
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    transactions = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(transactions)) transactions = [];
  }
} catch (e) {
  transactions = [];
}

function saveTransactions() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(transactions.slice(-500), null, 2));
  } catch (e) {
    console.error('Failed to save transactions:', e.message);
  }
}

function upsertTransaction(tx) {
  const i = transactions.findIndex((t) => t.reference === tx.reference);
  if (i >= 0) transactions[i] = { ...transactions[i], ...tx };
  else transactions.unshift(tx);
  saveTransactions();
}

/* ---------------- Helpers ---------------- */
function normalizePhone(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  if (p.startsWith('2540')) p = '254' + p.slice(4);
  return p; // e.g. 254797977136
}

function isValidKenyanPhone(p) {
  return /^254[17]\d{8}$/.test(p);
}

function adminTokenFor(password) {
  return crypto
    .createHash('sha256')
    .update(password + '::' + (PAYSTACK_SECRET || 'local') + '::dm-admin')
    .digest('hex');
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token && token === adminTokenFor(ADMIN_PASSWORD)) return next();
  return res.status(401).json({ success: false, message: 'Unauthorized' });
}

/* ---------------- Health / Wake-up ---------------- */
app.get('/', (req, res) => {
  res.json({ service: 'Deposit Money API', status: 'running', time: new Date().toISOString() });
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    paystackConfigured: Boolean(PAYSTACK_SECRET),
    time: new Date().toISOString(),
  });
});

/* ---------------- Initiate payment (STK Push) ---------------- */
app.post('/api/pay', async (req, res) => {
  try {
    const { amount, phone, email, name } = req.body || {};
    const amt = Number(amount);
    const msisdn = normalizePhone(phone);

    if (!amt || isNaN(amt) || amt < 5 || amt > 1000000) {
      return res.status(400).json({ success: false, message: 'Enter a valid amount (minimum KES 5).' });
    }
    if (!isValidKenyanPhone(msisdn)) {
      return res.status(400).json({ success: false, message: 'Enter a valid Kenyan phone number (e.g. 0797977136).' });
    }
    if (!PAYSTACK_SECRET) {
      return res.status(500).json({ success: false, message: 'Server is not configured. Please contact the site owner.' });
    }

    const payload = {
      email: email && /.+@.+\..+/.test(email) ? email : `${msisdn}@depositmoney.app`,
      amount: Math.round(amt * 100), // Paystack expects kobo/cents
      currency: 'KES',
      mobile_money: { phone: msisdn, provider: 'mpesa' },
      metadata: { name: name || '', source: 'deposit-money-web' },
    };

    const ps = await axios.post(`${PAYSTACK_API}/charge`, payload, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
      timeout: 30000,
    });

    const d = ps.data && ps.data.data ? ps.data.data : {};
    upsertTransaction({
      reference: d.reference,
      amount: amt,
      phone: msisdn,
      name: name || '',
      status: d.status || 'pending',
      displayText: d.display_text || 'Check your phone and enter your M-Pesa PIN to complete the payment.',
      createdAt: new Date().toISOString(),
      paidAt: d.status === 'success' ? new Date().toISOString() : null,
    });

    return res.json({
      success: true,
      reference: d.reference,
      status: d.status || 'pending',
      displayText: d.display_text || 'Check your phone and enter your M-Pesa PIN.',
    });
  } catch (err) {
    const msg =
      (err.response && err.response.data && err.response.data.message) ||
      err.message ||
      'Payment could not be initiated.';
    console.error('PAY ERROR:', msg);
    return res.status(err.response ? err.response.status : 500).json({ success: false, message: msg });
  }
});

/* ---------------- Verify payment (polled by frontend) ---------------- */
app.get('/api/verify/:reference', async (req, res) => {
  try {
    const reference = String(req.params.reference || '').replace(/[^A-Za-z0-9_\-]/g, '');
    if (!reference) return res.status(400).json({ success: false, message: 'Missing reference.' });
    if (!PAYSTACK_SECRET) return res.status(500).json({ success: false, message: 'Server is not configured.' });

    const ps = await axios.get(`${PAYSTACK_API}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
      timeout: 20000,
    });

    const d = ps.data.data || {};
    upsertTransaction({
      reference: d.reference || reference,
      amount: d.amount ? d.amount / 100 : undefined,
      status: d.status,
      channel: d.channel,
      paidAt: d.paid_at || (d.status === 'success' ? new Date().toISOString() : null),
    });

    return res.json({ success: true, status: d.status, reference: d.reference, amount: d.amount ? d.amount / 100 : null });
  } catch (err) {
    const msg = (err.response && err.response.data && err.response.data.message) || err.message;
    return res.status(err.response ? err.response.status : 500).json({ success: false, message: msg });
  }
});

/* ---------------- Paystack Webhook (optional but recommended) ---------------- */
app.post('/api/webhook', (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    const hash = crypto.createHmac('sha512', PAYSTACK_SECRET).update(req.body).digest('hex');
    if (signature !== hash) return res.sendStatus(401);

    const event = JSON.parse(req.body.toString('utf8'));
    if (event && event.event === 'charge.success' && event.data) {
      upsertTransaction({
        reference: event.data.reference,
        amount: event.data.amount ? event.data.amount / 100 : undefined,
        status: 'success',
        channel: event.data.channel,
        paidAt: event.data.paid_at || new Date().toISOString(),
      });
      console.log('Webhook: charge.success', event.data.reference);
    }
    res.sendStatus(200);
  } catch (e) {
    res.sendStatus(200); // always 200 so Paystack doesn't retry aggressively
  }
});

/* ---------------- Admin API ---------------- */
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) {
    return res.json({ success: true, token: adminTokenFor(ADMIN_PASSWORD) });
  }
  return res.status(401).json({ success: false, message: 'Wrong password.' });
});

app.get('/api/admin/transactions', requireAdmin, (req, res) => {
  res.json({ success: true, transactions: transactions.slice(0, 200) });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const paid = transactions.filter((t) => t.status === 'success');
  res.json({
    success: true,
    stats: {
      totalCollected: paid.reduce((s, t) => s + (Number(t.amount) || 0), 0),
      totalCount: paid.length,
      todayCollected: paid
        .filter((t) => (t.paidAt || t.createdAt || '').startsWith(today))
        .reduce((s, t) => s + (Number(t.amount) || 0), 0),
      pending: transactions.filter((t) => t.status !== 'success' && t.status !== 'failed').length,
    },
  });
});

/* ---------------- Keep-alive (prevents Render free tier from sleeping) ---------------- */
setInterval(() => {
  axios.get(`${BASE_URL}/api/health`, { timeout: 10000 }).catch(() => {});
}, 10 * 60 * 1000); // self-ping every 10 minutes

/* ---------------- Start ---------------- */
app.listen(PORT, () => {
  console.log(`Deposit Money API running on port ${PORT}`);
  console.log(`Paystack key configured: ${PAYSTACK_SECRET ? 'YES' : 'NO — set PAYSTACK_SECRET_KEY env var'}`);
});
