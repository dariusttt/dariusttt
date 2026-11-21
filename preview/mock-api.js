/* ══════════════════════════════════════════════════════════════════════════════
   PetroKenya — in-browser stand-in for backend/server.py, used ONLY by the
   website preview (preview/build_preview.py). It answers the app's /api calls
   from data kept in this browser, follows the same rules as the real server
   (roles, locks, history, bin, prices, alerts, credit, reports) and starts with
   clearly marked example data. Nothing here is used by the real app.
   ══════════════════════════════════════════════════════════════════════════════ */
(function () {
  const DB_KEY = 'pkdemo_db_v1', SESSION_KEY = 'pkdemo_session_v1';
  const EXAMPLE_STATIONS = ['Ngeria Branch', 'Himaki Branch', 'Moiben Branch'];   // the example's branches
  const FUELS = ['petrol', 'diesel', 'kero'];
  // Same pumps as backend/server.py: three petrol, three diesel, one kerosene
  const PUMPS = [['p1', 'petrol'], ['p2', 'petrol'], ['p3', 'petrol'], ['d1', 'diesel'], ['d2', 'diesel'], ['d3', 'diesel'], ['k1', 'kero']];
  const READINGS = ['open', 'close', 'sales_open', 'sales_close'];
  const pf = (id, x) => 'pump_' + id + '_' + x;
  const hasPumps = (raw, fuel) => PUMPS.some(([id, f]) => f === fuel && READINGS.some(x => num(raw[pf(id, x)])));
  function meterTotal(raw, fuel, kind) {
    if (hasPumps(raw, fuel)) return r2(PUMPS.filter(p => p[1] === fuel)
      .reduce((s, [id]) => s + Math.max(0, num(raw[pf(id, kind + 'close')]) - num(raw[pf(id, kind + 'open')])), 0));
    return r2(Math.max(0, num(raw[fuel + '_' + kind + 'close']) - num(raw[fuel + '_' + kind + 'open'])));
  }
  function rollUpPumps(rec) {
    FUELS.forEach(fuel => { if (hasPumps(rec, fuel)) READINGS.forEach(x => {
      rec[fuel + '_' + x] = r2(PUMPS.filter(p => p[1] === fuel).reduce((s, [id]) => s + num(rec[pf(id, x)]), 0)); }); });
  }
  const FUEL_NAMES = { petrol: 'Petrol', diesel: 'Diesel', kero: 'Kerosene' };
  const VAT = 0.16, EX = { petrol: 21.95, diesel: 7.21, kero: 7.19 };
  const DEFAULT_SETTINGS = { dip_shortage_litres: 50, cash_shortage_kes: 1000, attendant_shortage_kes: 500,
    short_delivery_litres: 50, low_stock_petrol: 3000, low_stock_diesel: 3000, low_stock_kero: 1000, alert_emails: '', backup_emails: '' };

  const num = v => { const f = parseFloat(v); return Number.isFinite(f) ? f : 0; };
  const r2 = v => Math.round((v + Number.EPSILON) * 100) / 100;
  const nowIso = () => new Date().toISOString();
  const kenyaToday = () => {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(new Date()); }
    catch (e) { return new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); }
  };
  const daysBefore = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - n); return x.toISOString().slice(0, 10); };
  const niceDate = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  const money = v => v.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fail = (status, error) => { const e = new Error(error); e.status = status; throw e; };

  // ── Storage ─────────────────────────────────────────────────────────────────
  let memory = null;
  function load() {
    if (memory) return memory;
    try { memory = JSON.parse(localStorage.getItem(DB_KEY)); } catch (e) { memory = null; }
    if (!memory || memory.version !== 5) memory = seed();
    return memory;
  }
  function save() { try { localStorage.setItem(DB_KEY, JSON.stringify(memory)); } catch (e) { /* kept in memory */ } }
  const nextId = (db, k) => (db.seq[k] = (db.seq[k] || 0) + 1);

  // ── Figures (same as compute() in backend/server.py) ───────────────────────
  function compute(raw) {
    const g = k => num(raw[k]);
    const gas = raw.gas_items || [], misc = raw.misc_items || [];
    const line = i => num(i.qty) * num(i.price);
    const gasLube = r2(gas.reduce((s, i) => s + line(i), 0));
    const L = {}, rev = {}, fc = {};
    FUELS.forEach(f => {
      L[f] = meterTotal(raw, f, '');
      rev[f] = r2(L[f] * g(f + '_price')); fc[f] = r2(L[f] * g(f + '_cost'));
    });
    const totalL = r2(L.petrol + L.diesel + L.kero);
    const gross = r2(rev.petrol + rev.diesel + rev.kero + gasLube);
    const totalFC = r2(fc.petrol + fc.diesel + fc.kero);
    const out = {};
    FUELS.forEach(f => {
      out[f + '_litres'] = r2(L[f]);
      out[f + '_pump_sales'] = meterTotal(raw, f, 'sales_');
      const expected = r2(g(f + '_dip_open') + g(f + '_delivered') - L[f]);
      out[f + '_expected_stock'] = expected;
      out[f + '_dip_variance'] = r2(g(f + '_dip_close') - expected);
    });
    const collected = r2(g('mpesa_amount') + g('cash_amount') + g('credit_amount') + g('card_amount'));
    const expMisc = misc.length ? r2(misc.reduce((s, i) => s + num(i.amount), 0)) : g('exp_misc');
    const totalExp = r2(g('exp_wages') + g('exp_elec') + g('exp_water') + g('exp_maint') + g('exp_lubes') + expMisc);
    const net = r2(gross - totalFC - totalExp);
    const exVat = r2(gross / (1 + VAT)), vat = r2(gross - exVat);
    const excise = r2(L.petrol * EX.petrol + L.diesel * EX.diesel + L.kero * EX.kero);
    const gaps = (raw.attendants || []).map(a => num(a.expected) - num(a.cash) - num(a.mpesa));
    return Object.assign(out, {
      total_litres: totalL, gas_lube_revenue: gasLube, gross_revenue: gross, total_fuel_cost: totalFC,
      exp_misc: expMisc, total_expenses: totalExp, total_cost: r2(totalFC + totalExp), net_profit: net,
      profit_margin: gross > 0 ? r2(net / gross * 100) : 0, collected, collection_variance: r2(gross - collected),
      output_vat: vat, total_excise: excise, total_tax: r2(vat + excise),
      delivery_shortfall_litres: r2((raw.deliveries || []).reduce((s, d) =>
        s + Math.max(0, num(d.litres_ordered) - num(d.litres_received)), 0)),
      attendant_shortage_total: r2(gaps.filter(x => x > 0).reduce((s, x) => s + x, 0)),
      attendant_excess_total: r2(-gaps.filter(x => x < 0).reduce((s, x) => s + x, 0)),
    });
  }

  // ── Users and sessions ──────────────────────────────────────────────────────
  const publicUser = u => ({ id: u.id, username: u.username, full_name: u.full_name || null,
    display_name: u.full_name || u.username, role: u.role, station: u.station || null, created_at: u.created_at,
    email: u.email || null, phone: u.phone || null });
  const COMMON = ['password', 'password1', 'password123', '12345678', '123456789', 'qwerty123', 'admin123', 'kenya123', 'safaricom'];
  function checkPassword(pw, username) {
    if (typeof pw !== 'string' || pw.length < 8) fail(400, 'Password must be at least 8 characters');
    const low = pw.toLowerCase();
    if (COMMON.includes(low) || new Set(low).size <= 2) fail(400, 'That password is too easy to guess — choose another');
    if (username && low.includes(username.toLowerCase())) fail(400, 'Password must not contain the username');
  }
  function currentUser(db) {
    let id = null;
    try { id = Number(sessionStorage.getItem(SESSION_KEY)); } catch (e) { id = memory && memory._session; }
    return db.users.find(u => u.id === id) || null;
  }
  function setSession(id) {
    try { if (id) sessionStorage.setItem(SESSION_KEY, id); else sessionStorage.removeItem(SESSION_KEY); }
    catch (e) { memory._session = id; }
  }
  const scope = (user, requested) => {
    if ((user.role === 'staff' || user.role === 'manager') && user.station) {
      if (requested && requested !== user.station) fail(403, 'You can only access ' + user.station);
      return user.station;
    }
    return requested || null;
  };
  const requireAdmin = u => { if (u.role !== 'admin') fail(403, 'Admins only'); };

  // ── Records ─────────────────────────────────────────────────────────────────
  const live = db => db.records.filter(r => !r.deleted_at);
  function version(db, rec, action, by) {
    db.versions.push({ record_id: rec.id, action, by: by || 'system', at: nowIso(), data: JSON.parse(JSON.stringify(rec)) });
  }
  function checkEditable(user, date, existing) {
    if (date > kenyaToday()) fail(400, "You can't save a record for a future date");
    if (existing && existing.approved_at) fail(409, 'This day is approved and locked — an admin must reopen it first');
    if (user.role === 'staff' && date < daysBefore(kenyaToday(), 1))
      fail(403, 'Records older than yesterday are locked — ask a manager or admin to change them');
  }
  function effectivePrices(db, station, date) {
    const out = {};
    FUELS.forEach(f => {
      const p = db.prices.filter(x => x.station === station && x.fuel === f && x.effective_from <= date)
        .sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.id - a.id)[0];
      if (p) out[f] = { sell: p.sell, cost: p.cost, effective_from: p.effective_from, set_by: p.set_by };
    });
    return out;
  }
  function previous(db, station, date) {
    return live(db).filter(r => r.station === station && r.report_date < date)
      .sort((a, b) => b.report_date.localeCompare(a.report_date))[0] || null;
  }
  const openPairs = prev => [
    ...PUMPS.filter(([, f]) => hasPumps(prev, f)).flatMap(([id]) => [[pf(id, 'open'), pf(id, 'close')], [pf(id, 'sales_open'), pf(id, 'sales_close')]]),
    ...FUELS.filter(f => !hasPumps(prev, f)).flatMap(f => [[f + '_open', f + '_close'], [f + '_sales_open', f + '_sales_close']]),
    ...FUELS.map(f => [f + '_dip_open', f + '_dip_close'])];
  function prepare(db, rec, existing, user) {
    const prices = effectivePrices(db, rec.station, rec.report_date);
    if (user && user.role === 'staff') {      // staff never see or send cost prices
      const from = existing || previous(db, rec.station, rec.report_date) || {};
      FUELS.forEach(f => { rec[f + '_cost'] = num(from[f + '_cost']); });
    }
    Object.entries(prices).forEach(([f, p]) => { rec[f + '_price'] = p.sell; rec[f + '_cost'] = p.cost; });
    rec.prices_set_by_owner = Object.keys(prices).sort();
    const prev = previous(db, rec.station, rec.report_date);
    rec.opening_mismatches = prev ? openPairs(prev).filter(([o, c]) => num(prev[c]) > 0 && Math.abs(num(prev[c]) - num(rec[o])) > 0.005)
      .map(([o, c]) => ({ field: o, expected: num(prev[c]), entered: num(rec[o]), from_date: prev.report_date })) : [];
    const dels = (rec.deliveries || []).filter(d => FUELS.includes(d.fuel));
    rec.deliveries = dels;
    if (dels.length) FUELS.forEach(f => { rec[f + '_delivered'] = r2(dels.filter(d => d.fuel === f).reduce((s, d) => s + num(d.litres_received), 0)); });
    rec.receipts = (rec.receipts || []).filter(x => db.uploads[x.upload_id] && db.uploads[x.upload_id].station === rec.station);
    const name = user.full_name || user.username;
    if (existing && existing.operator) {
      rec.operator = existing.operator; rec.operator_username = existing.operator_username;
    } else { rec.operator = name; rec.operator_username = user.username; }
    rec.saved_by = user.username; rec.last_edited_by = name;
  }
  function saveRecord(db, body, user, recId) {
    const date = String(body.report_date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(400, 'report_date is required (YYYY-MM-DD)');
    if (!body.station) fail(400, 'station is required');
    scope(user, body.station);
    if (!(db.stations || []).includes(body.station)) fail(400, 'Unknown branch — the admin adds branches under 👤 Account');
    const any = recId ? db.records.find(r => r.id === recId) : db.records.find(r => r.report_date === date && r.station === body.station);
    const existing = any && !any.deleted_at ? any : null;
    if (recId && !existing) fail(404, 'Record not found');
    checkEditable(user, date, any);
    if (existing) checkEditable(user, existing.report_date, existing);
    const rec = JSON.parse(JSON.stringify(body));
    ['id', 'uid', 'approved_at', 'approved_by', 'deleted_at', 'deleted_by', 'created_at', 'updated_at', 'pending', 'pending_error'].forEach(k => delete rec[k]);
    rollUpPumps(rec);
    prepare(db, rec, existing, user);
    Object.assign(rec, compute(rec));
    const created = !any || !!any.deleted_at;
    let row = any;
    if (!row) { row = { id: nextId(db, 'record'), created_at: nowIso() }; db.records.push(row); }
    Object.keys(row).forEach(k => { if (!['id', 'created_at', 'approved_at', 'approved_by'].includes(k)) delete row[k]; });
    Object.assign(row, rec, { uid: 'rec_' + row.id, updated_at: nowIso(), deleted_at: null, deleted_by: null });
    version(db, row, created ? 'create' : 'update', user.username);
    syncAlerts(db, row);
    return { created, record: row };
  }
  const HIST_SKIP = new Set(['id', 'uid', 'created_at', 'updated_at', 'operator', 'operator_username', 'saved_by', 'last_edited_by',
    'approved_at', 'approved_by', 'deleted_at', 'deleted_by', 'opening_mismatches', 'prices_set_by_owner']);
  function history(db, id) {
    const rows = db.versions.filter(v => v.record_id === id);
    const computed = new Set(Object.keys(compute({})));
    return rows.map((v, i) => {
      const prev = i ? rows[i - 1].data : null, changes = [];
      if (prev && (v.action === 'update' || v.action === 'create')) {
        new Set([...Object.keys(prev), ...Object.keys(v.data)]).forEach(k => {
          if (HIST_SKIP.has(k) || computed.has(k)) return;
          if (JSON.stringify(prev[k]) !== JSON.stringify(v.data[k])) changes.push({ field: k, before: prev[k], after: v.data[k] });
        });
      }
      return { version: i + 1, action: v.action, by: v.by, at: v.at, changes };
    });
  }

  // ── Alerts ──────────────────────────────────────────────────────────────────
  const TITLES = { dip_shortage: 'Tank stock short', low_stock: 'Low tank stock', cash_shortage: 'Cash short',
    attendant_shortage: 'Attendant short', opening_mismatch: 'Opening readings changed', short_delivery: 'Short delivery' };
  function evaluate(db, r) {
    const s = db.settings, where = r.station + ', ' + niceDate(r.report_date), out = [];
    FUELS.forEach(f => {
      const close = num(r[f + '_dip_close']); if (close <= 0) return;
      const v = num(r[f + '_dip_variance']);
      if (v < -s.dip_shortage_litres) out.push(['dip_shortage', f, `${FUEL_NAMES[f]} tank is ${Math.round(-v).toLocaleString('en-KE')} L short of expected stock — ${where}`]);
      const lvl = s['low_stock_' + f];
      if (lvl && close < lvl) out.push(['low_stock', f, `${FUEL_NAMES[f]} stock is low: ${Math.round(close).toLocaleString('en-KE')} L left (reorder level ${lvl.toLocaleString('en-KE')} L) — ${where}`]);
    });
    if (num(r.collection_variance) > s.cash_shortage_kes) out.push(['cash_shortage', 'day', `Money collected is KES ${money(num(r.collection_variance))} less than sales — ${where}`]);
    (r.attendants || []).forEach(a => {
      const short = num(a.expected) - num(a.cash) - num(a.mpesa);
      if (short > s.attendant_shortage_kes) out.push(['attendant_shortage', String(a.name), `${a.name} handed in KES ${money(short)} less than their sales — ${where}`]);
    });
    const m = r.opening_mismatches || [];
    if (m.length) out.push(['opening_mismatch', 'day', `${m.length} opening reading${m.length === 1 ? '' : 's'} differ from the previous day's closing — ${where}`]);
    (r.deliveries || []).forEach((d, i) => {
      const short = num(d.litres_ordered) - num(d.litres_received);
      if (num(d.litres_ordered) > 0 && short > s.short_delivery_litres)
        out.push(['short_delivery', String(d.note_no || i), `${FUEL_NAMES[d.fuel] || 'Fuel'} delivery ${d.note_no || ''} was ${Math.round(short)} L short of the order — ${where}`]);
    });
    return out;
  }
  function syncAlerts(db, r) {
    const found = new Map(evaluate(db, r).map(([k, key, msg]) => [k + '|' + key, msg]));
    db.alerts.filter(a => a.record_id === r.id && !a.cleared_at).forEach(a => {
      const id = a.kind + '|' + a.key;
      if (found.has(id)) { a.message = found.get(id); found.delete(id); } else a.cleared_at = nowIso();
    });
    found.forEach((msg, id) => {
      const [kind, key] = id.split('|');
      db.alerts.push({ id: nextId(db, 'alert'), record_id: r.id, station: r.station, report_date: r.report_date,
        kind, key, message: msg, created_at: nowIso(), cleared_at: null, emailed: false, read_by: [] });
    });
  }
  const clearAlerts = (db, id) => db.alerts.forEach(a => { if (a.record_id === id && !a.cleared_at) a.cleared_at = nowIso(); });

  // ── Credit accounts ─────────────────────────────────────────────────────────
  function customers(db) {
    const inv = {}, paid = {};
    live(db).forEach(r => (r.invoices || []).forEach(i => { const c = Number(i.customer_id); if (c) inv[c] = (inv[c] || 0) + num(i.amount); }));
    db.payments.filter(p => !p.voided_at).forEach(p => { paid[p.customer_id] = (paid[p.customer_id] || 0) + p.amount; });
    return db.customers.map(c => {
      const invoiced = r2(inv[c.id] || 0), pd = r2(paid[c.id] || 0), balance = r2(invoiced - pd);
      return { ...c, invoiced, paid: pd, balance, over_limit: !!(c.credit_limit && balance > c.credit_limit) };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }
  function statement(db, cid) {
    const customer = customers(db).find(c => c.id === cid);
    if (!customer) fail(404, 'Customer not found');
    const entries = [];
    live(db).forEach(r => (r.invoices || []).forEach(i => {
      if (Number(i.customer_id) === cid) entries.push({ type: 'invoice', date: r.report_date, station: r.station,
        detail: [i.invoiceNo, i.fuelType, i.carReg].filter(Boolean).join(' · '), amount: r2(num(i.amount)), record_id: r.id });
    }));
    db.payments.filter(p => p.customer_id === cid && !p.voided_at).forEach(p => entries.push({ type: 'payment', date: p.paid_on,
      station: p.station, detail: [p.method, p.reference, 'by ' + p.by_user].filter(Boolean).join(' · '), amount: -p.amount, payment_id: p.id }));
    entries.sort((a, b) => a.date.localeCompare(b.date) || (a.type === 'invoice' ? -1 : 1));
    let bal = 0;
    entries.forEach(e => { bal = r2(bal + e.amount); e.balance = bal; });
    return { customer, entries };
  }

  // ── Monthly report ──────────────────────────────────────────────────────────
  const REPORT_FIELDS = [['petrol_litres', 'Petrol litres'], ['diesel_litres', 'Diesel litres'], ['kero_litres', 'Kerosene litres'],
    ['total_litres', 'Total litres'], ['gross_revenue', 'Sales (KES)'], ['total_fuel_cost', 'Fuel cost (KES)'],
    ['total_expenses', 'Expenses (KES)'], ['net_profit', 'Net profit (KES)'], ['output_vat', 'VAT (KES)'],
    ['total_excise', 'Excise (KES)'], ['total_tax', 'Tax total (KES)'], ['mpesa_amount', 'M-Pesa (KES)'],
    ['cash_amount', 'Cash (KES)'], ['card_amount', 'Card (KES)'], ['credit_amount', 'Credit sales (KES)'],
    ['collection_variance', 'Sales not collected (KES)'], ['attendant_shortage_total', 'Attendant shortages (KES)'],
    ['petrol_delivered', 'Petrol delivered (L)'], ['diesel_delivered', 'Diesel delivered (L)'], ['kero_delivered', 'Kerosene delivered (L)'],
    ['delivery_shortfall_litres', 'Delivery shortfall (L)'], ['dip_variance_total', 'Dip variance (L)']];
  function monthly(recs, month) {
    const by = {}, daily = [];
    recs.slice().sort((a, b) => a.report_date.localeCompare(b.report_date) || a.station.localeCompare(b.station)).forEach(r => {
      const b = by[r.station] || (by[r.station] = Object.assign({ station: r.station, days: 0, approved_days: 0, flagged_days: 0 },
        Object.fromEntries(REPORT_FIELDS.map(([k]) => [k, 0]))));
      b.days++; if (r.approved_at) b.approved_days++; if ((r.opening_mismatches || []).length) b.flagged_days++;
      const dipVar = FUELS.reduce((s, f) => s + (num(r[f + '_dip_close']) > 0 ? num(r[f + '_dip_variance']) : 0), 0);
      REPORT_FIELDS.forEach(([k]) => { b[k] += k === 'dip_variance_total' ? dipVar : num(r[k]); });
      daily.push({ date: r.report_date, station: r.station, gross_revenue: r2(num(r.gross_revenue)),
        net_profit: r2(num(r.net_profit)), total_litres: r2(num(r.total_litres)), approved: !!r.approved_at });
    });
    const branches = Object.values(by).sort((a, b) => a.station.localeCompare(b.station))
      .map(b => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, typeof v === 'number' ? r2(v) : v])));
    const totals = { station: 'All branches', days: 0, approved_days: 0, flagged_days: 0 };
    branches.forEach(b => { totals.days += b.days; totals.approved_days += b.approved_days; totals.flagged_days += b.flagged_days; });
    REPORT_FIELDS.forEach(([k]) => { totals[k] = r2(branches.reduce((s, b) => s + b[k], 0)); });
    return { month, fields: REPORT_FIELDS.map(([key, label]) => ({ key, label })), branches, totals, daily };
  }

  // ── Example data for a first visit ─────────────────────────────────────────
  function seed() {
    const db = { version: 5, seq: {}, users: [], records: [], versions: [], prices: [], alerts: [], customers: [],
      payments: [], uploads: {}, settings: { ...DEFAULT_SETTINGS } };
    memory = db;
    const t = kenyaToday();
    const mk = (username, password, role, station, full_name) =>
      db.users.push({ id: nextId(db, 'user'), username, password, role, station, full_name, created_at: nowIso() });
    mk('owner', 'Fuel-Station-77', 'admin', null, 'Example Owner');
    mk('mary', 'Branch-Boss-55', 'manager', 'Ngeria Branch', 'Mary Wanjiku (example)');
    mk('brian', 'Pump-Shift-55', 'staff', 'Ngeria Branch', 'Brian Otieno (example)');
    const owner = db.users[0], brian = db.users[2], mary = db.users[1];
    const P = { petrol: [186.31, 171.2], diesel: [171.6, 158.4], kero: [161.75, 149.1] };
    db.stations = [...EXAMPLE_STATIONS];
    EXAMPLE_STATIONS.forEach(st => FUELS.forEach(f => db.prices.push({ id: nextId(db, 'price'), station: st, fuel: f,
      sell: P[f][0], cost: P[f][1], effective_from: daysBefore(t, 20), set_by: 'owner' })));
    db.customers.push({ id: nextId(db, 'customer'), name: 'Example: Peter Otieno', company: 'Example Matatu Sacco',
      phone: '0722 000 000', credit_limit: 20000, created_by: 'owner', created_at: nowIso() });
    let pd = 19500, dd = 14200, kd = 4600;
    // Each pump's litres and sales (KES) meters run on from day to day
    const meters = { p1: [61200, 11402000], p2: [58350, 10871000], p3: [60450, 11267000],
      d1: [31800, 5457000], d2: [33100, 5680000], d3: [29100, 4993000], k1: [19800, 3202000] };
    const share = { p1: .45, p2: .35, p3: .2, d1: .5, d2: .3, d3: .2, k1: 1 };
    for (let i = 6; i >= 1; i--) {
      const date = daysBefore(t, i), pl = 1550 + (i * 37) % 160, dl = 1180 + (i * 53) % 140, kl = 170 + (i * 11) % 30;
      const delivery = i === 4 ? 10000 : 0;
      const body = { report_date: date, station: 'Ngeria Branch', shift: 'Full Day',
        petrol_dip_open: pd, petrol_delivered: delivery, petrol_dip_close: pd + delivery - pl - (i === 3 ? 140 : 8),
        diesel_dip_open: dd, diesel_dip_close: dd - dl - 6, kero_dip_open: kd, kero_dip_close: kd - kl - 2,
        mpesa_amount: 0, cash_amount: 0, exp_wages: 9600, exp_elec: 3200, exp_water: 450,
        deliveries: delivery ? [{ id: 1, fuel: 'petrol', supplier: 'Example: Vivo Energy', note_no: 'DN-20431', truck_reg: 'KCB 456T',
          litres_ordered: 10000, litres_received: delivery, dip_before: pd - 700, dip_after: pd - 700 + delivery - 15 }] : [],
        invoices: i === 2 ? [{ id: 1, invoiceNo: 'INV-EX-001', customer: 'Example: Peter Otieno', company: 'Example Matatu Sacco',
          carReg: 'KDA 123X', fuelType: 'Diesel', amount: 12500, customer_id: 1 }] : [],
        attendants: [{ id: 1, name: 'Example: Brian Otieno', expected: 0, cash: 0, mpesa: 0 }] };
      const sold = { petrol: pl, diesel: dl, kero: kl };
      FUELS.forEach(fuel => {
        const ids = PUMPS.filter(x => x[1] === fuel).map(x => x[0]);
        let left = sold[fuel];
        ids.forEach((id, n) => {
          const litres = n === ids.length - 1 ? left : Math.round(sold[fuel] * share[id]);
          left -= litres;
          const [lm, sm] = meters[id];
          Object.assign(body, { [pf(id, 'open')]: lm, [pf(id, 'close')]: lm + litres,
            [pf(id, 'sales_open')]: sm, [pf(id, 'sales_close')]: r2(sm + litres * P[fuel][0]) });
          meters[id] = [lm + litres, r2(sm + litres * P[fuel][0])];
        });
      });
      const figs = compute({ ...body, petrol_price: P.petrol[0], diesel_price: P.diesel[0], kero_price: P.kero[0] });
      const credit = body.invoices.reduce((s, x) => s + x.amount, 0);
      const toCollect = figs.gross_revenue - credit - (i === 5 ? 1800 : 0);
      body.credit_amount = credit;
      body.mpesa_amount = r2(toCollect * 0.62); body.cash_amount = r2(toCollect - body.mpesa_amount);
      body.attendants[0].expected = r2(figs.gross_revenue - credit);
      body.attendants[0].mpesa = body.mpesa_amount; body.attendants[0].cash = r2(body.cash_amount - (i === 5 ? 0 : 0));
      const rec = saveRecord(db, body, i === 1 ? brian : mary).record;
      if (i >= 3) { rec.approved_at = nowIso(); rec.approved_by = 'mary'; version(db, rec, 'approve', 'mary'); }
      pd = body.petrol_dip_close; dd = body.diesel_dip_close; kd = body.kero_dip_close;
    }
    // One correction, so the change history has something to show
    const y = db.records[db.records.length - 1];
    saveRecord(db, { ...y, exp_maint: 2500 }, owner);
    db.payments.push({ id: nextId(db, 'payment'), customer_id: 1, paid_on: daysBefore(t, 1), amount: 5000, method: 'M-Pesa',
      reference: 'RGK7ABC123', station: 'Ngeria Branch', by_user: 'mary', at: nowIso(), voided_at: null });
    save();
    return db;
  }

  // Cost, margin and profit figures are taken out of everything pump staff receive
  const PRIVATE = new Set(['cost', 'total_fuel_cost', 'total_cost', 'net_profit', 'profit_margin', 'profit_per_litre',
    'avg_daily_profit', ...FUELS.flatMap(f => [f + '_cost', f + '_margin'])]);
  function hidePrivate(v) {
    if (Array.isArray(v)) return v.filter(x => !(x && typeof x === 'object' && (PRIVATE.has(x.field) || ('label' in x && PRIVATE.has(x.key)))))
      .map(hidePrivate);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !PRIVATE.has(k)).map(([k, x]) => [k, hidePrivate(x)]));
    return v;
  }

  // ── Router ──────────────────────────────────────────────────────────────────
  function handle(method, path, q, body) {
    const db = load();
    if (path === '/api/health') return { status: 'ok' };
    if (path === '/api/login' && method === 'POST') {
      const u = db.users.find(x => x.username.toLowerCase() === String(body.username || '').trim().toLowerCase());
      if (!u || u.password !== body.password) fail(401, 'Wrong username or password');
      setSession(u.id);
      return { user: publicUser(u) };
    }
    if (path === '/api/logout') { setSession(null); return { ok: true }; }
    // Forgotten password: the preview can't send email or SMS, so it shows the code on screen
    if (path === '/api/password/forgot' && method === 'POST') {
      const u = db.users.find(x => x.username.toLowerCase() === String(body.username || '').trim().toLowerCase());
      const code = String(Math.floor(100000 + Math.random() * 900000));
      if (u) { db.resets = db.resets || {}; db.resets[u.id] = { code, until: Date.now() + 15 * 60e3, tries: 0 }; }
      return { ok: true, message: 'If that username exists, a 6-digit code has been sent to its email or phone — or, if it has neither, to the admin. The code works for 15 minutes.',
        preview_code: u ? code : undefined };
    }
    if (path === '/api/password/reset' && method === 'POST') {
      const u = db.users.find(x => x.username.toLowerCase() === String(body.username || '').trim().toLowerCase());
      const r = u && (db.resets || {})[u.id];
      if (!r || r.until < Date.now() || r.tries >= 5 || r.code !== String(body.code || '').trim()) {
        if (r) r.tries++;
        fail(400, 'That code is wrong or has expired — ask for a new one');
      }
      const pw = String(body.new_password || '');
      if (pw.length < 8) fail(400, 'Password must be at least 8 characters');
      u.password = pw; delete db.resets[u.id];
      return { ok: true };
    }
    const user = currentUser(db);
    if (!user) fail(401, 'Please sign in');
    const pu = publicUser(user);
    let m;

    if (path === '/api/me') return { user: pu };
    if (path === '/api/me/contact') { user.email = String(body.email || '').trim() || null; user.phone = String(body.phone || '').trim() || null; return { user: publicUser(user) }; }
    if (path === '/api/me/name') { user.full_name = String(body.full_name || '').trim().slice(0, 60) || null; return { user: publicUser(user) }; }
    if (path === '/api/me/password') {
      if (body.current_password !== user.password) fail(400, 'Current password is wrong');
      checkPassword(body.new_password, user.username); user.password = body.new_password; return { ok: true };
    }
    if (path === '/api/me/logout-all') return { signed_out: 0 };
    if (path === '/api/stations' && method === 'GET') { const s = scope(pu, null); return { stations: s ? [s] : db.stations }; }
    if (path === '/api/stations' && method === 'POST') {
      requireAdmin(pu);
      const name = String(body.name || '').replace(/\s+/g, ' ').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9 .,'&()\/-]{1,59}$/.test(name)) fail(400, "Branch name must be 2-60 letters, numbers, spaces or . , ' & ( ) / -");
      const same = db.stations.find(x => x.toLowerCase() === name.toLowerCase());
      if (same) fail(409, 'There is already a branch called ' + same);
      db.stations.push(name);
      return { station: name, stations: db.stations };
    }
    if ((m = path.match(/^\/api\/stations\/(.+)$/)) && method === 'PUT') {
      requireAdmin(pu);
      const old = decodeURIComponent(m[1]), name = String(body.name || '').replace(/\s+/g, ' ').trim();
      if (!db.stations.includes(old)) fail(404, 'Branch not found');
      if (!/^[A-Za-z0-9][A-Za-z0-9 .,'&()\/-]{1,59}$/.test(name)) fail(400, "Branch name must be 2-60 letters, numbers, spaces or . , ' & ( ) / -");
      const taken = db.stations.find(x => x !== old && x.toLowerCase() === name.toLowerCase());
      if (taken) fail(409, 'There is already a branch called ' + taken);
      db.stations = db.stations.map(x => x === old ? name : x);
      const move = o => { if (o && o.station === old) o.station = name; };
      [db.records, db.users, db.prices, db.alerts, db.payments].forEach(list => (list || []).forEach(move));
      (db.versions || []).forEach(v => move(v.data));
      Object.values(db.uploads || {}).forEach(move);
      (db.alerts || []).forEach(a => { if (a.station === name && a.message) a.message = a.message.split(old).join(name); });
      return { station: name, stations: db.stations };
    }
    if ((m = path.match(/^\/api\/stations\/(.+)$/)) && method === 'DELETE') {
      requireAdmin(pu);
      const name = decodeURIComponent(m[1]);
      if (!db.stations.includes(name)) fail(404, 'Branch not found');
      const days = db.records.filter(r => r.station === name).length, users = db.users.filter(u => u.station === name).length;
      if (days || users) fail(409, `${name} still has ${days} saved day(s) and ${users} user(s) — it can only be removed while unused`);
      db.stations = db.stations.filter(x => x !== name);
      db.prices = db.prices.filter(p => p.station !== name);
      return { stations: db.stations };
    }

    if (path === '/api/records' && method === 'GET') {
      const st = scope(pu, q.station);
      const recs = live(db).filter(r => !st || r.station === st)
        .sort((a, b) => b.report_date.localeCompare(a.report_date) || b.id - a.id);
      return { count: recs.length, records: recs };
    }
    if (path === '/api/records' && method === 'POST') { const res = saveRecord(db, body, pu); return res; }
    if (path === '/api/records' && method === 'DELETE') {
      requireAdmin(pu);
      const rs = live(db).filter(r => !q.station || r.station === q.station);
      rs.forEach(r => { r.deleted_at = nowIso(); r.deleted_by = pu.username; version(db, r, 'delete', pu.username); clearAlerts(db, r.id); });
      return { deleted: rs.length };
    }
    if ((m = path.match(/^\/api\/records\/(\d+)\/(approve|reopen)$/))) {
      const r = live(db).find(x => x.id === +m[1]);
      if (!r || (pu.station && pu.role !== 'admin' && r.station !== pu.station)) fail(404, 'Record not found');
      if (m[2] === 'approve') {
        if (!['manager', 'admin'].includes(pu.role)) fail(403, 'Only a branch manager or admin can approve a day');
        if (r.approved_at) fail(409, 'This day is already approved');
        r.approved_at = nowIso(); r.approved_by = pu.username;
      } else {
        requireAdmin(pu);
        if (!r.approved_at) fail(409, 'This day is not approved');
        r.approved_at = null; r.approved_by = null;
      }
      version(db, r, m[2], pu.username);
      return { record: r };
    }
    if ((m = path.match(/^\/api\/records\/(\d+)\/history$/))) {
      const r = db.records.find(x => x.id === +m[1]);
      if (!r || (r.deleted_at && pu.role !== 'admin')) fail(404, 'Record not found');
      return { history: history(db, r.id) };
    }
    if ((m = path.match(/^\/api\/records\/(\d+)$/))) {
      const r = live(db).find(x => x.id === +m[1]);
      if (!r || (pu.station && r.station !== pu.station)) fail(404, 'Record not found');
      if (method === 'GET') return r;
      if (method === 'PUT') return saveRecord(db, body, pu, r.id);
      if (method === 'DELETE') {
        checkEditable(pu, r.report_date, r);
        r.deleted_at = nowIso(); r.deleted_by = pu.username; version(db, r, 'delete', pu.username); clearAlerts(db, r.id);
        return { deleted: 1 };
      }
    }
    if (path === '/api/bin') {
      requireAdmin(pu);
      const recs = db.records.filter(r => r.deleted_at);
      return { count: recs.length, records: recs };
    }
    if ((m = path.match(/^\/api\/bin\/(\d+)(\/restore)?$/))) {
      requireAdmin(pu);
      const r = db.records.find(x => x.id === +m[1] && x.deleted_at);
      if (!r) fail(404, 'That record is not in the bin');
      if (m[2]) { r.deleted_at = null; r.deleted_by = null; version(db, r, 'restore', pu.username); syncAlerts(db, r); return { record: r }; }
      version(db, r, 'purge', pu.username);
      db.records = db.records.filter(x => x !== r);
      return { purged: 1 };
    }

    if (path === '/api/prices' && method === 'GET') {
      const st = scope(pu, q.station);
      return { station: st, date: q.date, prices: effectivePrices(db, st, q.date || kenyaToday()) };
    }
    if (path === '/api/prices' && method === 'POST') {
      requireAdmin(pu);
      const sts = body.stations || [];
      if (!sts.length || sts.some(s => !db.stations.includes(s))) fail(400, 'Choose one or more valid branches');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.effective_from || '')) fail(400, 'effective_from must be a date (YYYY-MM-DD)');
      let n = 0;
      FUELS.forEach(f => {
        const sell = num(body[f + '_sell']), cost = num(body[f + '_cost']);
        if (sell <= 0 && cost <= 0) return;
        if (sell <= 0 || cost <= 0 || cost > sell * 2 || sell > 1000) fail(400, 'Check the ' + f + ' prices');
        sts.forEach(s => { db.prices.push({ id: nextId(db, 'price'), station: s, fuel: f, sell: r2(sell), cost: r2(cost),
          effective_from: body.effective_from, set_by: pu.username }); n++; });
      });
      if (!n) fail(400, "Enter at least one fuel's selling and cost price");
      return { saved: n };
    }
    if (path === '/api/prices/history') {
      const st = scope(pu, q.station);
      return { prices: db.prices.filter(x => !st || x.station === st)
        .sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.id - a.id).slice(0, 200) };
    }

    if (path === '/api/customers' && method === 'GET') return { customers: customers(db) };
    if (path === '/api/customers' && method === 'POST') {
      const name = String(body.name || '').trim();
      if (!name) fail(400, "Enter the customer's name");
      const c = { id: nextId(db, 'customer'), name, company: String(body.company || '').trim(), phone: String(body.phone || '').trim(),
        credit_limit: ['manager', 'admin'].includes(pu.role) ? r2(num(body.credit_limit)) : 0, created_by: pu.username, created_at: nowIso() };
      db.customers.push(c);
      return { customer: customers(db).find(x => x.id === c.id) };
    }
    if ((m = path.match(/^\/api\/customers\/(\d+)(\/statement|\/payments)?$/))) {
      const cid = +m[1];
      if (!m[2] && method === 'PUT') {
        if (!['manager', 'admin'].includes(pu.role)) fail(403, 'Only a manager or admin can change a customer account');
        const c = db.customers.find(x => x.id === cid); if (!c) fail(404, 'Customer not found');
        if ('credit_limit' in body) c.credit_limit = r2(num(body.credit_limit));
        if ('phone' in body) c.phone = String(body.phone || '').trim();
        return { customer: customers(db).find(x => x.id === cid) };
      }
      if (m[2] === '/statement') return statement(db, cid);
      if (m[2] === '/payments') {
        statement(db, cid);
        const amount = r2(num(body.amount)), paid_on = body.paid_on || kenyaToday();
        if (amount <= 0) fail(400, 'Enter the amount paid');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(paid_on) || paid_on > kenyaToday()) fail(400, 'Check the payment date');
        const id = nextId(db, 'payment');
        db.payments.push({ id, customer_id: cid, paid_on, amount, method: body.method || 'M-Pesa', reference: body.reference || '',
          station: scope(pu, body.station || null) || body.station || '', by_user: pu.username, at: nowIso(), voided_at: null });
        return { payment_id: id, ...statement(db, cid) };
      }
    }
    if ((m = path.match(/^\/api\/payments\/(\d+)\/void$/))) {
      requireAdmin(pu);
      const p = db.payments.find(x => x.id === +m[1] && !x.voided_at); if (!p) fail(404, 'Payment not found');
      p.voided_at = nowIso(); p.voided_by = pu.username; return { ok: true };
    }

    if (path === '/api/alerts' || path === '/api/alerts/read') {
      if (!['manager', 'admin'].includes(pu.role)) fail(403, 'Alerts are for managers and admins');
      const visible = db.alerts.filter(a => pu.role === 'admin' || a.station === pu.station);
      if (path === '/api/alerts/read') { visible.forEach(a => { if (!a.read_by.includes(pu.id)) a.read_by.push(pu.id); }); return { marked: visible.length }; }
      const items = visible.filter(a => q.all === '1' || !a.cleared_at).sort((a, b) => b.id - a.id)
        .map(a => ({ ...a, title: TITLES[a.kind] || a.kind, read: a.read_by.includes(pu.id) }));
      return { alerts: items, unread: items.filter(a => !a.read && !a.cleared_at).length };
    }
    if (path === '/api/settings') {
      requireAdmin(pu);
      if (method === 'PUT') Object.keys(DEFAULT_SETTINGS).forEach(k => {
        if (k in body) db.settings[k] = /_emails$/.test(k) ? String(body[k] || '') : Math.max(0, num(body[k]));
      });
      return { settings: db.settings, email_configured: false };
    }
    if (path === '/api/backups') {
      requireAdmin(pu);
      db.backups = db.backups || [];
      if (method === 'POST') {
        const at = nowIso(), stamp = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 16).replace('T', '_').replace(':', '');
        const backup = { name: 'petrokenya-backup-' + stamp + '.zip', size: JSON.stringify(db).length, at };
        db.backups = [backup, ...db.backups].slice(0, 14);
        return { backup, backups: db.backups };
      }
      return { backups: db.backups, email_configured: false, backup_emails: db.settings.backup_emails || '', last_email: null };
    }
    if (path === '/api/backups/email') fail(400, "The website preview can't send email — this works once the app is hosted");
    if (path === '/api/settings/test-email') fail(400, "The website preview can't send email — this works once the app is hosted");
    if (path.startsWith('/api/reports/monthly')) {
      const month = q.month || kenyaToday().slice(0, 7), st = scope(pu, q.station);
      return monthly(live(db).filter(r => r.report_date.startsWith(month) && (!st || r.station === st)), month);
    }
    if (path === '/api/uploads' && method === 'POST') {
      const st = scope(pu, body.station);
      if (!db.stations.includes(st)) fail(400, 'Choose the branch the receipt belongs to');
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(body.data || '')) fail(400, 'Only JPEG, PNG or WebP photos can be uploaded');
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
      db.uploads[id] = { station: st, data: body.data };
      return { id, mime: 'image/jpeg', size: body.data.length };
    }
    if (path === '/api/users' && method === 'GET') { requireAdmin(pu); return { users: db.users.map(publicUser) }; }
    if (path === '/api/users' && method === 'POST') {
      requireAdmin(pu);
      const username = String(body.username || '').trim();
      if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) fail(400, 'Username must be 3-32 letters, numbers, dots, dashes or underscores');
      if (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) fail(409, 'That username is already taken');
      const role = body.role || 'staff', station = body.station || null;
      if (role === 'manager' && !station) fail(400, 'A branch manager needs a branch');
      checkPassword(body.password, username);
      const u = { id: nextId(db, 'user'), username, password: body.password, role, station, full_name: body.full_name || null,
        email: String(body.email || '').trim() || null, phone: String(body.phone || '').trim() || null, created_at: nowIso() };
      db.users.push(u);
      return { user: publicUser(u) };
    }
    if ((m = path.match(/^\/api\/users\/(\d+)\/contact$/)) && method === 'PUT') {
      requireAdmin(pu);
      const u = db.users.find(x => x.id === Number(m[1]));
      if (!u) fail(404, 'User not found');
      u.email = String(body.email || '').trim() || null; u.phone = String(body.phone || '').trim() || null;
      return { user: publicUser(u) };
    }
    if ((m = path.match(/^\/api\/users\/(\d+)(\/password|\/logout)?$/))) {
      requireAdmin(pu);
      const u = db.users.find(x => x.id === +m[1]); if (!u) fail(404, 'User not found');
      if (m[2] === '/password') { checkPassword(body.password, u.username); u.password = body.password; return { ok: true }; }
      if (m[2] === '/logout') return { signed_out: 0 };
      if (u.id === pu.id) fail(400, 'You cannot delete your own account');
      db.users = db.users.filter(x => x !== u); return { deleted: 1 };
    }
    fail(404, 'No route for ' + method + ' ' + path);
  }

  // Answer the app's /api requests here instead of over the network
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api')) return realFetch(input, init);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : {};
    const q = Object.fromEntries(url.searchParams.entries());
    let status = 200, data;
    try {
      data = handle(method, url.pathname.replace(/\/$/, ''), q, body);
      const viewer = currentUser(load());
      if (viewer && viewer.role === 'staff') data = hidePrivate(data);
      if (method === 'POST' && /\/api\/(records|customers|users|prices|uploads)$/.test(url.pathname) && data && data.created !== false) status = 201;
      save();
    } catch (e) {
      status = e.status || 500; data = { error: e.message };
    }
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  };

  // Photos live in this browser, so images point at the stored copy
  window.pkPreview = true;
  window.pkUploadUrl = id => (load().uploads[id] || {}).data || '';

  // Start over with fresh example data
  window.pkResetPreview = () => {
    try { localStorage.removeItem(DB_KEY); localStorage.removeItem('pk_cache_v1'); localStorage.removeItem('pk_outbox_v1');
      sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
    memory = null; location.reload();
  };

  // Preview sign-in helpers: one tap to try each role
  window.pkDemoLogin = (u, p) => {
    document.getElementById('loginUser').value = u; document.getElementById('loginPass').value = p;
    document.getElementById('loginBtn').click();
  };
  document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('preview');
    const form = document.querySelector('.login-modal');
    if (form) {
      const box = document.createElement('div');
      box.className = 'demo-accounts';
      box.innerHTML = '<div class="demo-title">Preview — try it as:</div>' +
        '<button type="button" class="btn btn-o btn-sm" onclick="pkDemoLogin(\'owner\',\'Fuel-Station-77\')">👑 Owner (admin)</button>' +
        '<button type="button" class="btn btn-o btn-sm" onclick="pkDemoLogin(\'mary\',\'Branch-Boss-55\')">🧑‍💼 Branch manager</button>' +
        '<button type="button" class="btn btn-o btn-sm" onclick="pkDemoLogin(\'brian\',\'Pump-Shift-55\')">⛽ Pump staff</button>' +
        '<div class="demo-note">Everything you enter stays in this browser. Example data is marked “Example”.</div>';
      form.insertBefore(box, form.querySelector('.lang-switch'));
    }
    const main = document.querySelector('main');
    if (main) {
      const bar = document.createElement('div');
      bar.className = 'preview-bar home-only';
      bar.innerHTML = '<span>Website preview: works in this browser only, with example data. The real app adds a shared server for all branches.</span>' +
        '<button class="btn btn-o btn-sm" onclick="pkResetPreview()">↺ Reset example data</button>';
      main.insertBefore(bar, main.firstChild);
    }
  });
})();
