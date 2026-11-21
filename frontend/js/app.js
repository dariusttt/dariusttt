/* ══════════════════════════════════════════════════════════════════════════════
   PetroKenya — station dashboard (browser side)
   compute() mirrors the server's engine in backend/server.py; the server is the
   source of truth and recomputes every figure on save.
   ══════════════════════════════════════════════════════════════════════════════ */

// ── Constants (same as backend/server.py) ────────────────────────────────────
const VAT       = 0.16;
const EX_P      = 21.95;   // Excise petrol
const EX_D      = 7.21;    // Excise diesel
const EX_K      = 7.19;    // Excise kerosene
const RL_P      = 18.00;   // Road levy petrol
const RL_D      = 13.19;   // Road levy diesel

// ── Helpers ──────────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const fv = id => parseFloat($(id)?.value) || 0;
const sv = id => $(id)?.value?.trim() || '';
const r2 = v  => Math.round(v * 100) / 100;
const fmt = n => Number(n||0).toLocaleString('en-KE',{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtL = n => Number(n||0).toFixed(2);
// Escape text before putting it into innerHTML — records are shared between users
const esc = v => String(v ?? '').replace(/[&<>"']/g, ch =>
  ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));

// ── Backend API + session ─────────────────────────────────────────────────────
const CACHE_KEY = 'pk_cache_v1';   // last records seen, for read-only offline use
let ONLINE = false;
let USER = null;                   // { username, role, station }

const storeGet = key => { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } };
const storeSet = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage unavailable */ } };

