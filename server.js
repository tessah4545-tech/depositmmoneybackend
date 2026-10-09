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
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'deposit-admin-2026';
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const CALLBACK_URL = (process.env.CALLBACK_URL || BASE_URL).replace(/\/$/, '');
const PAYSTACK_API = 'https://api.paystack.co';
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(cors());
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true }));

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'transactions.json');
let transactions = [];

try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    transactions = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(transactions)) transactions = [];
  }
} catch {
  transactions = [];
}

function saveTransactions() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(transactions.slice(0, 500), null, 2));
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

function normalizePhone(raw) {
  let p = String(raw || '').trim().replace(/[\s\-().]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  p = p.replace(/\D/g, '');
  if (p.startsWith('2540')) p = '254' + p.slice(4);
  else if (p.startsWith('254')) {
    // already normalized
  } else if (p.startsWith('0')) {
    p = '254' + p.slice(1);
  } else if (p.startsWith('7') || p.startsWith('1')) {
    p = '254' + p;
  }
  return `+${p}`;
}

function isValidKenyanPhone(phone) {
  return /^\+254[17]\d{8}$/.test(phone);
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

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    paystackConfigured: Boolean(PAYSTACK_SECRET),
    publicKeyConfigured: Boolean(PAYSTACK_PUBLIC_KEY),
    callbackUrl: CALLBACK_URL,
    time: new Date().toISOString(),
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    paystackPublicKey: PAYSTACK_PUBLIC_KEY,
    callbackUrl: CALLBACK_URL,
    cardEnabled: Boolean(PAYSTACK_PUBLIC_KEY),
    mpesaEnabled: Boolean(PAYSTACK_SECRET),
  });
});

app.post('/api/pay', async (req, res) => {
  try {
    const { amount, phone, email, name } = req.body || {};
    const amt = Number(amount);
    const msisdn = normalizePhone(phone);
    const msisdnDigits = msisdn.replace(/^\+/, '');

    if (!amt || Number.isNaN(amt) || amt < 5 || amt > 1000000) {
      return res.status(400).json({ success: false, message: 'Enter a valid amount (minimum KES 5).' });
    }
    if (!isValidKenyanPhone(msisdn)) {
      return res.status(400).json({ success: false, message: 'Enter a valid Kenyan phone number (07..., 01..., 7..., 1..., +254... or 254...).' });
    }
    if (!PAYSTACK_SECRET) {
      return res.status(500).json({ success: false, message: 'Server is not configured. Please contact the site owner.' });
    }

    const payload = {
      email: email && /.+@.+\..+/.test(email) ? email : `${msisdnDigits}@depositmoney.app`,
      amount: Math.round(amt * 100),
      currency: 'KES',
      mobile_money: { phone: msisdn, provider: 'mpesa' },
      metadata: { name: name || '', source: 'deposit-money-web', method: 'mpesa' },
    };

    const ps = await axios.post(`${PAYSTACK_API}/charge`, payload, {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    const d = ps.data && ps.data.data ? ps.data.data : {};
    upsertTransaction({
      reference: d.reference,
      amount: amt,
      phone: msisdnDigits,
      name: name || '',
      status: d.status || 'pending',
      method: 'mpesa',
      channel: d.channel || 'mobile_money',
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
      customerEmail: d.customer && d.customer.email ? d.customer.email : undefined,
      method: d.channel === 'mobile_money' ? 'mpesa' : 'card',
    });

    return res.json({
      success: true,
      status: d.status,
      reference: d.reference,
      amount: d.amount ? d.amount / 100 : null,
      channel: d.channel || null,
    });
  } catch (err) {
    const msg = (err.response && err.response.data && err.response.data.message) || err.message;
    return res.status(err.response ? err.response.status : 500).json({ success: false, message: msg });
  }
});

app.post('/api/webhook', (req, res) => {
  try {
    if (!PAYSTACK_SECRET) return res.sendStatus(200);
    const signature = req.headers['x-paystack-signature'];
    const hash = crypto.createHmac('sha512', PAYSTACK_SECRET).update(req.body).digest('hex');
    if (signature !== hash) return res.sendStatus(401);

    const event = JSON.parse(req.body.toString('utf8'));
    if (event && event.data) {
      const tx = event.data;
      const mappedStatus = event.event === 'charge.success' ? 'success' : tx.status;
      upsertTransaction({
        reference: tx.reference,
        amount: tx.amount ? tx.amount / 100 : undefined,
        status: mappedStatus,
        channel: tx.channel,
        paidAt: tx.paid_at || (mappedStatus === 'success' ? new Date().toISOString() : null),
        customerEmail: tx.customer && tx.customer.email ? tx.customer.email : undefined,
      });
    }
    res.sendStatus(200);
  } catch {
    res.sendStatus(200);
  }
});

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
      pending: transactions.filter((t) => !['success', 'failed', 'abandoned', 'reversed'].includes(String(t.status || '').toLowerCase())).length,
    },
  });
});

app.get('/xxadmin', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Deposit Money API running on port ${PORT}`);
  console.log(`Paystack secret configured: ${PAYSTACK_SECRET ? 'YES' : 'NO'}`);
  console.log(`Paystack public key configured: ${PAYSTACK_PUBLIC_KEY ? 'YES' : 'NO'}`);
});
