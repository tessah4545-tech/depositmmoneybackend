/* ===== Deposit Money — frontend logic ===== */
const BACKEND_URL = '';
let PAYSTACK_PUBLIC_KEY = '';
const POLL_MS = 4000;
const WAIT_SECONDS = 90;

const $ = (id) => document.getElementById(id);
const screens = {
  form: $('screenForm'),
  processing: $('screenProcessing'),
  success: $('screenSuccess'),
  failed: $('screenFailed'),
};

let currentMethod = 'mpesa';
let pollTimer = null;
let countdownTimer = null;
let secondsLeft = WAIT_SECONDS;

document.getElementById('yr').textContent = new Date().getFullYear();

async function loadConfig() {
  try {
    const r = await fetch(`${BACKEND_URL}/api/config`);
    const cfg = await r.json();
    if (cfg && cfg.success) {
      PAYSTACK_PUBLIC_KEY = cfg.paystackPublicKey || '';
      if (!cfg.cardEnabled) {
        $('tabCard').disabled = true;
        $('tabCard').style.opacity = '.6';
      }
    }
  } catch {}
}
loadConfig();

function show(name) {
  Object.values(screens).forEach((s) => s.classList.remove('active'));
  screens[name].classList.add('active');
}

async function wakeBackend(attempt = 1) {
  const pill = $('serverPill');
  const text = $('serverText');
  pill.classList.remove('online', 'offline');
  text.textContent = attempt === 1 ? 'Connecting…' : 'Waking server…';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 60000);
    const r = await fetch(`${BACKEND_URL}/api/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error('bad status');
    pill.classList.add('online');
    text.textContent = 'Secure server online';
  } catch (e) {
    if (attempt < 3) {
      setTimeout(() => wakeBackend(attempt + 1), 6000);
    } else {
      pill.classList.add('offline');
      text.textContent = 'Server waking — you can still pay';
    }
  }
}
wakeBackend();

function setMethod(m) {
  currentMethod = m;
  $('tabMpesa').classList.toggle('active', m === 'mpesa');
  $('tabCard').classList.toggle('active', m === 'card');
  $('paneMpesa').classList.toggle('active', m === 'mpesa');
  $('paneCard').classList.toggle('active', m === 'card');
  $('payBtnText').textContent = m === 'mpesa' ? 'Pay Securely' : 'Pay with Card';
  $('fineMpesa').style.display = m === 'mpesa' ? 'flex' : 'none';
  $('fineCard').style.display = m === 'card' ? 'flex' : 'none';
  clearError();
}
$('tabMpesa').addEventListener('click', () => setMethod('mpesa'));
$('tabCard').addEventListener('click', () => setMethod('card'));

const amountInput = $('amountInput');
document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((c) => c.classList.remove('sel'));
    chip.classList.add('sel');
    amountInput.value = chip.dataset.amt;
    clearError();
  });
});
amountInput.addEventListener('input', () => {
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('sel', Number(c.dataset.amt) === Number(amountInput.value)));
  clearError();
});
$('phoneInput').addEventListener('input', clearError);
$('emailInput').addEventListener('input', clearError);

function setError(msg) {
  const e = $('formError');
  e.textContent = msg;
  e.classList.remove('shake');
  void e.offsetWidth;
  e.classList.add('shake');
}
function clearError() { $('formError').textContent = ''; }

function normalizePhone(raw) {
  let p = String(raw || '').trim().replace(/[\s\-().]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  p = p.replace(/\D/g, '');
  if (p.startsWith('2540')) p = '254' + p.slice(4);
  else if (p.startsWith('254')) {}
  else if (p.startsWith('0')) p = '254' + p.slice(1);
  else if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  return p;
}
const isValidKenyanPhone = (p) => /^254[17]\d{8}$/.test(p);
const fmt = (n) => 'KES ' + Number(n).toLocaleString('en-KE');

$('payBtn').addEventListener('click', () => {
  if (currentMethod === 'mpesa') startMpesaPayment();
  else startCardPayment();
});

function readAmount() {
  const amount = Number(amountInput.value);
  if (!amount || amount < 5) { setError('Please enter an amount of at least KES 5.'); return null; }
  if (amount > 1000000) { setError('Amount is too large.'); return null; }
  return amount;
}

function lockBtn(label) {
  $('payBtn').disabled = true;
  $('payBtnText').textContent = label;
}
function unlockBtn() {
  $('payBtn').disabled = false;
  $('payBtnText').textContent = currentMethod === 'mpesa' ? 'Pay Securely' : 'Pay with Card';
}

async function startMpesaPayment() {
  clearError();
  const amount = readAmount();
  if (amount === null) return;
  const phone = normalizePhone($('phoneInput').value);
  const name = $('nameInput').value.trim();

  if (!isValidKenyanPhone(phone)) {
    return setError('Enter a valid M-Pesa number — accepted: 07…, 01…, 7…, 1…, +254… or 254….');
  }

  lockBtn('Connecting to Paystack…');
  try {
    const r = await fetch(`${BACKEND_URL}/api/pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, phone, name }),
    });
    const data = await r.json();
    if (!r.ok || !data.success) throw new Error(data.message || 'Could not start payment.');

    $('procTitle').textContent = 'Check your phone';
    $('procLead').innerHTML = `An M-Pesa prompt was sent to <b>+${phone}</b>.<br />Enter your PIN <b>on the phone</b> to complete <b>${fmt(amount)}</b>.`;
    $('pushTitle').textContent = 'M-PESA Request';
    $('pushText').textContent = data.displayText || 'Enter your M-Pesa PIN to pay';
    show('processing');
    startWaiting(data.reference, amount, '+' + phone, 'Phone');
  } catch (err) {
    setError(err.message || 'Network error — please try again.');
  } finally {
    unlockBtn();
  }
}