async function api(method, path, body) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    setOnline(false);
    throw new Error('No connection to the server');
  }
  setOnline(true);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    USER = null;
    showLogin();
  }
  if (!res.ok) {
    const err = new Error(data.error || ('HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

function setOnline(v) {
  ONLINE = v;
  const el = $('dbPill');
  if (!el) return;
  el.classList.toggle('offline', !v);
  const waiting = outbox().length;
  el.lastChild.textContent = (v ? ' Online' : ' Offline') +
    (waiting ? ` · ${waiting} waiting to send` : v ? ' · Synced' : ' · Saving on this phone');
}

// ── Saving offline: saves wait on the phone and are sent when the connection is back ─
const OUTBOX_KEY = 'pk_outbox_v1';
const outboxAll = () => storeGet(OUTBOX_KEY) || [];
const outbox = () => outboxAll().filter(o => USER && o.user === USER.username);

function queueSave(rec) {
  const others = outboxAll().filter(o => !(o.user === USER.username && o.rec.report_date === rec.report_date
    && o.rec.station === rec.station));
  others.push({ user: USER.username, rec, queued_at: new Date().toISOString(), error: '' });
  storeSet(OUTBOX_KEY, others);
  mergeOutbox();
  setOnline(ONLINE);
  loadRecs();
  toast('📴 Saved on this phone — it will be sent when you are back online');
}

// Show waiting saves in the records (replacing the server copy of the same day)
function mergeOutbox() {
  outbox().forEach(o => {
    RECS = RECS.filter(r => !(r.report_date === o.rec.report_date && r.station === o.rec.station));
    RECS.unshift({ ...o.rec, pending: true, pending_error: o.error });
  });
}

let flushing = false;
async function flushOutbox() {
  if (flushing || !ONLINE || !USER || !outbox().length) return;
  flushing = true;
  let sent = 0;
  try {
    for (const item of outbox()) {
      try {
        await api('POST', '/records', item.rec);
        storeSet(OUTBOX_KEY, outboxAll().filter(o => !(o.user === item.user && o.queued_at === item.queued_at)));
        sent++;
      } catch (e) {
        if (!ONLINE || e.status === 401) break;                     // try again later
        storeSet(OUTBOX_KEY, outboxAll().map(o =>
          o.user === item.user && o.queued_at === item.queued_at ? { ...o, error: e.message } : o));
        toast(`⚠️ Couldn't send ${item.rec.report_date}: ${e.message}`, true);
      }
    }
  } finally { flushing = false; }
  if (sent) {
    toast(`📤 Sent ${sent} day${sent === 1 ? '' : 's'} saved while offline`);
    await refreshRecs();
    refreshAlerts();
  }
  setOnline(ONLINE);
}

async function discardQueued(date, station) {
  const ok = await showConfirmModal('Discard this unsent save?',
    `The ${date} figures saved on this phone for ${station} will be thrown away.`);
  if (!ok) return;
  storeSet(OUTBOX_KEY, outboxAll().filter(o => !(o.user === USER.username && o.rec.report_date === date && o.rec.station === station)));
  await refreshRecs();
  setOnline(ONLINE);
}

// Retry waiting saves every minute and as soon as the phone reconnects
setInterval(() => { if (USER && outbox().length) { if (!ONLINE) api('GET', '/me').catch(() => {}); flushOutbox(); } }, 60000);

// Pull records from the server into RECS (falls back to the offline cache)
async function syncFromServer() {
  try {
    const data = await api('GET', '/records');
    RECS = Array.isArray(data.records) ? data.records : [];
    storeSet(CACHE_KEY, { user: USER && USER.username, records: RECS });
    mergeOutbox();
    return true;
  } catch (e) {
    const cache = storeGet(CACHE_KEY);
    if (!ONLINE && cache && USER && cache.user === USER.username) {
      RECS = cache.records || [];
      mergeOutbox();
      toast('📴 Offline — showing records from your last sync', true);
    } else if (ONLINE) {
      toast('⚠️ ' + e.message, true);
    }
    return false;
  }
}

async function refreshRecs() {
  await syncFromServer();
  loadRecs();
  renderAnalytics();
}

function requireOnline(action) {
  if (ONLINE) return true;
  toast('📴 You are offline — connect to the internet to ' + action, true);
  return false;
}

// ── Sign in / account ─────────────────────────────────────────────────────────
// ── 👁 Show / hide password: every password box gets an eye button ───────────
function addPasswordEyes(root) {
  (root || document).querySelectorAll('input[type="password"]').forEach(input => {
    if (input.parentElement.classList.contains('pw-wrap')) return;
    const wrap = document.createElement('span');
    wrap.className = 'pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'pw-eye';
    eye.textContent = '👁';
    eye.title = eye.ariaLabel = 'Show password';
    eye.onclick = () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      eye.textContent = show ? '🙈' : '👁';
      eye.title = eye.ariaLabel = show ? 'Hide password' : 'Show password';
      input.focus();
    };
    wrap.appendChild(eye);
  });
}
// Typed passwords go back to dots once they've been used
function hidePasswords() {
  document.querySelectorAll('.pw-wrap input').forEach(i => { i.type = 'password'; });
  document.querySelectorAll('.pw-eye').forEach(e => { e.textContent = '👁'; e.title = e.ariaLabel = 'Show password'; });
}
addPasswordEyes();

// ── Forgot password: ask for a code, then set a new password with it ─────────
function showForgot() {
  $('loginForm').hidden = true;
  $('forgotBox').hidden = false;
  $('fpUser').value = sv('loginUser');
  showForgotStep(1);
}
function showForgotStep(n) {
  $('fpStep1').hidden = n !== 1;
  $('fpStep2').hidden = n !== 2;
  $('fpError').textContent = '';
  setTimeout(() => $(n === 1 ? 'fpUser' : 'fpCode').focus(), 50);
}
function backToLogin(msg) {
  $('forgotBox').hidden = true;
  $('loginForm').hidden = false;
  $('loginError').textContent = msg || '';
  $('loginError').classList.toggle('ok', !!msg);
  ['fpCode', 'fpNew'].forEach(id => { $(id).value = ''; });
  hidePasswords();
  setTimeout(() => $(sv('loginUser') ? 'loginPass' : 'loginUser').focus(), 50);
}
async function sendResetCode(evt) {
  if (evt) evt.preventDefault();
  if (!requireOnline('reset a password')) return;
  const btn = $('fpSendBtn');
  btn.disabled = true;
  try {
    const res = await api('POST', '/password/forgot', { username: sv('fpUser') });
    $('fpSent').textContent = '✉️ ' + res.message + (res.preview_code ? ' (Website preview — your code is ' + res.preview_code + ')' : '');
    showForgotStep(2);
  } catch (e) { $('fpError').textContent = e.message; }
  finally { btn.disabled = false; }
}
async function finishReset(evt) {
  if (evt) evt.preventDefault();
  const btn = $('fpResetBtn');
  btn.disabled = true;
  $('fpError').textContent = '';
  try {
    await api('POST', '/password/reset', { username: sv('fpUser'), code: sv('fpCode'), new_password: $('fpNew').value });
    $('loginUser').value = sv('fpUser');
    $('loginPass').value = '';
    backToLogin('✅ Password changed — sign in with your new password.');
  } catch (e) { $('fpError').textContent = e.message; }
  finally { btn.disabled = false; }
}

function showLogin(msg) {
  $('loginError').textContent = msg || '';
  $('loginError').classList.remove('ok');
  $('forgotBox').hidden = true;
  $('loginForm').hidden = false;
  $('loginOverlay').classList.add('open');
  setTimeout(() => $('loginUser').focus(), 50);
}

async function doLogin(evt) {
  if (evt) evt.preventDefault();
  const btn = $('loginBtn');
  btn.disabled = true;
  $('loginError').textContent = '';
  try {
    const res = await api('POST', '/login', { username: sv('loginUser'), password: $('loginPass').value });
    USER = res.user;
    storeSet('pk_user', USER);
    $('loginPass').value = '';
    hidePasswords();
    $('loginOverlay').classList.remove('open');
    await startSession();
    toast('👋 Welcome, ' + displayName(USER));
  } catch (e) {
    $('loginError').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

async function logout() {
  const waiting = outbox().length;
  if (waiting) {
    const ok = await showConfirmModal('Some saves have not been sent',
      `${waiting} day${waiting === 1 ? '' : 's'} saved on this phone ${waiting === 1 ? 'has' : 'have'} not reached the server yet. ` +
      'They stay on this phone and are sent the next time you sign in here.\n\nSign out anyway?');
    if (!ok) return;
  }
  try { await api('POST', '/logout'); } catch (e) { /* already signed out */ }
  USER = null;
  RECS = [];
  $('fOperator').value = '';
  try { localStorage.removeItem(CACHE_KEY); localStorage.removeItem('pk_user'); } catch (e) { /* ignore */ }
  closeAccount();
  closeDetail();
  closeAlerts();
  closeStatement();
  closeBin();
  ALERTS = []; CUSTOMERS = []; STATIONS = [];
  renderStationPickers();
  $('alertBtn').hidden = true; $('alertCount').hidden = true;
  clearFormForNewEntry();
  loadRecs();
  renderAnalytics();
  // The next person to sign in starts from the menu on today's date, not where the last one left off
  delete $('fDate').dataset.userEdited;
  applyTodayDate();
  openedFromMenu = false;
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  showPage(null);
  showLogin();
}

const displayName = u => (u && (u.display_name || u.full_name || u.username)) || '';

// Lock the UI to what this user is allowed to do
// Cost prices, margins and profit are for managers and admins, not pump staff
const seesProfit = () => !!USER && USER.role !== 'staff';

function applyUserToUI() {
  document.body.classList.toggle('no-profit', !seesProfit());
  const isAdmin = USER && USER.role === 'admin';
  const fixed = USER && (USER.role === 'staff' || USER.role === 'manager') && USER.station;
  $('userBtn').textContent = '👤 ' + (USER ? displayName(USER) : 'Sign in');
  // The operator is whoever is signed in; the server records the same name on save
  $('fOperator').value = displayName(USER);
  const sel = $('fStation');
  if (fixed) sel.value = USER.station;
  sel.disabled = !!fixed;
  $('hStation').textContent = sel.value || 'PetroKenya';
  $('filterStationBtn').style.display = fixed ? 'none' : '';
  if (fixed) $('filterStation').style.display = 'none';
  $('eraseAllBtn').style.display = isAdmin ? '' : 'none';
  $('binBtn').style.display = isAdmin ? '' : 'none';
  $('alertBtn').hidden = !canApprove();
  $('ncLimit').disabled = !canApprove();
  updateLockState();
}

// ── Edit locks: staff may change today's and yesterday's records only (server enforces) ─
function dateMinus(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - days);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// The saved record for the date and branch on screen, if there is one
function currentRecord() {
  return RECS.find(r => r.report_date === sv('fDate') && r.station === sv('fStation')) || null;
}

const canApprove = () => USER && (USER.role === 'manager' || USER.role === 'admin');

function lockReason(date, rec = currentRecord()) {
  if (!date) return '';
  if (date > todayLocal()) return "This date is in the future, so it can't be saved yet.";
  if (rec && rec.report_date === date && rec.approved_at)
    return '✅ This day was approved by ' + rec.approved_by + ' and is locked. An admin must reopen it to make changes.';
  if (USER && USER.role === 'staff' && date < dateMinus(todayLocal(), 1))
    return '🔒 This day is locked. Staff can change today\'s and yesterday\'s records only — ask an admin to change it.';
  return '';
}

function updateLockState() {
  const reason = lockReason(sv('fDate'));
  const banner = $('lockBanner');
  if (banner) { banner.textContent = reason; banner.hidden = !reason; }
  document.querySelectorAll('[data-save-btn]').forEach(b => { b.disabled = !!reason; b.title = reason; });
  const rec = currentRecord();
  const approveBtn = $('approveDayBtn');
  if (approveBtn) approveBtn.hidden = !(rec && !rec.approved_at && canApprove());
}

// ── Day approval: a manager (own branch) or admin locks a day; only admins reopen ─
async function setApproval(id, approve) {
  if (!requireOnline(approve ? 'approve the day' : 'reopen the day')) return false;
  if (approve) {
    const ok = await showConfirmModal('Approve and lock this day?',
      'Once approved, nobody can change or delete this day until an admin reopens it.');
    if (!ok) return false;
  }
  try {
    await api('POST', '/records/' + id + '/' + (approve ? 'approve' : 'reopen'), {});
    toast(approve ? '✅ Day approved and locked' : '🔓 Day reopened');
    await refreshRecs();
    updateLockState();
    return true;
  } catch (e) { toast('⚠️ ' + e.message, true); return false; }
}

async function approveCurrentDay() {
  const rec = currentRecord();
  if (!rec) { toast('Save the day first, then approve it', true); return; }
  await setApproval(rec.id, true);
}

async function approveDetail(approve) {
  if (DETAIL_ID === null) return;
  const id = DETAIL_ID;
  if (await setApproval(id, approve)) openDetail(null, id);
}

async function logoutOtherDevices() {
  if (!requireOnline('sign out other devices')) return;
  try {
    const { signed_out } = await api('POST', '/me/logout-all', {});
    toast(signed_out ? `✅ Signed out on ${signed_out} other device${signed_out === 1 ? '' : 's'}` : 'No other devices were signed in');
  } catch (e) { toast('⚠️ ' + e.message, true); }
}

async function signOutUser(id, name) {
  const ok = await showConfirmModal('Sign out ' + name + '?', name + ' will be signed out on every device and must sign in again.');
  if (!ok) return;
  try {
    await api('POST', '/users/' + id + '/logout', {});
    toast('✅ ' + name + ' signed out everywhere');
  } catch (e) { toast('⚠️ ' + e.message, true); }
}

// ── Pumps: three petrol, three diesel and one kerosene (same list as the server) ─
const PUMPS = [['p1', 'petrol'], ['p2', 'petrol'], ['p3', 'petrol'],
               ['d1', 'diesel'], ['d2', 'diesel'], ['d3', 'diesel'], ['k1', 'kero']];
const PUMP_READINGS = ['open', 'close', 'sales_open', 'sales_close'];
const FUEL_LABEL = { petrol: 'Petrol', diesel: 'Diesel', kero: 'Kerosene' };
const pumpName = id => 'Pump ' + id.toUpperCase();
const pumpsOf = fuel => PUMPS.filter(p => p[1] === fuel).map(p => p[0]);
const pumpField = (id, reading) => `pump_${id}_${reading}`;   // also the input's id

// Each fuel box gets a block of meter inputs per pump
document.querySelectorAll('.pumps[data-fuel]').forEach(box => {
  const box_inputs = (id, reading, label) => `<div class="ig"><label for="${pumpField(id, reading)}">${label}</label>
    <input type="number" id="${pumpField(id, reading)}" placeholder="0.00" step="0.01" oninput="calc()"></div>`;
  box.innerHTML = pumpsOf(box.dataset.fuel).map(id => `<div class="pump">
    <div class="pump-head"><span class="pump-name">⛽ ${pumpName(id)}</span><span class="pump-sold" id="pump_${id}_sold"></span></div>
    <div class="fuel-row">
      ${box_inputs(id, 'open', 'Opening Litres Meter (L)')}${box_inputs(id, 'close', 'Closing Litres Meter (L)')}
      ${box_inputs(id, 'sales_open', 'Opening Sales Meter (KES)')}${box_inputs(id, 'sales_close', 'Closing Sales Meter (KES)')}
    </div></div>`).join('');
});

// What one pump moved: closing − opening (nothing until its closing reading is in)
function pumpMoved(id, kind) {
  return Math.max(0, r2(fv(pumpField(id, kind + 'close')) - fv(pumpField(id, kind + 'open'))));
}
// A fuel's totals over its pumps: litres, KES on the sales meters, and the summed readings
function fuelMeters(fuel) {
  const ids = pumpsOf(fuel);
  const sum = reading => r2(ids.reduce((s, id) => s + fv(pumpField(id, reading)), 0));
  return {
    litres: r2(ids.reduce((s, id) => s + pumpMoved(id, ''), 0)),
    sales: r2(ids.reduce((s, id) => s + pumpMoved(id, 'sales_'), 0)),
    hasSales: ids.some(id => fv(pumpField(id, 'sales_open')) || fv(pumpField(id, 'sales_close'))),
    open: sum('open'), close: sum('close'), sales_open: sum('sales_open'), sales_close: sum('sales_close'),
  };
}

// ── Change history (shown in a record's details) ─────────────────────────────
const FIELD_LABELS = {
  report_date: 'Date', station: 'Branch', shift: 'Shift',
  petrol_open: 'Petrol opening meter', petrol_close: 'Petrol closing meter', petrol_price: 'Petrol price',
  petrol_cost: 'Petrol cost', petrol_sales_open: 'Petrol opening sales meter', petrol_sales_close: 'Petrol closing sales meter',
  diesel_open: 'Diesel opening meter', diesel_close: 'Diesel closing meter', diesel_price: 'Diesel price',
  diesel_cost: 'Diesel cost', diesel_sales_open: 'Diesel opening sales meter', diesel_sales_close: 'Diesel closing sales meter',
  kero_open: 'Kerosene opening meter', kero_close: 'Kerosene closing meter', kero_price: 'Kerosene price',
  kero_cost: 'Kerosene cost', kero_sales_open: 'Kerosene opening sales meter', kero_sales_close: 'Kerosene closing sales meter',
  petrol_dip_open: 'Petrol opening dip', petrol_delivered: 'Petrol delivered', petrol_dip_close: 'Petrol closing dip',
  diesel_dip_open: 'Diesel opening dip', diesel_delivered: 'Diesel delivered', diesel_dip_close: 'Diesel closing dip',
  kero_dip_open: 'Kerosene opening dip', kero_delivered: 'Kerosene delivered', kero_dip_close: 'Kerosene closing dip',
  mpesa_amount: 'M-Pesa', mpesa_txns: 'M-Pesa transactions', cash_amount: 'Cash', credit_amount: 'Credit sales',
  card_amount: 'Card', float_amount: 'Opening float', banked_amount: 'Cash banked',
  ...Object.fromEntries(PUMPS.flatMap(([id]) => [['open', 'opening meter'], ['close', 'closing meter'],
    ['sales_open', 'opening sales meter'], ['sales_close', 'closing sales meter']]
    .map(([x, what]) => [pumpField(id, x), pumpName(id) + ' ' + what]))),
  exp_wages: 'Wages', exp_elec: 'Electricity', exp_water: 'Water', exp_maint: 'Maintenance',
  exp_lubes: 'Lubricants stock', exp_misc: 'Miscellaneous', misc_items: 'Miscellaneous items',
  gas_items: 'Gas & lubricant sales', invoices: 'Credit invoices', mpesa_till: 'M-Pesa till',
  mpesa_ref: 'M-Pesa ref', credit_customer: 'Credit customer', kra_pin: 'KRA PIN', kra_business: 'Business name',
  kra_period: 'Tax period', kra_branch: 'KRA branch', kra_etr: 'ETR number', kra_return_type: 'Return type',
  kra_remarks: 'Remarks', deliveries: 'Deliveries'
};
const ACTION_LABELS = { create: 'Created', update: 'Changed', delete: 'Moved to bin', restore: 'Restored from bin',
  purge: 'Deleted for good', approve: 'Approved and locked', reopen: 'Reopened' };

function histValue(v) {
  if (Array.isArray(v)) return v.length + ' item' + (v.length === 1 ? '' : 's');
  if (v === null || v === undefined || v === '') return '—';
  return typeof v === 'number' ? fmt(v) : String(v);
}

async function loadHistory(id) {
  const box = $('rdHistory');
  box.innerHTML = '<div class="m-row"><span>Loading…</span></div>';
  try {
    const { history } = await api('GET', '/records/' + id + '/history');
    if (DETAIL_ID !== Number(id)) return;
    box.innerHTML = history.slice().reverse().map(h => `
      <div class="m-row">
        <span class="hist-head">${esc(ACTION_LABELS[h.action] || h.action)} by ${esc(h.by)} · ${esc(new Date(h.at).toLocaleString(LOCALE))}</span>
        ${h.changes.map(ch => `<span class="hist-change">${esc(FIELD_LABELS[ch.field] || ch.field)}: <b>${esc(histValue(ch.before))}</b> → <b>${esc(histValue(ch.after))}</b></span>`).join('')}
      </div>`).join('') || '<div class="m-row"><span>No history yet.</span></div>';
  } catch (e) {
    box.innerHTML = `<div class="m-row"><span>${esc(ONLINE ? e.message : 'History needs an internet connection.')}</span></div>`;
  }
}

// ── Bin (admin): restore or delete records for good ──────────────────────────
async function openBin() {
  $('binOverlay').classList.add('open');
  const list = $('binList');
  list.innerHTML = '<div class="m-row"><span>Loading…</span></div>';
  try {
    const { records } = await api('GET', '/bin');
    list.innerHTML = records.map(r => `
      <div class="m-row" style="align-items:center;gap:10px;flex-wrap:wrap">
        <span>${esc(r.report_date)} · ${esc(r.station)}<br>
          <small style="color:var(--mut)">KES ${fmt(r.gross_revenue)} · moved by ${esc(r.deleted_by || '—')} · ${esc(new Date(r.deleted_at).toLocaleString(LOCALE))}</small></span>
        <span style="display:flex;gap:6px">
          <button class="btn btn-b btn-xs" onclick="restoreFromBin(${Number(r.id)})">↩ Restore</button>
          <button class="btn btn-r btn-xs" onclick="purgeFromBin(${Number(r.id)}, '${esc(r.report_date)}')">Delete for good</button>
        </span>
      </div>`).join('') || '<div class="m-row"><span>The bin is empty.</span></div>';
  } catch (e) {
    list.innerHTML = `<div class="m-row"><span style="color:var(--red)">${esc(e.message)}</span></div>`;
  }
}
function closeBin() { $('binOverlay').classList.remove('open'); }

async function restoreFromBin(id) {
  try {
    await api('POST', '/bin/' + id + '/restore', {});
    toast('↩ Record restored');
    await refreshRecs();
    openBin();
  } catch (e) { toast('⚠️ ' + e.message, true); }
}

async function purgeFromBin(id, date) {
  const ok = await showConfirmModal('Delete for good?', 'The ' + date + ' record will be removed from the bin. Its change history is kept.');
  if (!ok) return;
  try {
    await api('DELETE', '/bin/' + id);
    toast('🗑️ Deleted for good');
    openBin();
  } catch (e) { toast('⚠️ ' + e.message, true); }
}

async function startSession() {
  await loadStations();
  applyUserToUI();
  await syncFromServer();
  flushOutbox();
  refreshAlerts();
  loadCustomers();
  loadRecs();
  renderAnalytics();
  loadRecordForDateAndStation();
}

function openAccount() {
  if (!USER) { showLogin(); return; }
  $('acctName').textContent = displayName(USER);
  $('meFullName').value = USER.full_name || '';
  $('meEmail').value = USER.email || '';
  $('mePhone').value = USER.phone || '';
  $('acctRole').textContent = USER.role === 'admin' ? 'Administrator — all branches'
    : USER.role === 'manager' ? 'Branch Manager — ' + USER.station
    : 'Staff — ' + (USER.station || 'all branches');
  $('usersSec').style.display = USER.role === 'admin' ? 'block' : 'none';
  $('stationsSec').hidden = USER.role !== 'admin';
  if (USER.role === 'admin') renderStationsAdmin();
  ['pwCurrent','pwNew'].forEach(id => $(id).value = '');
  if (USER.role === 'admin') loadUsers();
  $('alertSettingsSec').hidden = USER.role !== 'admin';
  if (USER.role === 'admin') loadAlertSettings();
  $('backupSec').hidden = USER.role !== 'admin';
  if (USER.role === 'admin') loadBackups();
  $('accountOverlay').classList.add('open');
}
function closeAccount() { $('accountOverlay').classList.remove('open'); }

async function saveMyContact() {
  if (!requireOnline('save your email and phone')) return;
  try {
    USER = (await api('POST', '/me/contact', { email: sv('meEmail'), phone: sv('mePhone') })).user;
    storeSet('pk_user', USER);
    $('meEmail').value = USER.email || '';
    $('mePhone').value = USER.phone || '';
    if (USER.role === 'admin') loadUsers();
    toast('✅ Email & phone saved');
  } catch (e) { toast('⚠️ ' + e.message, true); }
}

async function saveMyName() {
  if (!requireOnline('change your name')) return;
  try {
    USER = (await api('POST', '/me/name', { full_name: sv('meFullName') })).user;
    storeSet('pk_user', USER);
    applyUserToUI();
    $('acctName').textContent = displayName(USER);
    toast('✅ Name saved — ' + displayName(USER));
  } catch (e) { toast('⚠️ ' + e.message, true); }
}

async function changePassword() {
  if (!requireOnline('change your password')) return;
  try {
    await api('POST', '/me/password', { current_password: $('pwCurrent').value, new_password: $('pwNew').value });
    ['pwCurrent','pwNew'].forEach(id => $(id).value = '');
    hidePasswords();
    toast('🔑 Password changed');
  } catch (e) { toast('⚠️ ' + e.message, true); }
}

// ── Branches: added by the admin; every branch picker is filled from this list ─
let STATIONS = [];
const STATIONS_KEY = 'pk_stations_v1';

async function loadStations() {
  try {
    STATIONS = (await api('GET', '/stations')).stations || [];
    storeSet(STATIONS_KEY, { user: USER && USER.username, stations: STATIONS });
  } catch (e) {
    const cache = storeGet(STATIONS_KEY);              // offline: the list from the last sync
    STATIONS = cache && USER && cache.user === USER.username ? cache.stations || [] : [];
  }
  renderStationPickers();
}

function renderStationPickers() {
  const opt = n => `<option value="${esc(n)}" translate="no">${esc(n)}</option>`;
  const fill = (id, first) => {
    const sel = $(id), keep = sel.value;
    sel.innerHTML = first + STATIONS.map(opt).join('');
    if (STATIONS.includes(keep) || (keep === '' && first)) sel.value = keep;
  };
  fill('fStation', STATIONS.length ? '' : '<option value="">— No branch yet —</option>');
  fill('filterStation', '<option value="">All Branches</option>');
  fill('nuStation', '<option value="">All branches</option>');
  $('priceStations').innerHTML = STATIONS.map(n =>
    `<label class="chk"><input type="checkbox" name="priceStation" value="${esc(n)}"> <span translate="no">${esc(n)}</span></label>`).join('');
  $('hStation').textContent = sv('fStation') || 'PetroKenya';
  const note = $('noBranchNote');
  note.hidden = !USER || STATIONS.length > 0;
  note.textContent = USER && USER.role === 'admin'
    ? '🏪 No branches yet. Add your first branch under 👤 Account → Branches, then you can start recording.'
    : '🏪 No branches have been set up yet. Ask the admin to add your branch.';
}

let RENAMING = null;   // the branch whose name is being edited in Account → Branches

function renderStationsAdmin() {
  $('stationsList').innerHTML = STATIONS.length
    ? STATIONS.map(n => n === RENAMING
      ? `<div class="m-row" style="gap:8px;flex-wrap:wrap">
          <input type="text" id="rsName" maxlength="60" value="${esc(n)}" style="flex:1;min-width:160px" translate="no"
                 onkeydown="if(event.key==='Enter')renameStation();if(event.key==='Escape')cancelRename()">
          <span style="display:flex;gap:6px"><button class="btn btn-g btn-sm" onclick="renameStation()">Save</button>
          <button class="btn btn-o btn-sm" onclick="cancelRename()">Cancel</button></span></div>`
      : `<div class="m-row"><span translate="no">🏪 ${esc(n)}</span>
        <span style="display:flex;gap:6px">
          <button class="btn btn-o btn-sm" onclick="startRename(this.dataset.name)" data-name="${esc(n)}">✏️ Rename</button>
          <button class="btn btn-r btn-sm" onclick="removeStation(this.dataset.name)" data-name="${esc(n)}">Remove</button>
        </span></div>`).join('')
    : '<div class="m-sub" style="margin:0">No branches yet — add the first one below.</div>';
  if (RENAMING && $('rsName')) { $('rsName').focus(); $('rsName').select(); }
}

function startRename(name) { RENAMING = name; renderStationsAdmin(); }
function cancelRename() { RENAMING = null; renderStationsAdmin(); }

async function renameStation() {
  if (!requireOnline('rename a branch')) return;
  const old = RENAMING;
  try {
    const res = await api('PUT', '/stations/' + encodeURIComponent(old), { name: sv('rsName') });
    RENAMING = null;
    STATIONS = res.stations;
    storeSet(STATIONS_KEY, { user: USER.username, stations: STATIONS });
    // Keep everything that pointed at the old name on the new one
    const onOld = ['fStation', 'filterStation', 'nuStation'].filter(id => $(id).value === old);
    renderStationPickers();
    onOld.forEach(id => { $(id).value = res.station; });
    $('hStation').textContent = sv('fStation') || 'PetroKenya';
    renderStationsAdmin();
    await syncFromServer();
    loadRecs(); loadUsers(); applyUserToUI(); loadRecordForDateAndStation();
    toast(res.station === old ? '✅ Branch name unchanged' : '✅ Branch renamed — ' + old + ' → ' + res.station);
  } catch (e) { toast('⚠️ ' + e.message, true); }
}

async function addStation() {
  if (!requireOnline('add a branch')) return;
  try {
    const res = await api('POST', '/stations', { name: sv('nsName') });
    $('nsName').value = '';
    STATIONS = res.stations;
    storeSet(STATIONS_KEY, { user: USER.username, stations: STATIONS });
    renderStationPickers(); renderStationsAdmin();
    if (STATIONS.length === 1) { applyUserToUI(); loadRecordForDateAndStation(); }
    toast('✅ Branch added — ' + res.station);
  } catch (e) { toast('⚠️ ' + e.message, true); }
}

async function removeStation(name) {
  if (!requireOnline('remove a branch')) return;
  const ok = await showConfirmModal('Remove branch?', 'Remove ' + name + '? This only works while no saved days or users belong to it.');
  if (!ok) return;
  try {
    STATIONS = (await api('DELETE', '/stations/' + encodeURIComponent(name))).stations;
    storeSet(STATIONS_KEY, { user: USER.username, stations: STATIONS });
    renderStationPickers(); renderStationsAdmin(); applyUserToUI(); loadRecordForDateAndStation();
    toast('🗑️ Branch removed — ' + name);
  } catch (e) { toast('⚠️ ' + e.message, true); }
}

let USERS = [], EDITING_CONTACT = null;

async function loadUsers() {
  try {
    USERS = (await api('GET', '/users')).users;
    renderUsers();
  } catch (e) {
    $('usersList').innerHTML = `<div class="m-row"><span style="color:var(--red)">${esc(e.message)}</span></div>`;
  }
}

function renderUsers() {
  const list = $('usersList');
  {
    const users = USERS;
    list.innerHTML = users.map(u => u.id === EDITING_CONTACT ? `
      <div class="m-row" style="flex-wrap:wrap;gap:8px">
        <span style="width:100%" translate="no">${esc(displayName(u))} — email &amp; phone for password resets</span>
        <input type="email" id="ucEmail" value="${esc(u.email || '')}" placeholder="Email" style="flex:1;min-width:150px">
        <input type="tel" id="ucPhone" value="${esc(u.phone || '')}" placeholder="Phone, e.g. 0712 345 678" style="flex:1;min-width:150px">
        <span style="display:flex;gap:6px"><button class="btn btn-g btn-sm" onclick="saveUserContact(${u.id})">Save</button>
        <button class="btn btn-o btn-sm" onclick="EDITING_CONTACT=null;renderUsers()">Cancel</button></span>
      </div>` : `
      <div class="m-row" style="align-items:center;gap:8px">
        <span translate="no">${esc(displayName(u))} <small style="color:var(--mut)">· ${u.full_name ? esc(u.username) + ' · ' : ''}${esc(u.role)}${u.station ? ' · ' + esc(u.station) : ''}${u.email ? ' · ✉️' : ''}${u.phone ? ' · 📱' : ''}</small></span>
        <span style="display:flex;gap:6px">
          <button class="btn btn-o btn-xs" title="Email &amp; phone for password resets" onclick="EDITING_CONTACT=${u.id};renderUsers()">📇</button>
          <button class="btn btn-o btn-xs" title="Reset password" onclick="resetUserPassword(${u.id}, '${esc(u.username)}')">🔑</button>
          ${u.id === USER.id ? '' : `<button class="btn btn-o btn-xs" title="Sign out on every device" onclick="signOutUser(${u.id}, '${esc(u.username)}')">⎋</button>`}
          ${u.id === USER.id ? '' : `<button class="btn btn-r btn-xs" onclick="deleteUser(${u.id}, '${esc(u.username)}')">✕</button>`}
        </span>
      </div>`).join('');
  }
}

async function saveUserContact(id) {
  if (!requireOnline('save contact details')) return;
  try {
    await api('PUT', '/users/' + id + '/contact', { email: sv('ucEmail'), phone: sv('ucPhone') });
    EDITING_CONTACT = null;
    toast('✅ Email & phone saved');
    loadUsers();
  } catch (e) { toast('⚠️ ' + e.message, true); }
}

async function addUser() {
  if (!requireOnline('add users')) return;
  try {
    await api('POST', '/users', {
      username: sv('nuName'), password: $('nuPass').value, full_name: sv('nuFullName'),
      role: sv('nuRole'), station: sv('nuStation'), email: sv('nuEmail'), phone: sv('nuPhone')
    });
    toast('✅ User ' + sv('nuName') + ' added');
    ['nuName','nuPass','nuFullName','nuEmail','nuPhone'].forEach(id => $(id).value = '');
    hidePasswords();
    loadUsers();
  } catch (e) { toast('⚠️ ' + e.message, true); }
}

async function resetUserPassword(id, name) {
  const password = prompt('New password for ' + name + ' (at least 8 characters):');
  if (!password) return;
  try {
    await api('POST', '/users/' + id + '/password', { password });
    toast('🔑 Password reset for ' + name);
  } catch (e) { toast('⚠️ ' + e.message, true); }
}

async function deleteUser(id, name) {
  const ok = await showConfirmModal('Delete user?', name + ' will no longer be able to sign in.');
  if (!ok) return;
  try {
    await api('DELETE', '/users/' + id);
    toast('🗑️ User ' + name + ' deleted');
    loadUsers();
  } catch (e) { toast('⚠️ ' + e.message, true); }
}

let COMP = {};   // last computed values
let RECS = [];   // saved records
let INVOICES = []; // today's credit invoices (customer, car reg, phone, company)
let MISC_ITEMS = []; // today's itemised miscellaneous expenses (name, amount)
let GAS_ITEMS = [];  // today's itemised gases & lubricants sales (name, category, qty, price)
let DELIVERIES = []; // today's fuel deliveries (fuel, supplier, note, truck, ordered, received, dips)
let ATTENDANTS = []; // today's cash per attendant (name, expected sales, cash, M-Pesa)
let CUSTOMERS = [];  // credit accounts, for the invoice form
let RECEIPTS = [];   // today's receipt photos (label, amount, upload_id)

// ── Main computation — mirrors C++ engine exactly ────────────────────────────
function compute() {
  // Gases & Lubricants (itemised revenue)
  const gasLubeRev = r2(GAS_ITEMS.reduce((sum, i) => sum + (i.qty * i.price), 0));
  const gasRevOnly  = r2(GAS_ITEMS.filter(i => i.category === 'Gas').reduce((s,i)=>s+(i.qty*i.price),0));
  const lubeRevOnly = r2(GAS_ITEMS.filter(i => i.category === 'Lubricant').reduce((s,i)=>s+(i.qty*i.price),0));

  // Fuel
  const PM = fuelMeters('petrol'), DM = fuelMeters('diesel'), KM = fuelMeters('kero');
  const pL = PM.litres, dL = DM.litres, kL = KM.litres;
  const pRev = r2(pL * fv('pPrice')), dRev = r2(dL * fv('dPrice')), kRev = r2(kL * fv('kPrice'));
  const pFC  = r2(pL * fv('pCost')),  dFC  = r2(dL * fv('dCost')),  kFC  = r2(kL * fv('kCost'));
  const pMgn = r2(pRev - pFC), dMgn = r2(dRev - dFC), kMgn = r2(kRev - kFC);
  const totalL   = r2(pL + dL + kL);
  const grossRev = r2(pRev + dRev + kRev + gasLubeRev);
  const totalFC  = r2(pFC + dFC + kFC);

  // Pump sales meter (the pump's own KES counter) — cross-check against calculated revenue
  const pPumpSales = PM.sales, dPumpSales = DM.sales, kPumpSales = KM.sales;
  const totalPumpSales = r2(pPumpSales + dPumpSales + kPumpSales);
  const pPumpVariance = r2(pRev - pPumpSales);
  const dPumpVariance = r2(dRev - dPumpSales);
  const kPumpVariance = r2(kRev - kPumpSales);
  const pumpHasData = PM.hasSales || DM.hasSales || KM.hasSales;

  // Tank dip reconciliation: Expected Stock = Opening Dip + Deliveries − Litres Sold (pump meters)
  const pDipOpen = fv('pDipOpen'), pDelivered = fv('pDelivered'), pDipClose = fv('pDipClose');
  const dDipOpen = fv('dDipOpen'), dDelivered = fv('dDelivered'), dDipClose = fv('dDipClose');
  const kDipOpen = fv('kDipOpen'), kDelivered = fv('kDelivered'), kDipClose = fv('kDipClose');

  const pExpectedStock = r2(pDipOpen + pDelivered - pL);
  const dExpectedStock = r2(dDipOpen + dDelivered - dL);
  const kExpectedStock = r2(kDipOpen + kDelivered - kL);

  const pDipVariance = r2(pDipClose - pExpectedStock);
  const dDipVariance = r2(dDipClose - dExpectedStock);
  const kDipVariance = r2(kDipClose - kExpectedStock);

  // A variance only means something once the closing dip has been taken
  const pDipHasData = pDipClose > 0;
  const dDipHasData = dDipClose > 0;
  const kDipHasData = kDipClose > 0;

  // Payments
  const mpesa = fv('fMpesa'), cash = fv('fCash');
  const credit = fv('fCredit'), card = fv('fCard');
  const collected = r2(mpesa + cash + credit + card);
  const variance  = r2(grossRev - collected);
  const mpesaPct  = grossRev > 0 ? r2(mpesa / grossRev * 100) : 0;
  const cashPct   = grossRev > 0 ? r2(cash  / grossRev * 100) : 0;
  const otherPct  = grossRev > 0 ? r2((credit+card) / grossRev * 100) : 0;
  const float_ = fv('fFloat'), banked = fv('fBanked');
  const tillBal = r2(cash + float_ - banked);

  // Expenses
  const totalExp = r2(fv('eWages')+fv('eElec')+fv('eWater')+fv('eMaint')+fv('eLubes')+fv('eMisc'));

  // Profit
  const totalCost  = r2(totalFC + totalExp);
  const netProfit  = r2(grossRev - totalCost);
  const profitMgn  = grossRev > 0 ? r2(netProfit / grossRev * 100) : 0;
  const revPerL    = totalL > 0 ? r2(grossRev / totalL) : 0;
  const profitPerL = totalL > 0 ? r2(netProfit / totalL) : 0;

  // KRA Tax
  const exVat      = r2(grossRev / (1 + VAT));
  const outputVAT  = r2(grossRev - exVat);
  const excP = r2(pL * EX_P), excD = r2(dL * EX_D), excK = r2(kL * EX_K);
  const totalExcise = r2(excP + excD + excK);
  const rlP = r2(pL * RL_P), rlD = r2(dL * RL_D);
  const totalTax  = r2(outputVAT + totalExcise);

  return {
    pL,dL,kL,totalL,pRev,dRev,kRev,pFC,dFC,kFC,pMgn,dMgn,kMgn,
    gasLubeRev,gasRevOnly,lubeRevOnly,
    pPumpSales,dPumpSales,kPumpSales,totalPumpSales,
    pPumpVariance,dPumpVariance,kPumpVariance,pumpHasData,
    pExpectedStock,dExpectedStock,kExpectedStock,
    pDipVariance,dDipVariance,kDipVariance,
    pDipHasData,dDipHasData,kDipHasData,
    grossRev,totalFC,totalExp,totalCost,netProfit,profitMgn,revPerL,profitPerL,
    mpesa,cash,credit,card,collected,variance,mpesaPct,cashPct,otherPct,tillBal,
    exVat,outputVAT,excP,excD,excK,totalExcise,rlP,rlD,totalTax
  };
}

let debounceTimer = null;
function calc() {
  clearTimeout(debounceTimer);
  setStatus('calc');
  debounceTimer = setTimeout(() => {
    COMP = compute();
    updateUI();
    checkOpenings();
    setStatus('ok');
  }, 120);
}

// ── Update every UI element ───────────────────────────────────────────────────
// ── Show/hide and colour the pump-sales-meter cross-check row for one fuel ────
function updatePumpCheckRow(prefix, pumpSales, variance, hasData) {
  const row = $(prefix + 'PumpCheckRow');
  if (!row) return;

  if (!hasData) {
    row.style.display = 'none';
    return;
  }
  row.style.display = 'flex';

  $(prefix + 'PumpSales').textContent = 'KES ' + fmt(pumpSales);

  const varEl = $(prefix + 'PumpVariance');
  const labelEl = $(prefix + 'PumpVarianceLabel');
  varEl.textContent = 'KES ' + fmt(variance);

  if (Math.abs(variance) < 1) {
    labelEl.textContent = '✅ Matches Pump: ';
    varEl.style.color = 'var(--acc)';
  } else if (Math.abs(variance) < 50) {
    labelEl.textContent = '⚠️ Variance: ';
    varEl.style.color = 'var(--acc2)';
  } else {
    labelEl.textContent = '🚨 Variance: ';
    varEl.style.color = 'var(--red)';
  }
}

// ── Show/hide and colour the tank dip reconciliation row for one fuel ────────
function updateDipRow(prefix, sold, expectedStock, variance, hasData) {
  const soldEl = $(prefix + 'DipSold');
  const expEl  = $(prefix + 'DipExpected');
  if (soldEl) soldEl.textContent = fmtL(sold) + ' L';
  if (expEl)  expEl.textContent  = fmtL(expectedStock) + ' L';

  const row = $(prefix + 'DipVarianceRow');
  if (!row) return;

  if (!hasData) {
    row.style.display = 'none';
    return;
  }
  row.style.display = 'flex';

  const varEl = $(prefix + 'DipVariance');
  const labelEl = $(prefix + 'DipVarianceLabel');
  varEl.textContent = fmtL(variance) + ' L';

  if (Math.abs(variance) < 10) {
    labelEl.textContent = '✅ Within Tolerance: ';
    varEl.style.color = 'var(--acc)';
  } else if (variance < 0) {
    labelEl.textContent = '🚨 Stock Short (possible leak/theft): ';
    varEl.style.color = 'var(--red)';
  } else {
    labelEl.textContent = '⚠️ Stock Surplus: ';
    varEl.style.color = 'var(--acc2)';
  }
}

function updateUI() {
  const c = COMP;

  // Fuel tab
  $('pLit').textContent = fmtL(c.pL)+' L'; $('pRev').textContent = 'KES '+fmt(c.pRev); $('pMgn').textContent = 'KES '+fmt(c.pMgn);
  $('dLit').textContent = fmtL(c.dL)+' L'; $('dRev').textContent = 'KES '+fmt(c.dRev); $('dMgn').textContent = 'KES '+fmt(c.dMgn);
  $('kLit').textContent = fmtL(c.kL)+' L'; $('kRev').textContent = 'KES '+fmt(c.kRev); $('kMgn').textContent = 'KES '+fmt(c.kMgn);
  $('pPriceTag').textContent = fv('pPrice').toFixed(2);
  $('dPriceTag').textContent = fv('dPrice').toFixed(2);
  $('kPriceTag').textContent = fv('kPrice').toFixed(2);

  // Pump sales meter cross-check rows (only shown once sales-meter values are entered)
  updatePumpCheckRow('p', c.pPumpSales, c.pPumpVariance, fuelMeters('petrol').hasSales);
  updatePumpCheckRow('d', c.dPumpSales, c.dPumpVariance, fuelMeters('diesel').hasSales);
  updatePumpCheckRow('k', c.kPumpSales, c.kPumpVariance, fuelMeters('kero').hasSales);
  // Litres each pump sold, beside its name
  PUMPS.forEach(([id]) => {
    const litres = pumpMoved(id, '');
    $('pump_' + id + '_sold').textContent = litres > 0 ? fmtL(litres) + ' L sold' : '';
  });

  // Tank dip reconciliation rows
  updateDipRow('p', c.pL, c.pExpectedStock, c.pDipVariance, c.pDipHasData);
  updateDipRow('d', c.dL, c.dExpectedStock, c.dDipVariance, c.dDipHasData);
  updateDipRow('k', c.kL, c.kExpectedStock, c.kDipVariance, c.kDipHasData);

  // Summary cards
  $('cRev').textContent   = 'KES '+fmt(c.grossRev);
  $('cRevSub').textContent= c.gasLubeRev > 0
    ? `Fuel: KES ${fmt(c.pRev+c.dRev+c.kRev)} + Gas/Lube: KES ${fmt(c.gasLubeRev)}`
    : `P: ${fmtL(c.pL)}L | D: ${fmtL(c.dL)}L | K: ${fmtL(c.kL)}L`;
  $('cLit').textContent   = fmt(c.totalL);
  $('cLitSub').textContent= `Petrol ${fmtL(c.pL)}L · Diesel ${fmtL(c.dL)}L · Kero ${fmtL(c.kL)}L`;
  $('cMpesa').textContent = 'KES '+fmt(c.mpesa);
  $('cMpesaSub').textContent = `${c.mpesaPct.toFixed(1)}% of sales · ${fv('fMpesaTxn')|0} txns`;
  $('cCash').textContent  = 'KES '+fmt(c.cash);
  $('cExp').textContent   = 'KES '+fmt(c.totalExp);
  $('cExpSub').textContent= `Wages+Util+Misc: KES ${fmt(c.totalExp)}`;
  $('cProfit').textContent= 'KES '+fmt(c.netProfit);
  $('cMarginSub').textContent = `Margin: ${c.profitMgn.toFixed(1)}%`;
  $('cTax').textContent   = 'KES '+fmt(c.totalTax);
  $('cTaxSub').textContent= `VAT: KES ${fmt(c.outputVAT)} | Excise: KES ${fmt(c.totalExcise)}`;
  $('cRevPerL').textContent = 'KES '+fmt(c.revPerL);
  $('cProfPerL').textContent = `Profit/L: KES ${fmt(c.profitPerL)}`;

  // Profit card colour
  $('profCard').style.setProperty('--c', c.netProfit >= 0 ? '#b57bee' : '#e05252');

  // Profit box
  $('pvRev').textContent  = 'KES '+fmt(c.grossRev);
  $('pvFuelCost').textContent = '− KES '+fmt(c.totalFC);
  $('pvExpenses').textContent = '− KES '+fmt(c.totalExp);
  $('pvProfit').textContent = 'KES '+fmt(c.netProfit);
  $('pvProfit').style.color = c.netProfit >= 0 ? 'var(--acc)' : 'var(--red)';
  $('pvMargin').textContent = `Margin: ${c.profitMgn.toFixed(1)}%`;

  // Variance
  const vb = $('varBar');
  if (Math.abs(c.variance) < 0.5) {
    vb.className = 'var-bar ok';
    vb.textContent = `✅ Sales vs Collected: Balanced (KES ${fmt(c.variance)})`;
  } else if (Math.abs(c.variance) < 10000) {
    vb.className = 'var-bar warn';
    vb.textContent = `⚠️ Variance: KES ${fmt(c.variance)} — Check credit/card entries`;
  } else {
    vb.className = 'var-bar bad';
    vb.textContent = `🚨 Large Variance: KES ${fmt(c.variance)} — Investigate discrepancy`;
  }

  // Payments tab
  $('pMpesaPct').textContent = c.mpesaPct.toFixed(1)+'%';
  $('pCashPct').textContent  = c.cashPct.toFixed(1)+'%';
  $('pOtherPct').textContent = c.otherPct.toFixed(1)+'%';
  $('pCollected').textContent = 'KES '+fmt(c.collected);
  $('fTillBal').value = c.tillBal.toFixed(2);

  // Expenses tab
  $('eTotalDisp').textContent = 'KES '+fmt(c.totalExp);
  $('eRevPerL').textContent   = 'KES '+fmt(c.revPerL);
  $('eProfPerL').textContent  = 'KES '+fmt(c.profitPerL);
  $('eProfPerL').style.color  = c.profitPerL >= 0 ? 'var(--acc)' : 'var(--red)';
  $('eSalesRef').textContent  = 'KES '+fmt(c.grossRev);
  $('eExpRef').textContent    = 'KES '+fmt(c.totalExp);
  $('eSalesAfterExp').textContent = 'KES '+fmt(r2(c.grossRev - c.totalExp));
  $('eSalesAfterExp').style.color = (c.grossRev - c.totalExp) >= 0 ? 'var(--acc)' : 'var(--red)';

  // KRA tab
  $('kExVat').textContent  = 'KES '+fmt(c.exVat);
  $('kVat').textContent    = 'KES '+fmt(c.outputVAT);
  $('kInclVat').textContent= 'KES '+fmt(c.grossRev);
  $('kExcP').textContent   = 'KES '+fmt(c.excP);
  $('kExcD').textContent   = 'KES '+fmt(c.excD);
  $('kExcK').textContent   = 'KES '+fmt(c.excK);
  $('kRLP').textContent    = 'KES '+fmt(c.rlP);
  $('kRLD').textContent    = 'KES '+fmt(c.rlD);
  $('kTotalTax').textContent = 'KES '+fmt(c.totalTax);
}

// ── Status pill ───────────────────────────────────────────────────────────────
function setStatus(s) {
  const el = $('enginePill');
  if (s === 'ok') {
    el.className = 'status-pill ok';
    el.innerHTML = '<span class="dot pulse"></span> Engine Active';
  } else if (s === 'calc') {
    el.className = 'status-pill calc';
    el.innerHTML = '<span class="spin"></span> Calculating…';
  }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
// ── Receipt photos ────────────────────────────────────────────────────────────
// Shrink a phone photo to at most 1600px on the long side as a JPEG before upload
function shrinkPhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a photo')); };
    img.src = url;
  });
}

async function addReceipt() {
  const file = $('rcFile').files[0];
  if (!file) { toast('⚠️ Choose or take a photo first', true); return; }
  if (!requireOnline('upload photos')) return;
  const btn = $('rcBtn');
  btn.disabled = true; btn.textContent = 'Uploading…';
  try {
    const data = await shrinkPhoto(file);
    const up = await api('POST', '/uploads', { data, station: sv('fStation') });
    RECEIPTS.push({ id: Date.now(), label: sv('rcLabel'), amount: fv('rcAmount'), upload_id: up.id });
    $('rcFile').value = ''; $('rcAmount').value = '';
    renderReceipts();
    toast('📷 Photo added — click 💾 Save to keep it with this day');
  } catch (e) {
    toast('⚠️ ' + e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = '📷 Add Photo';
  }
}

function deleteReceipt(id) {
  RECEIPTS = RECEIPTS.filter(r => r.id !== id);
  renderReceipts();
}

const receiptTile = (r, canDelete) => {
  // The website preview keeps photos in the browser and supplies its own address for them
  const src = window.pkUploadUrl ? window.pkUploadUrl(r.upload_id) : '/api/uploads/' + encodeURIComponent(r.upload_id);
  return `<div class="receipt">
    <a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="${esc(r.label)}" loading="lazy"></a>
    <div class="cap"><span title="${esc(r.label)}">${esc(r.label)}${r.amount ? ' · KES ' + fmt(r.amount) : ''}</span>
      ${canDelete ? `<button class="btn btn-r btn-xs" onclick="deleteReceipt(${Number(r.id)})">✕</button>` : ''}</div>
  </div>`;
};

function renderReceipts() {
  const list = $('receiptsList');
  if (!list) return;
  list.innerHTML = RECEIPTS.length ? RECEIPTS.map(r => receiptTile(r, true)).join('')
    : '<div style="font-family:var(--mono);font-size:.74rem;color:var(--mut)">No photos for this day yet.</div>';
}

// ── Cash per attendant ────────────────────────────────────────────────────────
function addAttendant() {
  const name = sv('atName');
  if (!name) { toast('⚠️ Enter the attendant\'s name', true); $('atName').focus(); return; }
  ATTENDANTS.push({ id: Date.now(), name, expected: fv('atExpected'), cash: fv('atCash'), mpesa: fv('atMpesa') });
  ['atName','atExpected','atCash','atMpesa'].forEach(id => $(id).value = '');
  renderAttendants();
  $('atName').focus();
}

function deleteAttendant(id) {
  ATTENDANTS = ATTENDANTS.filter(a => a.id !== id);
  renderAttendants();
}

function renderAttendants() {
  const list = $('attendantsList');
  if (!list) return;
  let short = 0, over = 0;
  list.innerHTML = ATTENDANTS.length ? ATTENDANTS.map(a => {
    const diff = (a.cash || 0) + (a.mpesa || 0) - (a.expected || 0);
    if (diff < 0) short -= diff; else over += diff;
    const state = Math.abs(diff) < 1 ? '<b class="ok">Balanced</b>'
      : diff < 0 ? `<b class="bad">Short KES ${fmt(-diff)}</b>` : `<b>Over KES ${fmt(diff)}</b>`;
    return `<div class="item-row">
      <span class="grow"><b translate="no">${esc(a.name)}</b><br><small>${t("Sales")} KES ${fmt(a.expected)} · ${t("Cash")} KES ${fmt(a.cash)} · M-Pesa KES ${fmt(a.mpesa)}</small></span>
      <span>${state}</span>
      <button class="btn btn-r btn-xs" onclick="deleteAttendant(${Number(a.id)})">✕</button>
    </div>`;
  }).join('') : '<div style="font-family:var(--mono);font-size:.74rem;color:var(--mut)">No attendants added for this day.</div>';
  $('atCount').textContent = ATTENDANTS.length;
  $('atShort').textContent = 'KES ' + fmt(short);
  $('atOver').textContent = 'KES ' + fmt(over);
  // Suggest names used on earlier days
  const names = [...new Set(RECS.flatMap(r => (r.attendants || []).map(a => a.name)).filter(Boolean))].sort();
  $('atNames').innerHTML = names.map(n => `<option value="${esc(n)}"></option>`).join('');
}

// ── Credit accounts ───────────────────────────────────────────────────────────
async function loadCustomers() {
  if (!USER || !ONLINE) return;
  try { CUSTOMERS = (await api('GET', '/customers')).customers; } catch (e) { return; }
  const sel = $('invAccount'), keep = sel.value;
  sel.innerHTML = '<option value="">— No account (one-off) —</option>' + CUSTOMERS.map(c =>
    `<option value="${Number(c.id)}" translate="no">${esc(c.name)}${c.company ? ' · ' + esc(c.company) : ''}</option>`).join('');
  sel.value = keep;
}

function pickInvoiceAccount() {
  const c = CUSTOMERS.find(x => String(x.id) === sv('invAccount'));
  if (!c) { $('invAccountNote').textContent = ''; return; }
  $('invCustomer').value = c.name; $('invCompany').value = c.company || ''; $('invPhone').value = c.phone || '';
  $('invAccountNote').textContent = `Balance KES ${fmt(c.balance)}` + (c.credit_limit ? ` of KES ${fmt(c.credit_limit)} limit` : ' · no limit set');
}

async function renderCreditPage() {
  await loadCustomers();
  const owed = CUSTOMERS.reduce((s, c) => s + Math.max(0, c.balance), 0);
  $('creditTotals').textContent = `${CUSTOMERS.length} account${CUSTOMERS.length === 1 ? '' : 's'} · KES ${fmt(owed)} owed`;
  $('customersBody').innerHTML = CUSTOMERS.length ? CUSTOMERS.map(c => `
    <tr style="cursor:pointer" onclick="openStatement(${Number(c.id)})">
      <td translate="no">${esc(c.name)}</td><td translate="no">${esc(c.company || '—')}</td><td translate="no">${esc(c.phone || '—')}</td>
      <td class="num ${c.over_limit ? 'bad' : ''}">KES ${fmt(c.balance)}</td>
      <td class="num">${c.credit_limit ? 'KES ' + fmt(c.credit_limit) : '—'}</td>
      <td>${c.over_limit ? '<span class="badge br">Over limit</span>' : ''}</td>
    </tr>`).join('')
    : `<tr><td colspan="6" style="color:var(--mut)">${ONLINE ? 'No credit accounts yet — add one below.' : 'Credit accounts need an internet connection.'}</td></tr>`;
}

async function addCustomer() {
  if (!requireOnline('add a credit account')) return;
  try {
    const { customer } = await api('POST', '/customers', { name: sv('ncName'), company: sv('ncCompany'),
      phone: sv('ncPhone'), credit_limit: fv('ncLimit') });
    ['ncName','ncCompany','ncPhone','ncLimit'].forEach(id => $(id).value = '');
    toast('✅ Account added for ' + customer.name);
    renderCreditPage();
  } catch (e) { toast('⚠️ ' + e.message, true); }
}

let STATEMENT_ID = null;

async function openStatement(id) {
  STATEMENT_ID = id;
  $('payDate').value = todayLocal(); $('payDate').max = todayLocal();
  $('stBody').innerHTML = '<tr><td colspan="6">Loading…</td></tr>';
  $('statementOverlay').classList.add('open');
  try {
    const { customer, entries } = await api('GET', '/customers/' + id + '/statement');
    $('stName').textContent = customer.name;
    $('stSub').textContent = [customer.company, customer.phone].filter(Boolean).join(' · ') +
      ` — balance KES ${fmt(customer.balance)}` + (customer.credit_limit ? ` · limit KES ${fmt(customer.credit_limit)}` : '');
    $('stLimitSec').hidden = !canApprove();
    $('stLimit').value = customer.credit_limit || ''; $('stPhone').value = customer.phone || '';
    const isAdmin = USER && USER.role === 'admin';
    $('stBody').innerHTML = entries.length ? entries.map(e => `<tr>
      <td>${esc(e.date)}</td>
      <td class="num ${e.amount < 0 ? 'ok' : ''}">${e.amount < 0 ? '− ' : ''}KES ${fmt(Math.abs(e.amount))}</td>
      <td class="num">KES ${fmt(e.balance)}</td>
      <td translate="no">${e.type === 'invoice' ? '🧾 ' : '💵 '}${esc(e.detail || (e.type === 'invoice' ? 'Invoice' : 'Payment'))}</td>
      <td translate="no">${esc(e.station || '—')}</td>
      <td>${e.type === 'payment' && isAdmin ? `<button class="btn btn-r btn-xs" title="Void this payment" onclick="voidPayment(${Number(e.payment_id)})">✕</button>` : ''}</td>
    </tr>`).join('') : '<tr><td colspan="6" style="color:var(--mut)">No invoices or payments yet.</td></tr>';
  } catch (e) {
    $('stBody').innerHTML = `<tr><td colspan="6" style="color:var(--red)">${esc(e.message)}</td></tr>`;
  }
}
function closeStatement() { $('statementOverlay').classList.remove('open'); STATEMENT_ID = null; }

async function recordPayment() {
  if (!requireOnline('record a payment')) return;
  try {
    await api('POST', '/customers/' + STATEMENT_ID + '/payments', { amount: fv('payAmount'),
      method: sv('payMethod'), reference: sv('payRef'), paid_on: sv('payDate'), station: sv('fStation') });
    ['payAmount','payRef'].forEach(id => $(id).value = '');
    toast('💵 Payment recorded');
    openStatement(STATEMENT_ID);
    renderCreditPage();
  } catch (e) { toast('⚠️ ' + e.message, true); }
}

async function voidPayment(pid) {
  const ok = await showConfirmModal('Void this payment?', 'It will no longer count towards the balance. The record of it is kept.');
  if (!ok) return;
  try {
    await api('POST', '/payments/' + pid + '/void', {});
    toast('Payment voided');
    openStatement(STATEMENT_ID);
    renderCreditPage();
  } catch (e) { toast('⚠️ ' + e.message, true); }
}

async function saveCustomer() {
  try {
    await api('PUT', '/customers/' + STATEMENT_ID, { credit_limit: fv('stLimit'), phone: sv('stPhone') });
    toast('✅ Account updated');
    openStatement(STATEMENT_ID);
    renderCreditPage();
  } catch (e) { toast('⚠️ ' + e.message, true); }
}

// Print just the open pop-up (e.g. a customer statement)
function printModal() {
  document.body.classList.add('print-modal');
  window.print();
  setTimeout(() => document.body.classList.remove('print-modal'), 500);
}

// ── Alerts (managers and admins) ──────────────────────────────────────────────
let ALERTS = [];

async function refreshAlerts() {
  if (!canApprove() || !ONLINE) return;
  try {
    const res = await api('GET', '/alerts');
    ALERTS = res.alerts;
    const badge = $('alertCount');
    badge.textContent = res.unread > 99 ? '99+' : res.unread;
    badge.hidden = !res.unread;
    if (!$('alertsOverlay').classList.contains('open')) return;
    renderAlerts();
  } catch (e) { /* the bell just stays as it was */ }
}

function renderAlerts() {
  $('alertsList').innerHTML = ALERTS.length ? ALERTS.map(a => `
    <div class="alert-item ${a.read ? '' : 'unread'}" style="cursor:pointer" onclick="openAlertRecord(${Number(a.record_id)})">
      <div><div class="alert-title">${esc(a.title)}</div>${esc(a.message)}
        <div class="alert-meta">${esc(new Date(a.created_at).toLocaleString(LOCALE))}${a.emailed ? ' · emailed' : ''}</div></div>
    </div>`).join('') : '<div class="m-row"><span>No open alerts. 👍</span></div>';
}

async function openAlerts() {
  $('alertsOverlay').classList.add('open');
  renderAlerts();
  await refreshAlerts();
  renderAlerts();
}
function closeAlerts() { $('alertsOverlay').classList.remove('open'); }

async function markAlertsRead() {
  try { await api('POST', '/alerts/read', { all: true }); } catch (e) { toast('⚠️ ' + e.message, true); return; }
  await refreshAlerts();
  renderAlerts();
}

function openAlertRecord(id) {
  if (!RECS.some(r => Number(r.id) === id)) { toast('That day is no longer in the records', true); return; }
  closeAlerts();
  openDetail(null, id);
}

// Check for new alerts every two minutes while the app is open
setInterval(() => { if (document.visibilityState === 'visible' && USER) refreshAlerts(); }, 120000);

// ── Alert settings (admin, in the Account window) ────────────────────────────
const ALERT_FIELDS = { asDip: 'dip_shortage_litres', asCash: 'cash_shortage_kes', asAttendant: 'attendant_shortage_kes',
  asDelivery: 'short_delivery_litres', asLowPetrol: 'low_stock_petrol', asLowDiesel: 'low_stock_diesel', asLowKero: 'low_stock_kero' };

async function loadAlertSettings() {
  try {
    const { settings, email_configured } = await api('GET', '/settings');
    Object.entries(ALERT_FIELDS).forEach(([id, key]) => { $(id).value = settings[key]; });
    $('asEmails').value = settings.alert_emails || '';
    $('asEmailState').textContent = email_configured
      ? '✉️ Email sending is set up on the server.'
      : '✉️ Email sending is not set up on the server yet — alerts still show in the app (see README: PK_SMTP_*).';
  } catch (e) { /* section stays empty */ }
}

async function saveAlertSettings() {
  const body = { alert_emails: sv('asEmails') };
  Object.entries(ALERT_FIELDS).forEach(([id, key]) => { body[key] = fv(id); });
  try {
    await api('PUT', '/settings', body);
    toast('✅ Alert settings saved');
  } catch (e) { toast('⚠️ ' + e.message, true); }
}

async function testAlertEmail() {
  try {
    const { sent_to } = await api('POST', '/settings/test-email', {});
    toast('✉️ Test email sent to ' + sent_to.join(', '));
  } catch (e) { toast('⚠️ ' + e.message, true); }
}

// ── Backups (admin) ───────────────────────────────────────────────────────────
const fmtWhen = iso => new Date(iso).toLocaleString(LOCALE, { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short',
  hour: '2-digit', minute: '2-digit' });

async function loadBackups() {
  let res;
  try { res = await api('GET', '/backups'); }
  catch (e) { $('bkState').textContent = ONLINE ? e.message : 'Backups need an internet connection.'; return; }
  $('bkEmails').value = res.backup_emails || '';
  const newest = res.backups[0];
  const last = res.last_email;
  $('bkState').innerHTML = [
    newest ? `✅ Last backup: ${esc(fmtWhen(newest.at))}. A new one is made every night; the latest 14 are kept on the server.`
      : '⚠️ No backup yet — the first one is made within a few minutes of the server starting.',
    !res.email_configured ? '✉️ Email isn\'t set up on the server, so backups are not emailed yet (see README: PK_SMTP_*).'
      : !res.backup_emails ? '✉️ Add an email address below so a copy of each night\'s backup leaves the server.'
      : last ? (last.ok ? `✉️ Last emailed ${esc(fmtWhen(last.at))} to ${esc(last.to.join(', '))}.`
                        : `⚠️ The last backup email failed: ${esc(last.error || 'unknown error')}`)
      : '✉️ Each night\'s backup is emailed to the addresses below.',
  ].map(line => `<div>${line}</div>`).join('');
  $('bkList').innerHTML = res.backups.map(b => `<div class="m-row"><span>${esc(fmtWhen(b.at))} · ${fmt(b.size / 1024)} KB</span>
    <a class="btn btn-o btn-sm" href="/api/backups/${encodeURIComponent(b.name)}" download>⬇️ Download</a></div>`).join('');
}

async function saveBackupEmails() {
  try { await api('PUT', '/settings', { backup_emails: sv('bkEmails') }); toast('✅ Backup email saved'); loadBackups(); }
  catch (e) { toast('⚠️ ' + e.message, true); }
}

async function backupNow() {
  try {
    const { backup } = await api('POST', '/backups', {});
    toast('✅ Backup made — ' + backup.name);
    await loadBackups();
    if (window.pkPreview) return;                            // the website preview has no files to hand out
    const link = document.createElement('a');                // and hand the owner a copy
    link.href = '/api/backups/' + encodeURIComponent(backup.name); link.download = backup.name;
    document.body.appendChild(link); link.click(); link.remove();
  } catch (e) { toast('⚠️ ' + e.message, true); }
}

async function emailBackupNow() {
  try {
    const { sent_to } = await api('POST', '/backups/email', {});
    toast('✉️ Backup emailed to ' + sent_to.join(', '));
  } catch (e) { toast('⚠️ ' + e.message, true); }
  loadBackups();
}

// ── Monthly report ────────────────────────────────────────────────────────────
const REPORT_COLUMNS = ['days', 'approved_days', 'total_litres', 'gross_revenue', 'net_profit', 'total_expenses',
  'total_tax', 'mpesa_amount', 'cash_amount', 'credit_amount', 'collection_variance', 'attendant_shortage_total',
  'dip_variance_total', 'delivery_shortfall_litres', 'flagged_days'];

async function renderReport() {
  if (!$('repMonth').value) $('repMonth').value = todayLocal().slice(0, 7);
  const month = $('repMonth').value;
  $('repBody').innerHTML = '<tr><td>Loading…</td></tr>';
  let rep;
  try { rep = await api('GET', '/reports/monthly?month=' + month); }
  catch (e) { $('repBody').innerHTML = `<tr><td>${esc(ONLINE ? e.message : 'Reports need an internet connection.')}</td></tr>`; return; }
  const labels = Object.fromEntries(rep.fields.map(f => [f.key, f.label]));
  Object.assign(labels, { days: 'Days recorded', approved_days: 'Days approved', flagged_days: 'Days flagged ⚠️' });
  const t = rep.totals;
  $('repCards').innerHTML = [
    ['Total Sales', 'KES ' + fmt(t.gross_revenue), '#3ecf32'], ...(seesProfit() ? [['Net Profit', 'KES ' + fmt(t.net_profit), '#b57bee']] : []),
    ['Litres Sold', fmt(t.total_litres) + ' L', '#5bb8e0'], ['Days Approved', `${t.approved_days} of ${t.days}`, '#f5c518'],
  ].map(([l, v, col]) => `<div class="card" style="--c:${col}"><div class="card-lbl">${l}</div><div class="card-val">${esc(v)}</div></div>`).join('');
  const cell = (row, k) => {
    const v = row[k];
    return ['days', 'approved_days', 'flagged_days'].includes(k) ? v : fmt(v);
  };
  // Columns the server left out (profit, for pump staff) aren't shown
  const columns = REPORT_COLUMNS.filter(k => ['days', 'approved_days', 'flagged_days'].includes(k) || k in labels);
  $('repHead').innerHTML = '<tr><th>Branch</th>' + columns.map(k => `<th>${esc(labels[k] || k)}</th>`).join('') + '</tr>';
  $('repBody').innerHTML = rep.branches.length
    ? rep.branches.map(b => '<tr><td translate="no">' + esc(b.station) + '</td>' + columns.map(k => `<td class="num">${cell(b, k)}</td>`).join('') + '</tr>').join('')
      + (rep.branches.length > 1 ? '<tr class="total"><td>All branches</td>' + columns.map(k => `<td class="num">${cell(t, k)}</td>`).join('') + '</tr>' : '')
    : `<tr><td colspan="${columns.length + 1}" style="color:var(--mut)">No records saved for this month.</td></tr>`;
  $('repDaily').innerHTML = rep.daily.map(d => `<tr><td>${esc(d.date)}</td><td translate="no">${esc(d.station)}</td>
    <td class="num">${fmt(d.total_litres)}</td><td class="num">KES ${fmt(d.gross_revenue)}</td>
    <td class="num priv ${d.net_profit < 0 ? 'bad' : ''}">KES ${fmt(d.net_profit)}</td>
    <td>${d.approved ? '<span class="badge bg">✅ Approved</span>' : '<span class="badge by">Open</span>'}</td></tr>`).join('')
    || '<tr><td colspan="6" style="color:var(--mut)">No days recorded.</td></tr>';
}

function downloadReportCSV() {
  location.href = '/api/reports/monthly.csv?month=' + encodeURIComponent($('repMonth').value || todayLocal().slice(0, 7));
}

// ── Pages: the menu opens each section as its own page (#fuel, #pay …) ─────
// The address hash keeps the browser / phone Back button working.
const PAGES = ['fuel', 'pay', 'gas', 'dips', 'exp', 'kra', 'prices', 'credit', 'report', 'ana', 'rec'];
let openedFromMenu = false;

function showPage(name) {
  const page = PAGES.includes(name) ? name : null;
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', p.id === 'p-' + page));
  document.querySelectorAll('#tabBar .tab-btn').forEach(b =>
    b.classList.toggle('on', (b.getAttribute('onclick') || '').includes("'" + page + "'")));
  document.body.classList.toggle('in-page', !!page);
  if (page) {
    const btn = [...document.querySelectorAll('#tabBar .tab-btn')]
      .find(b => (b.getAttribute('onclick') || '').includes("'" + page + "'"));
    $('pageTitle').textContent = btn ? btn.querySelector('.tab-name').textContent : '';
    updatePageContext();
    if (page === 'ana') renderAnalytics();
    if (page === 'rec') loadRecs();
    if (page === 'prices') renderPricesPage();
    if (page === 'credit') renderCreditPage();
    if (page === 'report') renderReport();
    if (page === 'exp') loadCustomers();
  }
  window.scrollTo(0, 0);
}

function updatePageContext() {
  const d = sv('fDate');
  const when = d ? new Date(d + 'T00:00:00').toLocaleDateString(LOCALE,
    { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '';
  $('pageCtx').textContent = [sv('fStation'), when].filter(Boolean).join(' · ');
}

function route() { showPage(location.hash.slice(1)); }

// Called by the menu buttons
function tab(name) {
  openedFromMenu = true;
  showPage(name);
  try { if (location.hash !== '#' + name) location.hash = name; } catch (e) { /* no history here */ }
}

function goHome() {
  if (openedFromMenu && location.hash) {
    openedFromMenu = false;
    history.back();                       // hashchange → route() shows the menu
  } else {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    showPage(null);
  }
}

window.addEventListener('hashchange', route);

// ── Load a record into the form (used when switching to a date that has data) ─
function populateFormFromRecord(r) {
  const setVal = (id, val) => { if ($(id)) $(id).value = (val === undefined || val === null) ? '' : val; };

  // Fuel
  PUMPS.forEach(([id]) => PUMP_READINGS.forEach(x => setVal(pumpField(id, x), r[pumpField(id, x)] || '')));
  // Days saved before pumps were split show their totals on the fuel's first pump
  Object.keys(FUEL_LABEL).forEach(fuel => {
    const ids = pumpsOf(fuel);
    if (!ids.some(id => PUMP_READINGS.some(x => Number(r[pumpField(id, x)] || 0))))
      PUMP_READINGS.forEach(x => setVal(pumpField(ids[0], x), r[fuel + '_' + x] || ''));
  });
  setVal('pPrice', r.petrol_price); setVal('pCost', r.petrol_cost);
  setVal('dPrice', r.diesel_price); setVal('dCost', r.diesel_cost);
  setVal('kPrice', r.kero_price);   setVal('kCost', r.kero_cost);
  setVal('pDipOpen', r.petrol_dip_open); setVal('pDelivered', r.petrol_delivered); setVal('pDipClose', r.petrol_dip_close);
  setVal('dDipOpen', r.diesel_dip_open); setVal('dDelivered', r.diesel_delivered); setVal('dDipClose', r.diesel_dip_close);
  setVal('kDipOpen', r.kero_dip_open);   setVal('kDelivered', r.kero_delivered);   setVal('kDipClose', r.kero_dip_close);

  // Payments
  setVal('fMpesa', r.mpesa_amount); setVal('fMpesaTxn', r.mpesa_txns);
  setVal('fCash', r.cash_amount);
  setVal('fCredit', r.credit_amount); setVal('fCard', r.card_amount);

  // Expenses
  setVal('eWages', r.exp_wages); setVal('eElec', r.exp_elec); setVal('eWater', r.exp_water);
  setVal('eMaint', r.exp_maint); setVal('eLubes', r.exp_lubes); setVal('eMisc', r.exp_misc);

  // Itemised lists
  MISC_ITEMS = Array.isArray(r.misc_items) ? JSON.parse(JSON.stringify(r.misc_items)) : [];
  GAS_ITEMS  = Array.isArray(r.gas_items)  ? JSON.parse(JSON.stringify(r.gas_items))  : [];
  INVOICES   = Array.isArray(r.invoices)   ? JSON.parse(JSON.stringify(r.invoices))   : [];
  DELIVERIES = Array.isArray(r.deliveries) ? JSON.parse(JSON.stringify(r.deliveries)) : [];
  ATTENDANTS = Array.isArray(r.attendants) ? JSON.parse(JSON.stringify(r.attendants)) : [];
  RECEIPTS   = Array.isArray(r.receipts)   ? JSON.parse(JSON.stringify(r.receipts))   : [];

  // KRA fields
  setVal('kPin', r.kra_pin); setVal('kBiz', r.kra_business); setVal('kPeriod', r.kra_period);
  setVal('kEtr', r.kra_etr); setVal('kRemarks', r.kra_remarks);
  if (r.kra_return_type && $('kReturnType')) $('kReturnType').value = r.kra_return_type;
  setVal('kBranch', r.kra_branch);
  setVal('fFloat', r.float_amount); setVal('fBanked', r.banked_amount);
  setVal('fMpesaTill', r.mpesa_till); setVal('fMpesaRef', r.mpesa_ref);
  setVal('fCreditCust', r.credit_customer);
  if (r.shift) setVal('fShift', r.shift);
  // A saved day keeps the operator who recorded its sales
  setVal('fOperator', r.operator || displayName(USER));

  // Credit field lock state follows invoice presence, same rule used elsewhere
  if ($('fCredit')) $('fCredit').readOnly = INVOICES.length > 0;

  renderMiscItems();
  renderGasItems();
  renderInvoices();
  renderDeliveries();
  renderAttendants();
  renderReceipts();
  calc();
}

// ── Clear the form for a fresh entry (used when switching to a date with no data) ─
function clearFormForNewEntry() {
  // Owner prices and delivery totals are re-applied below, so unlock them before clearing
  document.querySelectorAll('input.owner-price').forEach(i => { i.readOnly = false; i.classList.remove('owner-price'); });
  DELIVERIES = [];
  renderDeliveries();
  ATTENDANTS = [];
  renderAttendants();
  RECEIPTS = [];
  renderReceipts();
  document.querySelectorAll('input[type="number"]').forEach(i => { if (!i.readOnly) i.value = ''; });
  ['kPin','kBiz','kPeriod','kEtr','fMpesaTill','fMpesaRef','fCreditCust','kRemarks']
    .forEach(id => $(id) && ($(id).value = ''));
  if ($('kReturnType')) $('kReturnType').value = 'vat';

  INVOICES = [];
  MISC_ITEMS = [];
  GAS_ITEMS = [];
  if ($('fCredit')) { $('fCredit').readOnly = false; $('fCredit').value = ''; }
  // eMisc is readonly (driven by MISC_ITEMS), so the loop above skips it
  if ($('eMisc')) $('eMisc').value = '';
  // A new day is recorded under whoever is signed in
  if ($('fOperator')) $('fOperator').value = displayName(USER);

  renderInvoices();
  renderMiscItems();
  renderGasItems();
  calc();
}

// ── Fires whenever the date or station changes: loads matching record, or resets ─
function loadRecordForDateAndStation() {
  const date = sv('fDate');
  const station = sv('fStation');
  if (!date || !station) return;

  const existing = RECS.find(r => r.report_date === date && r.station === station);
  updateLockState();

  if (existing) {
    populateFormFromRecord(existing);
    toast('📂 Loaded existing record for ' + date + ' · ' + station);
  } else {
    clearFormForNewEntry();
    fillOpeningsFromPrevious();
    toast('🆕 No record for ' + date + ' · ' + station + ' — ready for new entry');
  }
  applyOwnerPrices();
}

// ── Opening readings: today's openings should equal the previous saved day's closings ─
const OPENING_PAIRS = [
  ...PUMPS.flatMap(([id]) => [
    [pumpField(id, 'open'), pumpField(id, 'close'), pumpName(id) + ' opening meter'],
    [pumpField(id, 'sales_open'), pumpField(id, 'sales_close'), pumpName(id) + ' opening sales meter']]),
  ['pDipOpen', 'petrol_dip_close', 'Petrol opening dip'], ['dDipOpen', 'diesel_dip_close', 'Diesel opening dip'],
  ['kDipOpen', 'kero_dip_close', 'Kerosene opening dip'],
];

function previousRecord() {
  const date = sv('fDate'), station = sv('fStation');
  return RECS.filter(r => r.station === station && r.report_date < date)
    .sort((a, b) => b.report_date.localeCompare(a.report_date))[0] || null;
}

const niceDate = d => new Date(d + 'T00:00:00').toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });

function fillOpeningsFromPrevious() {
  const prev = previousRecord();
  const note = $('openingNote');
  if (!prev) { note.hidden = true; return; }
  let filled = 0;
  OPENING_PAIRS.forEach(([id, field]) => {
    if (Number(prev[field]) > 0 && !$(id).value) { $(id).value = prev[field]; filled++; }
  });
  note.textContent = filled ? `↪ Opening readings filled from ${niceDate(prev.report_date)}'s closing readings.` : '';
  note.hidden = !filled;
  calc();
}

function checkOpenings() {
  const box = $('openingWarn');
  if (!box) return;
  const prev = previousRecord();
  const issues = prev ? OPENING_PAIRS.filter(([id, field]) => {
    const expected = Number(prev[field]) || 0;
    return expected > 0 && $(id).value !== '' && Math.abs(fv(id) - expected) > 0.005;
  }) : [];
  box.hidden = !issues.length;
  box.innerHTML = issues.length
    ? `⚠️ These openings don't match ${esc(niceDate(prev.report_date))}'s closing readings — check the meters before saving:<br>` +
      issues.map(([id, field, label]) => `<b>${esc(label)}</b>: entered ${fmt(fv(id))}, closing was ${fmt(prev[field])}`).join('<br>')
    : '';
}

// ── Prices set by the owner fill the price boxes and can't be typed over ─────
const PRICE_INPUTS = { petrol: ['pPrice', 'pCost'], diesel: ['dPrice', 'dCost'], kero: ['kPrice', 'kCost'] };

async function applyOwnerPrices() {
  const station = sv('fStation'), date = sv('fDate');
  if (!station || !date || !USER || !ONLINE) return;
  let prices = {};
  try { prices = (await api('GET', '/prices?station=' + encodeURIComponent(station) + '&date=' + date)).prices; }
  catch (e) { return; }
  if (sv('fStation') !== station || sv('fDate') !== date) return;      // user moved on
  Object.entries(PRICE_INPUTS).forEach(([fuel, ids]) => {
    const p = prices[fuel];
    ids.forEach((id, i) => {
      const el = $(id);
      if (p) {
        el.value = (i === 0 ? p.sell : p.cost) ?? '';
        el.readOnly = true;
        el.classList.add('owner-price');
        el.title = 'Set by the owner from ' + p.effective_from;
      } else if (el.classList.contains('owner-price')) {
        el.readOnly = false; el.classList.remove('owner-price'); el.title = '';
      }
    });
  });
  calc();
}

// ── Fuel Prices page ──────────────────────────────────────────────────────────
const FUEL_NAMES = { petrol: 'Super Petrol (PMS)', diesel: 'Diesel (AGO)', kero: 'Kerosene (IK)' };

async function renderPricesPage() {
  const isAdmin = USER && USER.role === 'admin';
  $('priceAdmin').hidden = !isAdmin;
  $('priceHistoryBox').hidden = !isAdmin;
  const station = sv('fStation'), date = sv('fDate') || todayLocal();
  $('pricesFor').textContent = station + ' · ' + niceDate(date);
  if (isAdmin && !$('priceFrom').value) $('priceFrom').value = todayLocal();
  const body = $('pricesNow');
  try {
    const { prices } = await api('GET', '/prices?station=' + encodeURIComponent(station) + '&date=' + date);
    body.innerHTML = Object.keys(FUEL_NAMES).map(f => {
      const p = prices[f];
      return `<tr><td>${FUEL_NAMES[f]}</td>${p
        ? `<td>KES ${fmt(p.sell)}</td><td class="priv">KES ${fmt(p.cost)}</td><td>${esc(p.effective_from)}</td><td>${esc(p.set_by)}</td>`
        : '<td colspan="4" style="color:var(--mut)">Not set — typed in on Fuel Entry</td>'}</tr>`;
    }).join('');
  } catch (e) {
    body.innerHTML = `<tr><td colspan="5" style="color:var(--mut)">${esc(ONLINE ? e.message : 'Prices need an internet connection.')}</td></tr>`;
  }
  if (!isAdmin) return;
  try {
    const { prices } = await api('GET', '/prices/history');
    $('priceHistory').innerHTML = prices.map(p => `<tr><td>${esc(p.effective_from)}</td><td translate="no">${esc(p.station)}</td>
      <td>${esc(FUEL_NAMES[p.fuel] || p.fuel)}</td><td>KES ${fmt(p.sell)}</td><td>KES ${fmt(p.cost)}</td><td>${esc(p.set_by)}</td></tr>`).join('')
      || '<tr><td colspan="6" style="color:var(--mut)">No prices set yet.</td></tr>';
  } catch (e) { /* history is optional */ }
}

function toggleAllPriceStations(on) {
  document.querySelectorAll('input[name="priceStation"]').forEach(c => { c.checked = on; });
}

async function savePrices() {
  if (!requireOnline('save prices')) return;
  const stations = [...document.querySelectorAll('input[name="priceStation"]:checked')].map(c => c.value);
  if (!stations.length) { toast('⚠️ Tick at least one branch', true); return; }
  const body = { stations, effective_from: sv('priceFrom'),
    petrol_sell: fv('prPetrolSell'), petrol_cost: fv('prPetrolCost'),
    diesel_sell: fv('prDieselSell'), diesel_cost: fv('prDieselCost'),
    kero_sell: fv('prKeroSell'), kero_cost: fv('prKeroCost') };
  try {
    await api('POST', '/prices', body);
    toast('✅ Prices saved for ' + stations.length + ' branch' + (stations.length === 1 ? '' : 'es'));
    ['prPetrolSell','prPetrolCost','prDieselSell','prDieselCost','prKeroSell','prKeroCost'].forEach(id => $(id).value = '');
    renderPricesPage();
    applyOwnerPrices();
  } catch (e) { toast('⚠️ ' + e.message, true); }
}

// ── Fuel deliveries ───────────────────────────────────────────────────────────
const DELIVERED_INPUT = { petrol: 'pDelivered', diesel: 'dDelivered', kero: 'kDelivered' };

function addDelivery() {
  const received = fv('dvReceived');
  if (received <= 0) { toast('⚠️ Enter the litres received', true); $('dvReceived').focus(); return; }
  DELIVERIES.push({
    id: Date.now(), fuel: sv('dvFuel'), supplier: sv('dvSupplier'), note_no: sv('dvNote'),
    truck_reg: sv('dvTruck').toUpperCase(), litres_ordered: fv('dvOrdered'), litres_received: received,
    dip_before: fv('dvDipBefore'), dip_after: fv('dvDipAfter')
  });
  ['dvSupplier','dvNote','dvTruck','dvOrdered','dvReceived','dvDipBefore','dvDipAfter'].forEach(id => $(id).value = '');
  renderDeliveries();
  toast('🚚 Delivery added');
}

function deleteDelivery(id) {
  DELIVERIES = DELIVERIES.filter(d => d.id !== id);
  renderDeliveries();
}

function deliveryChecks(d) {
  const short = (d.litres_ordered || 0) - (d.litres_received || 0);
  const dipGain = d.dip_before > 0 && d.dip_after > 0 ? d.dip_after - d.dip_before : null;
  return { short, dipGain, dipDiff: dipGain === null ? null : dipGain - d.litres_received };
}

function renderDeliveries() {
  const list = $('deliveriesList');
  if (!list) return;
  list.innerHTML = DELIVERIES.length ? DELIVERIES.map(d => {
    const { short, dipGain, dipDiff } = deliveryChecks(d);
    return `<div class="item-row">
      <span class="grow"><b>${esc(FUEL_NAMES[d.fuel] || d.fuel)}</b> · ${fmt(d.litres_received)} L received
        <br><small translate="no">${esc(d.supplier || 'Supplier —')} · ${esc(d.note_no || 'no note')} · ${esc(d.truck_reg || 'no truck')}</small></span>
      <span>${d.litres_ordered ? `Ordered ${fmt(d.litres_ordered)} L · <b class="${short > 0.5 ? 'bad' : 'ok'}">${short > 0.5 ? 'Short ' + fmt(short) + ' L' : 'Full'}</b>` : ''}
        ${dipGain !== null ? `<br><small>Tank rose ${fmt(dipGain)} L (${Math.abs(dipDiff) < 20 ? 'matches' : '<b class="bad">' + (dipDiff < 0 ? 'short ' : 'over ') + fmt(Math.abs(dipDiff)) + ' L</b>'})</small>` : ''}</span>
      <button class="btn btn-r btn-xs" onclick="deleteDelivery(${Number(d.id)})">✕</button>
    </div>`;
  }).join('') : '<div style="font-family:var(--mono);font-size:.74rem;color:var(--mut)">No deliveries recorded today.</div>';
  // Logged deliveries decide the received litres (the server applies the same rule)
  Object.entries(DELIVERED_INPUT).forEach(([fuel, id]) => {
    const el = $(id);
    if (DELIVERIES.length) {
      el.value = DELIVERIES.filter(d => d.fuel === fuel).reduce((s, d) => s + (d.litres_received || 0), 0) || '';
      el.readOnly = true; el.title = 'Total of the deliveries logged below';
    } else if (el.readOnly) { el.readOnly = false; el.title = ''; }
  });
  calc();
}

// ── Save record ───────────────────────────────────────────────────────────────
async function saveRec() {
  if (!sv('fStation')) { toast('⚠️ Choose a branch first — the admin adds branches under 👤 Account', true); return; }
  const locked = lockReason(sv('fDate'));
  if (locked) { toast(locked, true); return; }
  const c = COMP;
  if (!c || c.grossRev === undefined) {
    toast('⚠️ No data to save — fill in fuel readings first', true);
    return;
  }
  const now = Date.now();
  const rec = {
    id:           now,
    uid:          'rec_' + now,
    report_date:  sv('fDate') || todayLocal(),
    station:      sv('fStation') || 'Unknown Station',
    // raw inputs
    ...Object.fromEntries(PUMPS.flatMap(([id]) => PUMP_READINGS.map(x => [pumpField(id, x), fv(pumpField(id, x))]))),
    ...Object.fromEntries(Object.keys(FUEL_LABEL).flatMap(fuel => {
      const m = fuelMeters(fuel);
      return PUMP_READINGS.map(x => [fuel + '_' + x, m[x]]);
    })),
    petrol_price: fv('pPrice'),  petrol_cost:  fv('pCost'),
    diesel_price: fv('dPrice'),  diesel_cost:  fv('dCost'),
    kero_price:   fv('kPrice'),  kero_cost:    fv('kCost'),
    petrol_dip_open: fv('pDipOpen'), petrol_delivered: fv('pDelivered'), petrol_dip_close: fv('pDipClose'),
    diesel_dip_open: fv('dDipOpen'), diesel_delivered: fv('dDelivered'), diesel_dip_close: fv('dDipClose'),
    kero_dip_open: fv('kDipOpen'), kero_delivered: fv('kDelivered'), kero_dip_close: fv('kDipClose'),
    mpesa_amount: fv('fMpesa'),  mpesa_txns:   fv('fMpesaTxn'),
    cash_amount:  fv('fCash'),   credit_amount:fv('fCredit'), card_amount:fv('fCard'),
    exp_wages:fv('eWages'), exp_elec:fv('eElec'), exp_water:fv('eWater'),
    exp_maint:fv('eMaint'), exp_lubes:fv('eLubes'), exp_misc:fv('eMisc'),
    misc_items: JSON.parse(JSON.stringify(MISC_ITEMS)),
    gas_items: JSON.parse(JSON.stringify(GAS_ITEMS)),
    gas_lube_revenue: COMP.gasLubeRev || 0,
    // computed (from C++ engine mirror)
    petrol_litres:  c.pL    || 0,
    diesel_litres:  c.dL    || 0,
    kero_litres:    c.kL    || 0,
    total_litres:   c.totalL|| 0,
    gross_revenue:  c.grossRev   || 0,
    total_expenses: c.totalExp   || 0,
    total_cost:     c.totalCost  || 0,
    net_profit:     c.netProfit  || 0,
    profit_margin:  c.profitMgn  || 0,
    output_vat:     c.outputVAT  || 0,
    total_excise:   c.totalExcise|| 0,
    total_tax:      c.totalTax   || 0,
    // KRA filing fields
    kra_pin:         sv('kPin'),
    kra_business:    sv('kBiz'),
    kra_period:      sv('kPeriod'),
    kra_etr:         sv('kEtr'),
    kra_return_type: sv('kReturnType'),
    kra_remarks:     sv('kRemarks'),
    invoices:        JSON.parse(JSON.stringify(INVOICES)), // snapshot of today's credit invoices
    deliveries:      JSON.parse(JSON.stringify(DELIVERIES)),
    attendants:      JSON.parse(JSON.stringify(ATTENDANTS)),
    receipts:        JSON.parse(JSON.stringify(RECEIPTS)),
    kra_branch:      sv('kBranch'),
    float_amount:    fv('fFloat'),  banked_amount: fv('fBanked'),
    mpesa_till:      sv('fMpesaTill'), mpesa_ref: sv('fMpesaRef'),
    credit_customer: sv('fCreditCust'),
    operator:        sv('fOperator'), shift: sv('fShift'),
    created_at: new Date().toISOString()
  };

  if (!ONLINE) { queueSave(rec); return; }
  // Server recomputes all figures and upserts on date + station
  try {
    const res = await api('POST', '/records', rec);
    toast((res.created ? '✅ Record saved — ' : '✅ Record updated — ') + rec.report_date + ' · ' + rec.station);
    await refreshRecs();
    refreshAlerts();
    loadCustomers();
  } catch (e) {
    if (!ONLINE) { queueSave(rec); return; }               // connection dropped while saving
    toast('⚠️ Save failed: ' + e.message, true);
  }
}

// ── Station filter toggle ─────────────────────────────────────────────────────
function toggleStationFilter() {
  const sel = $('filterStation');
  if (!sel) return;
  const isHidden = sel.style.display === 'none';
  sel.style.display = isHidden ? 'block' : 'none';
  const btn = $('filterStationBtn');
  if (btn) btn.textContent = isHidden ? '✖ Hide Filter' : '🔽 Filter Branch';
  if (!isHidden) { sel.value = ''; loadRecs(); }
}

// ── Erase all records ─────────────────────────────────────────────────────────
async function eraseAllRecs() {
  if (!RECS.length) { toast('⚠️ No records to erase', true); return; }

  const filterBranch = $('filterStation') ? $('filterStation').value : '';
  const count = filterBranch
    ? RECS.filter(r => r.station === filterBranch).length
    : RECS.length;
  const target = filterBranch
    ? `all ${count} record${count !== 1 ? 's' : ''} for ${filterBranch}`
    : `ALL ${count} record${count !== 1 ? 's' : ''} from every branch`;

  const confirmed = await showConfirmModal(
    'Move Records to the Bin?',
    `This will move ${target} to the bin.\n\nAn admin can restore them from the bin.`
  );

  if (!confirmed) {
    toast('Cancelled — nothing was moved');
    return;
  }

  if (!requireOnline('erase records')) return;
  try {
    await api('DELETE', '/records' + (filterBranch ? '?station=' + encodeURIComponent(filterBranch) : ''));
    toast(filterBranch ? `🗑️ All records for ${filterBranch} moved to the bin` : '🗑️ All records moved to the bin');
    await refreshRecs();
  } catch (e) {
    toast('⚠️ Erase failed: ' + e.message, true);
  }
}

// ── Invoice / Credit Customer management ──────────────────────────────────────
async function addInvoice() {
  const customer = sv('invCustomer');
  const company  = sv('invCompany');
  const carReg   = sv('invCarReg').toUpperCase();
  const phone    = sv('invPhone');
  const fuelType = sv('invFuelType');
  const amount   = fv('invAmount');

  if (!customer) { toast('⚠️ Enter customer name', true); return; }
  if (!amount || amount <= 0) { toast('⚠️ Enter a valid invoice amount', true); return; }

  // Warn before taking a credit account over its limit
  const account = CUSTOMERS.find(c => String(c.id) === sv('invAccount'));
  if (account && account.credit_limit > 0) {
    const savedToday = (currentRecord()?.invoices || []).filter(i => Number(i.customer_id) === account.id)
      .reduce((s, i) => s + Number(i.amount || 0), 0);
    const unsaved = INVOICES.filter(i => Number(i.customer_id) === account.id).reduce((s, i) => s + i.amount, 0);
    const after = account.balance - savedToday + unsaved + amount;
    if (after > account.credit_limit) {
      const ok = await showConfirmModal('Over the credit limit',
        `${account.name} would owe KES ${fmt(after)}, over their limit of KES ${fmt(account.credit_limit)}.\n\nAdd the invoice anyway?`);
      if (!ok) return;
    }
  }

  const inv = {
    id: Date.now(),
    invoiceNo: 'INV-' + (sv('fDate') || todayLocal()).replace(/-/g,'') + '-' + String(INVOICES.length + 1).padStart(3,'0'),
    date: sv('fDate') || todayLocal(),
    station: sv('fStation'),
    customer, company, carReg, phone, fuelType, amount,
    customer_id: account ? account.id : 0,
    created_at: new Date().toISOString()
  };

  INVOICES.push(inv);
  renderInvoices();
  syncInvoicesToCredit();

  // Clear the form for next entry
  ['invCustomer','invCompany','invCarReg','invPhone','invAmount','invAccount'].forEach(id => { if($(id)) $(id).value=''; });
  $('invAccountNote').textContent = '';
  toast('🧾 Invoice added for ' + customer);
}

async function deleteInvoice(id) {
  const ok = await showConfirmModal('Delete Invoice?', 'This invoice will be permanently removed.');
  if (!ok) return;
  INVOICES = INVOICES.filter(i => i.id !== id);
  renderInvoices();
  syncInvoicesToCredit();
  toast('🗑️ Invoice deleted');
}

function renderInvoices() {
  const tbody = $('invoiceBody');
  if (!tbody) return;

  if (!INVOICES.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--mut);font-family:var(--mono);font-size:.74rem">
      No invoices added yet — fill the form above.
    </td></tr>`;
  } else {
    tbody.innerHTML = INVOICES.map((inv, i) => `
      <tr>
        <td style="color:var(--mut)">${i+1}</td>
        <td translate="no">${esc(inv.customer)}</td>
        <td translate="no" style="color:var(--acc2)">${esc(inv.company || '—')}</td>
        <td translate="no" style="color:var(--blue)">${esc(inv.carReg || '—')}</td>
        <td translate="no">${esc(inv.phone || '—')}</td>
        <td>${esc(inv.fuelType)}</td>
        <td style="color:var(--purple)">KES ${fmt(inv.amount)}</td>
        <td><button class="btn btn-o" style="padding:3px 9px;font-size:.65rem" onclick="printInvoice(${Number(inv.id)})">🖨️</button></td>
        <td><button class="btn btn-r" style="padding:3px 9px;font-size:.65rem" onclick="deleteInvoice(${Number(inv.id)})">✕</button></td>
      </tr>
    `).join('');
  }

  const totalInvoiced = INVOICES.reduce((sum, inv) => sum + inv.amount, 0);
  if ($('invCount'))      $('invCount').textContent = INVOICES.length;
  if ($('invTotalDisp'))  $('invTotalDisp').textContent = 'KES ' + fmt(totalInvoiced);
}

// ── Push invoice total into the Credit Sales field automatically ─────────────
// ── Miscellaneous expenses: itemised list ─────────────────────────────────────
function toggleMiscPanel() {
  const panel = $('miscPanel');
  const icon  = $('miscToggleIcon');
  if (!panel) return;
  const isHidden = panel.style.display === 'none';
  panel.style.display = isHidden ? 'block' : 'none';
  if (icon) icon.textContent = isHidden ? '▾' : '▸';
  if (isHidden) {
    const nameField = $('miscItemName');
    if (nameField) nameField.focus();
  }
}

function addMiscItem() {
  const name   = sv('miscItemName');
  const amount = fv('miscItemAmount');

  if (!name) {
    toast('⚠️ Enter what the expense was for', true);
    $('miscItemName').focus();
    return;
  }
  if (amount <= 0) {
    toast('⚠️ Enter a valid amount', true);
    $('miscItemAmount').focus();
    return;
  }

  MISC_ITEMS.push({
    id: Date.now(),
    name: name,
    amount: r2(amount)
  });

  $('miscItemName').value = '';
  $('miscItemAmount').value = '';
  $('miscItemName').focus();

  renderMiscItems();
  syncMiscToExpenses();
  toast('✅ Added: ' + name + ' — KES ' + fmt(amount));
}

function deleteMiscItem(id) {
  MISC_ITEMS = MISC_ITEMS.filter(i => i.id !== id);
  renderMiscItems();
  syncMiscToExpenses();
}

function renderMiscItems() {
  const list = $('miscItemsList');
  if (!list) return;

  if (!MISC_ITEMS.length) {
    list.innerHTML = `<div style="font-family:var(--mono);font-size:.74rem;color:var(--mut);padding:6px 0">
      No items yet — add each miscellaneous expense below.</div>`;
  } else {
    list.innerHTML = MISC_ITEMS.map(item => `
      <div style="display:flex;align-items:center;gap:10px;background:var(--s2);
        border:1px solid var(--brd);border-radius:7px;padding:8px 12px;font-family:var(--mono);font-size:.78rem">
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--txt)" translate="no" title="${esc(item.name)}">${esc(item.name)}</span>
        <span style="flex-shrink:0;color:var(--acc2);font-weight:600">KES ${fmt(item.amount)}</span>
        <button class="btn btn-r" style="flex-shrink:0;padding:2px 8px;font-size:.62rem"
          onclick="deleteMiscItem(${Number(item.id)})">✕</button>
      </div>
    `).join('');
  }

  const total = MISC_ITEMS.reduce((sum, i) => sum + i.amount, 0);
  $('miscItemCount').textContent = MISC_ITEMS.length;
  $('miscItemsTotal').textContent = 'KES ' + fmt(total);
}

function syncMiscToExpenses() {
  const total = r2(MISC_ITEMS.reduce((sum, i) => sum + i.amount, 0));
  const miscField = $('eMisc');
  if (miscField) miscField.value = total > 0 ? total.toFixed(2) : '';
  calc();
}

// ── Gases & Lubricants: itemised sales list ───────────────────────────────────
function addGasItem() {
  const name  = sv('gasItemName');
  const cat   = sv('gasItemCategory') || 'Gas';
  const qty   = fv('gasItemQty') || 1;
  const price = fv('gasItemPrice');

  if (!name) {
    toast('⚠️ Enter the product name', true);
    $('gasItemName').focus();
    return;
  }
  if (qty <= 0) {
    toast('⚠️ Quantity must be at least 1', true);
    $('gasItemQty').focus();
    return;
  }
  if (price <= 0) {
    toast('⚠️ Enter a valid unit price', true);
    $('gasItemPrice').focus();
    return;
  }

  GAS_ITEMS.push({
    id: Date.now(),
    name: name,
    category: cat,
    qty: qty,
    price: r2(price)
  });

  $('gasItemName').value = '';
  $('gasItemQty').value = '1';
  $('gasItemPrice').value = '';
  $('gasItemName').focus();

  renderGasItems();
  calc();
  toast('✅ Added: ' + qty + ' × ' + name + ' — KES ' + fmt(qty * price));
}

function deleteGasItem(id) {
  GAS_ITEMS = GAS_ITEMS.filter(i => i.id !== id);
  renderGasItems();
  calc();
}

function renderGasItems() {
  const list = $('gasItemsList');
  if (!list) return;

  if (!GAS_ITEMS.length) {
    list.innerHTML = `<div style="font-family:var(--mono);font-size:.74rem;color:var(--mut);padding:6px 0">
      No items yet — add each gas cylinder or lubricant product sold today.</div>`;
  } else {
    list.innerHTML = GAS_ITEMS.map(item => {
      const lineTotal = item.qty * item.price;
      const catColor = item.category === 'Gas' ? 'var(--acc2)'
                      : item.category === 'Lubricant' ? 'var(--blue)' : 'var(--purple)';
      return `
      <div style="display:flex;align-items:center;gap:10px;background:var(--s2);
        border:1px solid var(--brd);border-radius:7px;padding:8px 12px;font-family:var(--mono);font-size:.78rem">
        <span style="flex:2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--txt)" translate="no" title="${esc(item.name)}">${esc(item.name)}</span>
        <span style="flex-shrink:0;color:${catColor};font-size:.68rem;border:1px solid ${catColor};
          border-radius:4px;padding:1px 7px;text-align:center">${esc(item.category)}</span>
        <span style="flex-shrink:0;color:var(--mut);white-space:nowrap">${esc(item.qty)} × KES ${fmt(item.price)}</span>
        <span style="flex-shrink:0;color:var(--acc2);font-weight:600;text-align:right;white-space:nowrap">KES ${fmt(lineTotal)}</span>
        <button class="btn btn-r" style="flex-shrink:0;padding:2px 8px;font-size:.62rem"
          onclick="deleteGasItem(${Number(item.id)})">✕</button>
      </div>`;
    }).join('');
  }

  const gasTotal  = GAS_ITEMS.filter(i => i.category === 'Gas').reduce((s,i)=>s+(i.qty*i.price),0);
  const lubeTotal = GAS_ITEMS.filter(i => i.category === 'Lubricant').reduce((s,i)=>s+(i.qty*i.price),0);
  const grandTotal = GAS_ITEMS.reduce((s,i)=>s+(i.qty*i.price),0);

  $('gasItemCount').textContent = GAS_ITEMS.length;
  $('gasCategoryTotal').textContent = 'KES ' + fmt(gasTotal);
  $('lubeCategoryTotal').textContent = 'KES ' + fmt(lubeTotal);
  $('gasItemsTotal').textContent = 'KES ' + fmt(grandTotal);
}

function syncInvoicesToCredit() {
  const totalInvoiced = INVOICES.reduce((sum, inv) => sum + inv.amount, 0);
  const creditField = $('fCredit');
  if (creditField) {
    creditField.value = totalInvoiced > 0 ? totalInvoiced.toFixed(2) : '';
    creditField.readOnly = INVOICES.length > 0;
  }
  // Reflect customer names in the credit customer field
  const custField = $('fCreditCust');
  if (custField && INVOICES.length) {
    custField.value = INVOICES.map(i => i.customer).join(', ');
  }
  calc();
}

// ── Print a single invoice as a clean receipt ─────────────────────────────────
function printInvoice(id) {
  const inv = INVOICES.find(i => i.id === id);
  if (!inv) return;

  const win = window.open('', '_blank', 'width=420,height=600');
  win.document.write(`
    <html><head><title>${esc(inv.invoiceNo)}</title>
    <style>
      body{font-family:'IBM Plex Mono',monospace;padding:24px;color:#111;max-width:380px;margin:0 auto}
      h1{font-size:16px;margin:0 0 2px}
      .sub{font-size:11px;color:#666;margin-bottom:16px}
      .row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #ddd;font-size:12.5px}
      .row span:last-child{font-weight:600}
      .total{margin-top:14px;padding-top:10px;border-top:2px solid #111;font-size:15px;display:flex;justify-content:space-between;font-weight:700}
      .foot{margin-top:24px;font-size:10px;color:#888;text-align:center}
    </style></head>
    <body>
      <h1>⛽ ${esc(inv.station || 'PetroKenya')}</h1>
      <div class="sub">Fuel Credit Invoice &nbsp;·&nbsp; ${esc(inv.invoiceNo)}</div>
      <div class="row"><span>Date</span><span>${esc(inv.date)}</span></div>
      <div class="row"><span>Customer Name</span><span>${esc(inv.customer)}</span></div>
      <div class="row"><span>Company</span><span>${esc(inv.company || '—')}</span></div>
      <div class="row"><span>Car Reg. No.</span><span>${esc(inv.carReg || '—')}</span></div>
      <div class="row"><span>Phone Number</span><span>${esc(inv.phone || '—')}</span></div>
      <div class="row"><span>Fuel Type</span><span>${esc(inv.fuelType)}</span></div>
      <div class="total"><span>AMOUNT DUE</span><span>KES ${fmt(inv.amount)}</span></div>
      <div class="foot">Thank you for fuelling with us.<br>This is a credit invoice — payment terms apply.</div>
    </body></html>
  `);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
}

// ── Load & render records table ───────────────────────────────────────────────
function loadRecs() {

  // Apply branch filter if active
  const filterBranch = $('filterStation') ? $('filterStation').value : '';
  const display = filterBranch ? RECS.filter(r => r.station === filterBranch) : RECS;

  const countEl = $('recCount');
  if (countEl) {
    countEl.textContent = filterBranch
      ? `${display.length} of ${RECS.length} record${RECS.length !== 1 ? 's' : ''} (${filterBranch})`
      : `${RECS.length} record${RECS.length !== 1 ? 's' : ''} — all branches`;
  }

  const tbody = $('recBody');
  if (!tbody) return;

  if (!display.length) {
    tbody.innerHTML = `<tr><td colspan="16" style="text-align:center;padding:36px;
      color:var(--mut);font-family:var(--mono);font-size:.76rem">
      ${filterBranch ? `No records for ${esc(filterBranch)} yet.` : 'No records saved yet.'}<br>
      Fill in today\'s data and click 💾 Save Daily Record.
    </td></tr>`;
    return;
  }

  try {
    tbody.innerHTML = display.map(r => {
      if (r.pending) {
        return `<tr><td style="color:var(--mut)">—</td><td>${esc(r.report_date)}</td>
          <td translate="no" style="color:var(--acc2)">${esc(r.station)}</td><td translate="no">${esc(r.operator || '—')}</td>
          <td colspan="10" style="color:var(--mut)">${r.pending_error
            ? '⚠️ Not accepted: ' + esc(r.pending_error) : 'Saved on this phone — will be sent when online'}</td>
          <td><span class="badge bw">⏳ Waiting to send</span></td>
          <td><button class="btn btn-r btn-xs" onclick="discardQueued('${esc(r.report_date)}', '${esc(r.station)}')">✕</button></td></tr>`;
      }
      const idLabel   = r.uid ? r.uid.slice(-6) : String(r.id).slice(-6);
      const profit    = Number(r.net_profit  || 0);
      const vat       = Number(r.output_vat  || 0);
      const tax       = Number(r.total_tax   || 0);
      const mpesa     = Number(r.mpesa_amount|| 0);
      const cash      = Number(r.cash_amount || 0);
      const expenses  = Number(r.total_expenses || 0);
      const gross     = Number(r.gross_revenue  || 0);
      const pLit      = Number(r.petrol_litres  || 0);
      const dLit      = Number(r.diesel_litres  || 0);
      const totLit    = Number(r.total_litres   || 0);
      const safeId    = r.id;

      return `<tr data-id="${safeId}" onclick="openDetail(event, ${safeId})" style="cursor:pointer">
        <td style="color:var(--mut)">${idLabel}</td>
        <td>${esc(r.report_date || '—')}</td>
        <td style="color:var(--acc2);max-width:120px;overflow:hidden;text-overflow:ellipsis" translate="no">${esc(r.station || '—')}</td>
        <td translate="no">${esc(r.operator || '—')}</td>
        <td>${fmtL(pLit)}</td>
        <td>${fmtL(dLit)}</td>
        <td style="color:var(--blue)">${fmtL(totLit)}</td>
        <td style="color:var(--acc2)">KES ${fmt(gross)}</td>
        <td style="color:#00a651">KES ${fmt(mpesa)}</td>
        <td>KES ${fmt(cash)}</td>
        <td style="color:var(--red)">KES ${fmt(expenses)}</td>
        <td class="priv"><span class="badge ${profit >= 0 ? 'bg' : 'br'}">KES ${fmt(profit)}</span></td>
        <td>KES ${fmt(vat)}</td>
        <td style="color:var(--acc2)">KES ${fmt(tax)}</td>
        <td>${r.approved_at ? '<span class="badge bg">✅ Approved</span>' : '<span class="badge by">Open</span>'}${(r.opening_mismatches || []).length ? ' <span class="badge br" title="Openings differ from the previous day">⚠️</span>' : ''}</td>
        <td>
          <button class="btn btn-r btn-xs" data-id="${safeId}"
            onclick="event.stopPropagation();delRec(this)">✕</button>
        </td>
      </tr>`;
    }).join('');
  } catch(e) {
    console.error('loadRecs render error:', e);
    tbody.innerHTML = `<tr><td colspan="16" style="color:var(--red);padding:20px;font-family:var(--mono);font-size:.74rem">
      Render error: ${esc(e.message)}
    </td></tr>`;
  }
}

// ── Delete a record ───────────────────────────────────────────────────────────
async function delRec(btn) {
  const ok = await showConfirmModal('Move to Bin?', 'This record will be moved to the bin. An admin can restore it.');
  if (!ok) return;

  const id = Number(btn.dataset.id);
  if (isNaN(id)) {
    toast('⚠️ Could not identify this record', true);
    return;
  }

  if (!requireOnline('delete records')) return;
  try {
    await api('DELETE', '/records/' + id);
    toast('🗑️ Moved to the bin');
  } catch (e) {
    toast('⚠️ Delete failed: ' + e.message, true);
  }
  await refreshRecs();
}

// ── Open the full detail view for one record ──────────────────────────────────
let DETAIL_ID = null; // tracks which record is currently shown, for delete-from-modal

function openDetail(evt, id) {
  // Ignore the click if it originated from the delete button (handled separately)
  if (evt && evt.target && evt.target.closest && evt.target.closest('button')) return;

  const r = RECS.find(rec => Number(rec.id) === Number(id));
  if (!r) { toast('⚠️ Record not found', true); return; }

  DETAIL_ID = Number(id);
  loadHistory(id);
  const lockedForMe = !!r.approved_at || (!!lockReason(r.report_date, r) && !(USER && USER.role === 'admin'));
  $('rdDeleteBtn').disabled = lockedForMe;
  $('rdApproval').textContent = r.approved_at
    ? '✅ Approved by ' + r.approved_by + ' · ' + new Date(r.approved_at).toLocaleString(LOCALE)
    : 'Open — not yet approved';
  $('rdApproveBtn').hidden = !(!r.approved_at && canApprove());
  $('rdReopenBtn').hidden = !(r.approved_at && USER && USER.role === 'admin');
  const mism = r.opening_mismatches || [];
  $('rdMismatchSec').hidden = !mism.length;
  $('rdMismatches').innerHTML = mism.map(m => {
    const label = FIELD_LABELS[m.field] || m.field;
    return `<div class="m-row"><span>${esc(label)}</span><span class="bad">entered ${fmt(m.entered)} · closing ${esc(m.from_date)} was ${fmt(m.expected)}</span></div>`;
  }).join('');
  const rcs = r.receipts || [];
  $('rdReceiptsSec').hidden = !rcs.length;
  $('rdReceipts').innerHTML = rcs.map(x => receiptTile(x, false)).join('');
  const dels = r.deliveries || [];
  $('rdDeliveriesSec').hidden = !dels.length;
  $('rdDeliveries').innerHTML = dels.map(d => {
    const { short } = deliveryChecks(d);
    return `<div class="m-row"><span translate="no">${esc(FUEL_NAMES[d.fuel] || d.fuel)} · ${esc(d.supplier || '—')} · ${esc(d.note_no || '—')} · ${esc(d.truck_reg || '—')}</span>
      <span>${fmt(d.litres_received)} L${short > 0.5 ? ' <span class="bad">(short ' + fmt(short) + ' L)</span>' : ''}</span></div>`;
  }).join('');

  const num = v => Number(v || 0);

  // Header
  $('rdStation').textContent = r.station || 'Unknown Station';
  $('rdDate').textContent = r.report_date
    ? new Date(r.report_date + 'T00:00:00').toLocaleDateString(LOCALE,
        { weekday:'long', day:'numeric', month:'long', year:'numeric' })
    : (r.created_at ? new Date(r.created_at).toLocaleDateString(LOCALE) : '—');
  if (r.operator) $('rdDate').textContent += '  ·  Operator: ' + r.operator;
  if (r.last_edited_by && r.last_edited_by !== r.operator) $('rdDate').textContent += '  ·  Last changed by: ' + r.last_edited_by;

  // Fuel
  $('rdPetrol').textContent = fmtL(num(r.petrol_litres)) + ' L  ·  KES ' + fmt(num(r.petrol_litres) * num(r.petrol_price));
  $('rdDiesel').textContent = fmtL(num(r.diesel_litres)) + ' L  ·  KES ' + fmt(num(r.diesel_litres) * num(r.diesel_price));
  $('rdKero').textContent   = fmtL(num(r.kero_litres))   + ' L  ·  KES ' + fmt(num(r.kero_litres) * num(r.kero_price));
  $('rdTotalL').textContent = fmtL(num(r.total_litres)) + ' L';

  // Each pump's readings, then the sales-meter cross-check per fuel (only if recorded)
  const pumpSec = $('rdPumpSec'), pumpList = $('rdPumpItems');
  const moved = (id, kind) => Math.max(0, num(r[pumpField(id, kind + 'close')]) - num(r[pumpField(id, kind + 'open')]));
  const pumpRows = PUMPS.filter(([id]) => PUMP_READINGS.some(x => num(r[pumpField(id, x)])))
    .map(([id, fuel]) => `<div class="m-row"><span>⛽ ${pumpName(id)} · ${FUEL_LABEL[fuel]}</span>
      <span>${fmtL(moved(id, ''))} L${moved(id, 'sales_') ? ' · KES ' + fmt(moved(id, 'sales_')) : ''}</span></div>`);
  const fuelPumpData = [
    { label: 'Petrol', fuel: 'petrol', calcRev: num(r.petrol_litres) * num(r.petrol_price) },
    { label: 'Diesel', fuel: 'diesel', calcRev: num(r.diesel_litres) * num(r.diesel_price) },
    { label: 'Kerosene', fuel: 'kero', calcRev: num(r.kero_litres) * num(r.kero_price) },
  ].filter(f => num(r[f.fuel + '_sales_open']) || num(r[f.fuel + '_sales_close']));

  if (pumpRows.length || fuelPumpData.length) {
    pumpSec.style.display = 'block';
    pumpList.innerHTML = pumpRows.join('') + fuelPumpData.map(f => {
      const pumpTotal = r[f.fuel + '_pump_sales'] !== undefined ? num(r[f.fuel + '_pump_sales'])
        : Math.max(0, num(r[f.fuel + '_sales_close']) - num(r[f.fuel + '_sales_open']));
      const variance = r2(f.calcRev - pumpTotal);
      const color = Math.abs(variance) < 1 ? 'var(--acc)' : Math.abs(variance) < 50 ? 'var(--acc2)' : 'var(--red)';
      return `<div class="m-row"><span>${f.label} — Pump Sales Total</span><span>KES ${fmt(pumpTotal)}</span></div>
              <div class="m-row" style="padding-left:12px;font-size:.72rem"><span>↳ vs Calculated Revenue</span><span style="color:${color}">Variance: KES ${fmt(variance)}</span></div>`;
    }).join('');
  } else {
    pumpSec.style.display = 'none';
  }

  // Tank dip reconciliation (only shown if dip data was recorded)
  const dipSec = $('rdDipSec'), dipList = $('rdDipItems');
  const fuelDipData = [
    { label: 'Petrol', open: r.petrol_dip_open, delivered: r.petrol_delivered, close: r.petrol_dip_close, sold: num(r.petrol_litres) },
    { label: 'Diesel', open: r.diesel_dip_open, delivered: r.diesel_delivered, close: r.diesel_dip_close, sold: num(r.diesel_litres) },
    { label: 'Kerosene', open: r.kero_dip_open, delivered: r.kero_delivered, close: r.kero_dip_close, sold: num(r.kero_litres) },
  ].filter(f => num(f.open) || num(f.close));

  if (fuelDipData.length) {
    dipSec.style.display = 'block';
    dipList.innerHTML = fuelDipData.map(f => {
      const expected = r2(num(f.open) + num(f.delivered) - f.sold);
      const variance = r2(num(f.close) - expected);
      const color = Math.abs(variance) < 10 ? 'var(--acc)' : variance < 0 ? 'var(--red)' : 'var(--acc2)';
      const varLabel = Math.abs(variance) < 10 ? 'Within tolerance' : variance < 0 ? 'Stock short' : 'Stock surplus';
      return `<div class="m-row"><span>${f.label} — Expected Stock</span><span>${fmtL(expected)} L</span></div>
              <div class="m-row"><span>${f.label} — Closing Dip</span><span>${fmtL(num(f.close))} L</span></div>
              <div class="m-row" style="padding-left:12px;font-size:.72rem"><span>↳ ${varLabel}</span><span style="color:${color}">Variance: ${fmtL(variance)} L</span></div>`;
    }).join('');
  } else {
    dipSec.style.display = 'none';
  }

  // Gases & Lubricants (only show section if items exist)
  const gasSec = $('rdGasSec'), gasList = $('rdGasItems');
  if (r.gas_items && r.gas_items.length) {
    gasSec.style.display = 'block';
    gasList.innerHTML = r.gas_items.map(i =>
      `<div class="m-row"><span translate="no">${esc(i.name)} (${esc(i.category)}) — ${esc(i.qty)} × KES ${fmt(i.price)}</span><span>KES ${fmt(i.qty * i.price)}</span></div>`
    ).join('') + `<div class="m-row" style="border-top:1px solid var(--brd);margin-top:4px;padding-top:6px">
      <span><b>Gas/Lube Revenue</b></span><span>KES ${fmt(r.gas_lube_revenue || 0)}</span></div>`;
  } else {
    gasSec.style.display = 'none';
  }

  // Payments
  const collected = num(r.mpesa_amount) + num(r.cash_amount) + num(r.credit_amount) + num(r.card_amount);
  $('rdMpesa').textContent  = 'KES ' + fmt(num(r.mpesa_amount));
  $('rdCash').textContent   = 'KES ' + fmt(num(r.cash_amount));
  $('rdCredit').textContent = 'KES ' + fmt(num(r.credit_amount));
  $('rdCard').textContent   = 'KES ' + fmt(num(r.card_amount));
  $('rdTotalCollected').textContent = 'KES ' + fmt(collected);

  // Credit invoices (only show section if any exist)
  const invSec = $('rdInvoiceSec'), invList = $('rdInvoiceItems');
  if (r.invoices && r.invoices.length) {
    invSec.style.display = 'block';
    invList.innerHTML = r.invoices.map(inv =>
      `<div class="m-row"><span translate="no">${esc(inv.customer || '—')}${esc(inv.company ? ' · ' + inv.company : '')}${esc(inv.carReg ? ' · ' + inv.carReg : '')}</span><span>KES ${fmt(inv.amount || 0)}</span></div>`
    ).join('');
  } else {
    invSec.style.display = 'none';
  }

  // Expenses
  $('rdWages').textContent = 'KES ' + fmt(num(r.exp_wages));
  $('rdElec').textContent  = 'KES ' + fmt(num(r.exp_elec));
  $('rdWater').textContent = 'KES ' + fmt(num(r.exp_water));
  $('rdMaint').textContent = 'KES ' + fmt(num(r.exp_maint));
  $('rdLubes').textContent = 'KES ' + fmt(num(r.exp_lubes));
  $('rdMisc').textContent  = 'KES ' + fmt(num(r.exp_misc));

  const miscList = $('rdMiscItems');
  if (r.misc_items && r.misc_items.length) {
    miscList.innerHTML = r.misc_items.map(i =>
      `<div class="m-row" style="padding-left:12px;font-size:.72rem;color:var(--mut)"><span translate="no">↳ ${esc(i.name)}</span><span>KES ${fmt(i.amount)}</span></div>`
    ).join('');
  } else {
    miscList.innerHTML = '';
  }

  $('rdTotalExp').textContent = 'KES ' + fmt(num(r.total_expenses));

  // P&L
  $('rdGross').textContent     = 'KES ' + fmt(num(r.gross_revenue));
  $('rdTotalCost').textContent = 'KES ' + fmt(num(r.total_cost));
  $('rdProfit').textContent    = 'KES ' + fmt(num(r.net_profit));
  $('rdProfit').style.color    = num(r.net_profit) >= 0 ? 'var(--acc)' : 'var(--red)';
  $('rdMargin').textContent    = (num(r.profit_margin)).toFixed(1) + '%';

  // KRA
  $('rdVat').textContent    = 'KES ' + fmt(num(r.output_vat));
  $('rdExcise').textContent = 'KES ' + fmt(num(r.total_excise));
  $('rdTax').textContent    = 'KES ' + fmt(num(r.total_tax));
  $('rdKraPin').textContent  = r.kra_pin || '—';
  $('rdKraType').textContent = r.kra_return_type || '—';

  // Remarks
  const remarksSec = $('rdRemarksSec');
  if (r.kra_remarks) {
    remarksSec.style.display = 'block';
    $('rdRemarks').textContent = r.kra_remarks;
  } else {
    remarksSec.style.display = 'none';
  }

  $('detailOverlay').classList.add('open');
}

function closeDetail() {
  $('detailOverlay').classList.remove('open');
  DETAIL_ID = null;
}

// ── In-page confirm modal: replaces native confirm() which some browsers ──────
// silently suppress or auto-dismiss with no visible feedback to the user.
let _confirmResolve = null;

function showConfirmModal(title, message) {
  return new Promise(resolve => {
    $('confirmTitle').textContent = title;
    $('confirmMessage').textContent = message;
    _confirmResolve = resolve;
    $('confirmOverlay').classList.add('open');
  });
}

function closeConfirmModal(result) {
  $('confirmOverlay').classList.remove('open');
  if (_confirmResolve) {
    _confirmResolve(result);
    _confirmResolve = null;
  }
}

async function deleteFromDetail() {
  if (DETAIL_ID === null) return;
  const ok = await showConfirmModal('Move to Bin?', 'This record will be moved to the bin. An admin can restore it.');
  if (!ok) return;

  if (!requireOnline('delete records')) return;
  try {
    await api('DELETE', '/records/' + DETAIL_ID);
    toast('🗑️ Moved to the bin');
  } catch (e) {
    toast('⚠️ Delete failed: ' + e.message, true);
  }
  closeDetail();
  await refreshRecs();
}

// ── Analytics ─────────────────────────────────────────────────────────────────
function renderAnalytics() {

  // Last 7 days — sort newest first, take up to 7, reverse for chart order
  const sorted = [...RECS].sort((a, b) => {
    const da = a.report_date || a.created_at || '';
    const db = b.report_date || b.created_at || '';
    return db.localeCompare(da);
  });
  const week = sorted.slice(0, 7).reverse();

  renderBars('chartRev',    week, 'gross_revenue',  'var(--acc)');
  renderBars('chartProfit', week, 'net_profit',     'var(--purple)');
  renderBars('chartLit',    week, 'total_litres',   'var(--blue)');

  // All-time totals
  const totals = RECS.reduce((a, r) => {
    a.rev    += Number(r.gross_revenue  || 0);
    a.lit    += Number(r.total_litres   || 0);
    a.profit += Number(r.net_profit     || 0);
    a.tax    += Number(r.total_tax      || 0);
    a.mpesa  += Number(r.mpesa_amount   || 0);
    a.cash   += Number(r.cash_amount    || 0);
    a.days   += 1;
    return a;
  }, { rev:0, lit:0, profit:0, tax:0, mpesa:0, cash:0, days:0 });

  const allTimeEl = $('allTime');
  if (!allTimeEl) return;

  if (!RECS.length) {
    allTimeEl.innerHTML = `<div style="color:var(--mut);font-family:var(--mono);font-size:.74rem;padding:8px">
      No records yet — save a daily entry first.</div>`;
    return;
  }

  allTimeEl.innerHTML = [
    ['Days Recorded',      totals.days],
    ['Total Revenue',      'KES ' + fmt(totals.rev)],
    ['Total Litres Sold',  fmt(totals.lit) + ' L'],
    ...(seesProfit() ? [['Total Net Profit', 'KES ' + fmt(totals.profit)],
      ['Avg Daily Profit', 'KES ' + fmt(totals.days > 0 ? totals.profit / totals.days : 0)]] : []),
    ['Total M-Pesa',       'KES ' + fmt(totals.mpesa)],
    ['Total Cash',         'KES ' + fmt(totals.cash)],
    ['Total KRA Tax',      'KES ' + fmt(totals.tax)],
  ].map(([k, v]) =>
    `<div class="stat-row"><span>${k}</span><span>${v}</span></div>`
  ).join('');
}

// ── Bar chart renderer ────────────────────────────────────────────────────────
function renderBars(id, data, field, color) {
  const el = $(id);
  if (!el) return;

  if (!data || !data.length) {
    el.innerHTML = `<div style="color:var(--mut);font-family:var(--mono);
      font-size:.74rem;padding:8px 0">No data yet — save records to see charts.</div>`;
    return;
  }

  const max = Math.max(...data.map(r => Math.abs(Number(r[field]) || 0)), 1);

  el.innerHTML = data.map(r => {
    const v   = Number(r[field]) || 0;
    const pct = Math.min((Math.abs(v) / max * 100), 100).toFixed(1);
    const lbl = (r.report_date || '').substring(5) || '—';
    const barColor = v < 0 ? 'var(--red)' : color;
    return `<div class="cb-row">
      <div class="cb-lbl" title="${esc(r.report_date || '')}">${esc(lbl)}</div>
      <div class="cb-track">
        <div class="cb-fill" style="width:${pct}%;background:${barColor}"></div>
      </div>
      <div class="cb-val">${v < 0 ? '-' : ''}${fmt(Math.abs(v))}</div>
    </div>`;
  }).join('');
}

// ── KRA Modal ─────────────────────────────────────────────────────────────────
function openKra() {
  const c = COMP;
  $('mPin').textContent    = sv('kPin')||'—';
  $('mBiz').textContent    = sv('kBiz')||'—';
  $('mPeriod').textContent = sv('kPeriod')||'—';
  $('mRType').textContent  = sv('kReturnType')||'—';
  $('mEtr').textContent    = sv('kEtr')||'—';
  $('mDate').textContent   = sv('fDate')||new Date().toLocaleDateString(LOCALE);
  $('mPL').textContent     = fmtL(c.pL)+' L';
  $('mDL').textContent     = fmtL(c.dL)+' L';
  $('mKL').textContent     = fmtL(c.kL)+' L';
  $('mGross').textContent  = 'KES '+fmt(c.grossRev);
  $('mExVat').textContent  = 'KES '+fmt(c.exVat);
  $('mVat').textContent    = 'KES '+fmt(c.outputVAT);
  $('mExcP').textContent   = 'KES '+fmt(c.excP);
  $('mExcD').textContent   = 'KES '+fmt(c.excD);
  $('mExcK').textContent   = 'KES '+fmt(c.excK);
  $('mRLP').textContent    = 'KES '+fmt(c.rlP);
  $('mRLD').textContent    = 'KES '+fmt(c.rlD);
  $('mTotal').textContent  = 'KES '+fmt(c.totalTax);
  $('mRemarks').textContent = sv('kRemarks')||'None';
  $('kraOverlay').classList.add('open');
}
function closeKra() { $('kraOverlay').classList.remove('open'); }
$('kraOverlay').addEventListener('click', e => { if(e.target===$('kraOverlay')) closeKra(); });
$('detailOverlay').addEventListener('click', e => { if(e.target===$('detailOverlay')) closeDetail(); });
$('confirmOverlay').addEventListener('click', e => { if(e.target===$('confirmOverlay')) closeConfirmModal(false); });
$('accountOverlay').addEventListener('click', e => { if(e.target===$('accountOverlay')) closeAccount(); });

// ── Export CSV ────────────────────────────────────────────────────────────────
function exportCSV() {
  if (!RECS.length) { toast('⚠️ No records to export yet', true); return; }
  let cols = [
    'report_date','station','operator',
    'petrol_litres','diesel_litres','kero_litres','total_litres',
    'gross_revenue','mpesa_amount','cash_amount','credit_amount','card_amount',
    'total_expenses','net_profit','profit_margin',
    'output_vat','total_excise','total_tax',
    'kra_pin','kra_business','kra_period','kra_return_type',
    'created_at'
  ];
  const escape = v => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  };
  if (!seesProfit()) cols = cols.filter(c => !['net_profit', 'profit_margin'].includes(c));
  const hdr  = cols.join(',');
  const rows  = RECS.map(r => cols.map(c => escape(r[c])).join(','));
  const blob  = new Blob([hdr + '\n' + rows.join('\n')], { type: 'text/csv' });
  const a     = document.createElement('a');
  a.href      = URL.createObjectURL(blob);
  a.download  = `PetroKenya_${sv('fStation').replace(/\s+/g,'-') || 'Station'}_${todayLocal()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
  toast('📥 CSV exported — ' + RECS.length + ' records');
}

// ── Clear ─────────────────────────────────────────────────────────────────────
async function clearAll() {
  const ok = await showConfirmModal(
    'Clear All Form Data?',
    "This also clears today's invoice, misc, and gas/lube item lists."
  );
  if (!ok) return;
  document.querySelectorAll('input[type="number"]').forEach(i => { if(!i.readOnly) i.value=''; });
  ['kPin','kBiz','kPeriod','kBranch','kEtr','fMpesaTill','fMpesaRef','fCreditCust','kRemarks']
    .forEach(id => $(id) && ($(id).value=''));
  INVOICES = [];
  MISC_ITEMS = [];
  GAS_ITEMS = [];
  DELIVERIES = [];
  renderDeliveries();
  ATTENDANTS = [];
  renderAttendants();
  RECEIPTS = [];
  renderReceipts();
  if ($('fCredit')) { $('fCredit').readOnly = false; $('fCredit').value = ''; }
  if ($('eMisc')) { $('eMisc').value = ''; }
  renderInvoices();
  renderMiscItems();
  renderGasItems();
  calc();
  toast('🗑️ Form, invoices, misc items, and gas/lube sales cleared');
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, isErr=false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (isErr?' e':'');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.className = '', 3200);
}

// ── Init ──────────────────────────────────────────────────────────────────────
// ── Get today's date in local time as YYYY-MM-DD (not UTC — avoids off-by-one) ──
// Today's date in Kenya (YYYY-MM-DD), whatever time zone the phone is set to, so the
// app and the server always agree on which day it is
function todayLocal() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(new Date());
  } catch (e) {
    const d = new Date(Date.now() + 3 * 3600 * 1000);       // EAT is UTC+3 all year
    return d.toISOString().slice(0, 10);
  }
}

// ── Apply today's date to the date field + header ────────────────────────────
function applyTodayDate() {
  const dateEl = $('fDate');
  if (dateEl) { dateEl.value = todayLocal(); dateEl.max = todayLocal(); }
  const now = new Date();
  $('hDate').textContent = now.toLocaleDateString(LOCALE,
    { weekday:'short', day:'numeric', month:'short', year:'numeric' });
}

// ── Watch for midnight rollover while the app stays open ─────────────────────
function startMidnightWatcher() {
  let lastKnownDate = todayLocal();
  setInterval(() => {
    const nowDate = todayLocal();
    if (nowDate !== lastKnownDate) {
      lastKnownDate = nowDate;
      applyTodayDate();
      loadRecordForDateAndStation();
      toast('📅 New day started — date auto-updated to ' + nowDate);
    }
  }, 60000); // check every minute
}

// ── Installable app: service worker caches the app shell for offline start ────
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(e => console.warn('SW registration failed:', e));
  }
}

// Android/Chrome "Install app" prompt → show our own install button
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  $('installBtn').style.display = '';
});
async function installApp() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('installBtn').style.display = 'none';
}

async function init() {
  // Auto-set today's date (local time, Kenya-correct)
  applyTodayDate();
  $('hStation').textContent = sv('fStation') || 'PetroKenya';
  registerServiceWorker();
  renderInvoices();
  renderMiscItems();
  renderGasItems();
  renderDeliveries();
  renderAttendants();
  renderReceipts();
  calc();

  // Who is signed in? Offline, fall back to the last signed-in user (read-only)
  try {
    USER = (await api('GET', '/me')).user;
    storeSet('pk_user', USER);
  } catch (e) {
    if (ONLINE) return;            // 401 → api() already opened the sign-in screen
    USER = storeGet('pk_user');
    if (!USER) { showLogin('You are offline. Connect to the internet to sign in.'); return; }
  }
  await startSession();
}

// Keep the date correct automatically if the app is left open overnight
startMidnightWatcher();
route();

// Re-sync date and records when the app comes back to the foreground (phone unlock, tab switch)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !USER) return;
  const nowDate = todayLocal();
  if ($('fDate') && $('fDate').value !== nowDate && !$('fDate').dataset.userEdited) {
    applyTodayDate();
    loadRecordForDateAndStation();
  }
  refreshRecs();
});
window.addEventListener('online', async () => {
  if (!USER) return;
  try { await api('GET', '/me'); } catch (e) { return; }
  await flushOutbox();
  refreshRecs();
});
window.addEventListener('offline', () => setOnline(false));

init();