function openPaystackCard(options) {
  if (window.PaystackPop && typeof window.PaystackPop.setup === 'function') {
    const handler = window.PaystackPop.setup({
      key: options.key,
      email: options.email,
      amount: options.amount,
      currency: options.currency,
      channels: ['card'],
      metadata: options.metadata,
      callback: options.onSuccess,
      onClose: options.onCancel,
    });
    handler.openIframe();
    return;
  }

  if (window.PaystackPop) {
    const popup = new window.PaystackPop();
    popup.newTransaction({
      key: options.key,
      email: options.email,
      amount: options.amount,
      currency: options.currency,
      channels: ['card'],
      metadata: options.metadata,
      onSuccess: options.onSuccess,
      onCancel: options.onCancel,
    });
    return;
  }

  throw new Error('Paystack checkout unavailable');
}

async function startCardPayment() {
  clearError();
  const amount = readAmount();
  if (amount === null) return;
  const email = $('emailInput').value.trim();
  const name = $('nameInput').value.trim();

  if (!/^\S+@\S+\.\S+$/.test(email)) return setError('Enter a valid email address for your card receipt.');
  if (!PAYSTACK_PUBLIC_KEY) await loadConfig();
  if (!PAYSTACK_PUBLIC_KEY) return setError('Card payment is not configured yet. Add PAYSTACK_PUBLIC_KEY to your env and redeploy.');

  lockBtn('Opening secure checkout…');
  try {
    openPaystackCard({
      key: PAYSTACK_PUBLIC_KEY,
      email,
      amount: Math.round(amount * 100),
      currency: 'KES',
      metadata: { name, source: 'deposit-money-web', method: 'card' },
      onSuccess: (tx) => {
        unlockBtn();
        $('procTitle').textContent = 'Confirming payment';
        $('procLead').innerHTML = `Your card payment of <b>${fmt(amount)}</b> was submitted.<br />Confirming with Paystack…`;
        $('pushTitle').textContent = 'Card Payment';
        $('pushText').textContent = 'Confirming your card payment…';
        show('processing');
        startWaiting(tx.reference, amount, email, 'Email');
      },
      onCancel: () => {
        unlockBtn();
        fail('Card checkout was cancelled before completion.');
      },
    });
  } catch (e) {
    unlockBtn();
    setError('Could not open the secure checkout. Please try again.');
  }
}

function startWaiting(reference, amount, contact, contactLabel) {
  stopWaiting();
  secondsLeft = WAIT_SECONDS;
  updateTimer();

  countdownTimer = setInterval(() => {
    secondsLeft -= 1;
    updateTimer();
    if (secondsLeft <= 0) {
      stopWaiting();
      fail('Confirmation timed out. If money was deducted it will be reversed or settled automatically.');
    }
  }, 1000);

  pollTimer = setInterval(() => poll(reference, amount, contact, contactLabel), POLL_MS);
  poll(reference, amount, contact, contactLabel);
}

function updateTimer() {
  $('timerNum').textContent = secondsLeft + 's';
  $('timerFill').style.width = Math.max(0, (secondsLeft / WAIT_SECONDS) * 100) + '%';
}

async function poll(reference, amount, contact, contactLabel) {
  try {
    const r = await fetch(`${BACKEND_URL}/api/verify/${encodeURIComponent(reference)}`);
    const data = await r.json();
    const status = (data.status || '').toLowerCase();
    if (status === 'success') {
      stopWaiting();
      succeed(reference, amount, contact, contactLabel);
    } else if (['failed', 'abandoned', 'reversed'].includes(status)) {
      stopWaiting();
      fail('The payment was declined or cancelled.');
    }
  } catch (e) {}
}

function stopWaiting() {
  clearInterval(pollTimer); pollTimer = null;
  clearInterval(countdownTimer); countdownTimer = null;
}

function succeed(reference, amount, contact, contactLabel) {
  $('okAmount').textContent = fmt(amount);
  $('okContactLabel').textContent = contactLabel || 'Phone';
  $('okPhone').textContent = contact;
  $('okRef').textContent = reference;
  show('success');
  confetti();
}

function fail(reason) {
  $('failReason').textContent = reason;
  show('failed');
}

$('cancelBtn').addEventListener('click', () => { stopWaiting(); show('form'); });
$('retryBtn').addEventListener('click', () => { show('form'); });
$('backBtn').addEventListener('click', () => { show('form'); });
$('againBtn').addEventListener('click', () => {
  amountInput.value = '';
  $('phoneInput').value = '';
  $('emailInput').value = '';
  $('nameInput').value = '';
  document.querySelectorAll('.chip').forEach((c) => c.classList.remove('sel'));
  show('form');
});

function confetti() {
  const canvas = $('confetti');
  const ctx = canvas.getContext('2d');
  canvas.width = innerWidth; canvas.height = innerHeight;
  const colors = ['#00c3f7', '#0ba4db', '#09a76d', '#ffffff', '#7ee3ff'];
  const parts = Array.from({ length: 130 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.5,
    w: 6 + Math.random() * 6,
    h: 8 + Math.random() * 8,
    c: colors[(Math.random() * colors.length) | 0],
    vy: 2.4 + Math.random() * 3.2,
    vx: -1.6 + Math.random() * 3.2,
    rot: Math.random() * Math.PI,
    vr: -0.12 + Math.random() * 0.24,
  }));
  let frames = 0;
  (function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    parts.forEach((p) => {
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });
    if (++frames < 260) requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  })();
}
