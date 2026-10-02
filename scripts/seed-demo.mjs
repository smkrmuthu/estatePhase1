#!/usr/bin/env node
// Fills an Estate site with six months of realistic demo data, through the API, and
// checks every stock and despatch rule along the way (each refused action must be
// refused). Prints a PASS/FAIL list and the demo users' logins at the end.
//
//   node scripts/seed-demo.mjs --url https://estate.oneuptech.co --login mgr@estate.com
//   node scripts/seed-demo.mjs --url http://localhost:8787 --login admin --password localpass123
//
// Needs an administrator login. Stock entries can never be deleted (only undone), so
// run it on a site you are happy to fill with demo data. It refuses to run twice.
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const url = (opt('url') || '').replace(/\/+$/, '');
const adminLogin = opt('login');
if (!url || !adminLogin) {
  console.error('Usage: seed-demo.mjs --url <site> --login <admin login> [--password <pw>]');
  process.exit(1);
}
const BASE = `${url}/api/v1`;

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a); }));
}

async function api(token, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
}

// A step that must succeed: stops the run with the server's message if it doesn't.
async function must(what, token, method, path, body) {
  const r = await api(token, method, path, body);
  if (r.status >= 300) {
    console.error(`\n✗ ${what} failed (${r.status}): ${JSON.stringify(r.body?.error ?? r.body)}`);
    process.exit(1);
  }
  return r.body;
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
// A step the app must refuse with this status.
async function refused(name, status, token, method, path, body) {
  const r = await api(token, method, path, body);
  check(name, r.status === status, `got ${r.status} ${JSON.stringify(r.body?.error?.message ?? '')}`);
  return r;
}

async function login(loginName, password) {
  const r = await api(null, 'POST', '/auth/password', { login: loginName, password });
  if (r.status !== 200) {
    console.error(`Sign-in as ${loginName} failed (${r.status}): ${JSON.stringify(r.body?.error ?? r.body)}`);
    process.exit(1);
  }
  return r.body.access;
}

// Dates: day `d` of the month `back` months ago, never later than today.
const now = new Date();
const todayIso = now.toISOString().slice(0, 10);
function day(back, d) {
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, d));
  const iso = t.toISOString().slice(0, 10);
  return iso > todayIso ? todayIso : iso;
}
const kg = (n) => Math.round(n * 1000);
const pw = () => randomBytes(6).toString('base64url') + '9a';

const password = opt('password') || (await ask(`Password for ${adminLogin}: `));
const admin = await login(adminLogin, password);
if ((await api(admin, 'GET', '/auth/me')).body.role !== 'admin') {
  console.error('That login is not an administrator.');
  process.exit(1);
}
const existing = await must('Read godowns', admin, 'GET', '/godowns');
if (existing.godowns.some((g) => g.code.startsWith('DEMO-'))) {
  console.error('Demo data is already on this site (godowns DEMO-…). Not adding it twice.');
  process.exit(1);
}

console.log(`\nAdding demo data to ${url}\n\nMasters`);
const G = {};
for (const [k, code, name, address] of [
  ['estate', 'DEMO-EST', 'Estate Store (demo)', 'Hill Block, Chikmagalur'],
  ['curing', 'DEMO-CUR', 'Curing Yard (demo)', 'Mudigere Road'],
  ['town', 'DEMO-TWN', 'Town Warehouse (demo)', 'Industrial Area, Hassan']
]) G[k] = (await must(`Godown ${code}`, admin, 'POST', '/godowns', { code, name, address })).id;
await refused('Duplicate godown code is refused', 409, admin, 'POST', '/godowns', { code: 'DEMO-EST', name: 'Copy' });

const I = {};
for (const [k, code, name, coffeeType, form, grade, bagKg] of [
  ['araP', 'DEMO-APA', 'Arabica Parchment AB (demo)', 'Arabica', 'Parchment', 'AB', 50],
  ['araC', 'DEMO-ACH', 'Arabica Cherry (demo)', 'Arabica', 'Cherry', 'AB', 50],
  ['robP', 'DEMO-RPA', 'Robusta Parchment PB (demo)', 'Robusta', 'Parchment', 'PB', 50],
  ['robC', 'DEMO-RCH', 'Robusta Cherry AB (demo)', 'Robusta', 'Cherry', 'AB', 60]
]) I[k] = (await must(`Coffee ${code}`, admin, 'POST', '/items', { code, name, coffeeType, form, grade, bagGrams: kg(bagKg) })).id;

const C = {};
for (const [k, code, name, contactPerson, phone, address, gstin, active] of [
  ['curer', 'DEMO-C1', 'Hassan Curing Works (demo)', 'R. Prakash', '98450 11111', 'KIADB Area, Hassan 573201', '29AAACH1234K1Z5', true],
  ['export', 'DEMO-C2', 'Malabar Exports (demo)', 'S. Nair', '98470 22222', 'Willingdon Island, Kochi 682003', '32AABCM5678L1Z2', true],
  ['roaster', 'DEMO-C3', 'Bengaluru Roasters (demo)', 'A. Rao', '98860 33333', 'Indiranagar, Bengaluru 560038', '29AAGCB9012M1Z8', true],
  ['old', 'DEMO-C4', 'Closed Account (demo)', '', '', 'Mysuru', '', false]
]) C[k] = (await must(`Client ${code}`, admin, 'POST', '/clients', { code, name, contactPerson, phone, address, gstin, active })).id;

console.log('\nUsers');
const U = {
  manager: { login: 'demo.manager', name: 'Demo Manager', role: 'manager', password: pw(), godownIds: [] },
  opEstate: { login: 'demo.op.estate', name: 'Demo Operator (Estate Store)', role: 'operator', password: pw(), godownIds: [G.estate] },
  opTown: { login: 'demo.op.town', name: 'Demo Operator (Town Warehouse)', role: 'operator', password: pw(), godownIds: [G.town] },
  viewer: { login: 'demo.viewer', name: 'Demo Viewer', role: 'viewer', password: pw(), godownIds: [] },
  left: { login: 'demo.left', name: 'Demo Former Staff', role: 'operator', password: pw(), godownIds: [G.curing] }
};
for (const u of Object.values(U)) {
  const r = await api(admin, 'POST', '/users', u);
  if (r.status === 409) { console.error(`\nThe login ${u.login} already exists. Remove the earlier demo users' logins first.`); process.exit(1); }
  if (r.status !== 201) { console.error(`User ${u.login} failed: ${JSON.stringify(r.body)}`); process.exit(1); }
  u.id = r.body.users.find((x) => x.login === u.login).id;
}
const mgr = await login(U.manager.login, U.manager.password);
const opE = await login(U.opEstate.login, U.opEstate.password);
const opT = await login(U.opTown.login, U.opTown.password);
const viewer = await login(U.viewer.login, U.viewer.password);
await must('Disable former staff', admin, 'PATCH', `/users/${U.left.id}`, { active: false });
await refused('A disabled user cannot sign in', 401, null, 'POST', '/auth/password', { login: U.left.login, password: U.left.password });

console.log('\nStock coming in');
const L = {};
async function inward(key, token, date, godown, item, bags, netKg, lot, extra = {}) {
  const r = await must(`Inward ${key}`, token, 'POST', '/receipts', {
    date, locationId: godown, itemId: item, grams: kg(netKg), bags, ...(lot ? { lot } : { lotId: L[key].lotId }), ...extra
  });
  if (!L[key]) L[key] = { lotId: r.lotId, code: r.lotCode };
  return r;
}
// Opening stock when the estate started using the app (six months ago).
await inward('A1', admin, day(6, 2), G.estate, I.araP, 120, 6012.5, { cropYear: '2024-25', moisturePct: 10.8, outturnPct: 81, sourceRef: 'Hill Block A' }, { opening: true, reference: 'Stock count' });
await inward('R1', admin, day(6, 2), G.curing, I.robC, 80, 4790, { cropYear: '2024-25', moisturePct: 11.2, sourceRef: 'Valley Block' }, { opening: true, reference: 'Stock count' });
await inward('R2', admin, day(6, 2), G.town, I.robP, 60, 3005, { cropYear: '2024-25', moisturePct: 10.5, outturnPct: 79 }, { opening: true, reference: 'Stock count' });
// Harvest coming in month by month.
await inward('A2', mgr, day(5, 6), G.estate, I.araC, 90, 4518, { cropYear: '2025-26', moisturePct: 11.5, sourceRef: 'Hill Block B' }, { reference: 'WB-1042' });
const a3Receipt = await inward('A3', opE, day(4, 9), G.estate, I.araP, 70, 3496.5, { cropYear: '2025-26', moisturePct: 10.6, outturnPct: 82, sourceRef: 'Hill Block A' }, { reference: 'WB-1107' });
await inward('A3', opE, day(4, 12), G.estate, I.araP, 20, 1001, null, { reference: 'WB-1113 (top-up)' });
await inward('R3', mgr, day(3, 4), G.curing, I.robC, 100, 6020, { cropYear: '2025-26', moisturePct: 11.9, sourceRef: 'Supplier: K. Gowda' }, { reference: 'DN-778' });
await inward('R4', opT, day(2, 15), G.town, I.robP, 50, 2497, { cropYear: '2025-26', moisturePct: 10.4 }, { reference: 'WB-1290' });
await inward('A4', opE, day(1, 10), G.estate, I.araC, 40, 2010, { cropYear: '2025-26', moisturePct: 11.0, sourceRef: 'Hill Block C' }, { reference: 'WB-1355' });
await inward('A5', opE, todayIso, G.estate, I.araP, 30, 1503.5, { cropYear: '2025-26', moisturePct: 10.7, sourceRef: 'Hill Block A' }, { reference: 'WB-1401' });
// An inward entered twice by mistake, then undone by the manager.
const dupIn = await inward('R5', opT, day(1, 20), G.town, I.robP, 10, 500, { cropYear: '2025-26' }, { reference: 'WB-1290 (entered twice)' });
await must('Undo the duplicate inward', mgr, 'POST', `/transactions/${dupIn.id}/reverse`, { reason: 'Entered twice by mistake' });

await refused('Inward with a future date is refused', 422, admin, 'POST', '/receipts', { date: '2099-01-01', locationId: G.estate, itemId: I.araP, grams: 1000, bags: 1 });
await refused('Viewer cannot record an inward', 403, viewer, 'POST', '/receipts', { date: todayIso, locationId: G.estate, itemId: I.araP, grams: 1000, bags: 1 });
await refused('Operator cannot record an inward in another godown', 403, opE, 'POST', '/receipts', { date: todayIso, locationId: G.town, itemId: I.araP, grams: 1000, bags: 1 });

console.log('\nTransfers and adjustments');
await must('Transfer Arabica to town', mgr, 'POST', '/transfers', { date: day(5, 20), fromLocationId: G.estate, toLocationId: G.town, lotId: L.A1.lotId, grams: kg(1002), bags: 20, reference: 'KA 18 B 4521' });
await must('Transfer Robusta cherry to town', mgr, 'POST', '/transfers', { date: day(3, 18), fromLocationId: G.curing, toLocationId: G.town, lotId: L.R3.lotId, grams: kg(1806), bags: 30, reference: 'Gate pass 311' });
await refused('Transfer of more than is available is refused', 422, mgr, 'POST', '/transfers', { date: todayIso, fromLocationId: G.town, toLocationId: G.estate, lotId: L.R2.lotId, grams: kg(99999), bags: 2000 });
await refused('Transfer to the same godown is refused', 422, mgr, 'POST', '/transfers', { date: todayIso, fromLocationId: G.town, toLocationId: G.town, lotId: L.R2.lotId, grams: kg(50), bags: 1 });

const adj = (date, godown, lot, direction, bags, netKg, reason, notes = '') =>
  must(`Adjustment ${reason}`, mgr, 'POST', '/adjustments', { date, locationId: godown, lotId: lot, direction, grams: kg(netKg), bags, reason, notes });
await adj(day(4, 25), G.estate, L.A1.lotId, 'OUT', 0, 38.5, 'Moisture / storage weight loss');
await adj(day(3, 8), G.estate, L.A2.lotId, 'OUT', 0, 2, 'Sampling / quality draw', 'Cup test for Malabar Exports');
await adj(day(2, 5), G.curing, L.R1.lotId, 'OUT', 1, 60, 'Spillage / bag damage', 'Bag torn while stacking');
await adj(day(2, 22), G.town, L.R2.lotId, 'OUT', 2, 100, 'Pest / mould write-off');
await adj(day(1, 28), G.town, L.R2.lotId, 'IN', 1, 50, 'Physical count correction', 'Monthly count found one extra bag');
const wrongAdj = await adj(day(1, 28), G.estate, L.A2.lotId, 'OUT', 0, 5, 'Other', 'Entered against the wrong lot');
await must('Undo the wrong adjustment', mgr, 'POST', `/transactions/${wrongAdj.id}/reverse`, { reason: 'Wrong lot' });
await refused('The same entry cannot be undone twice', 409, mgr, 'POST', `/transactions/${wrongAdj.id}/reverse`, { reason: 'Again' });
await refused('Adjustment "Other" without a note is refused', 422, mgr, 'POST', '/adjustments', { date: todayIso, locationId: G.estate, lotId: L.A1.lotId, direction: 'OUT', grams: 1000, bags: 0, reason: 'Other' });
await refused('Operator cannot make an adjustment', 403, opE, 'POST', '/adjustments', { date: todayIso, locationId: G.estate, lotId: L.A1.lotId, direction: 'OUT', grams: 1000, bags: 0, reason: 'Sampling / quality draw' });

console.log('\nDespatches');
const trucks = ['KA 18 A 1201', 'KA 13 B 7788', 'KL 07 C 4410', 'KA 01 D 9090', 'KA 18 B 4521'];
const drivers = [['Manju', '98450 70001'], ['Shivu', '98450 70002'], ['Anil', '98470 70003'], ['Ravi', '98860 70004']];
let n = 0;
async function draft(token, client, date, lines, extra = {}) {
  const [driverName, driverPhone] = drivers[n % drivers.length];
  const vehicleNo = trucks[n++ % trucks.length];
  return must('Despatch draft', token, 'POST', '/dispatches', {
    clientId: client, date, vehicleNo, transporter: 'Sri Ganesh Transport', driverName, driverPhone,
    lines: lines.map(([godown, key, bags, netKg, packages]) => ({ locationId: godown, lotId: L[key].lotId, bags, grams: kg(netKg), ...(packages ? { packages } : {}) })),
    ...extra
  });
}
const post = (token, d) => must(`Truck left ${d.no}`, token, 'POST', `/dispatches/${d.id}/post`);

// One or two despatches a month for the trend chart.
await post(mgr, await draft(mgr, C.curer, day(5, 12), [[G.curing, 'R1', 20, 1197]], { reference: 'PO-2201' }));
await post(mgr, await draft(mgr, C.export, day(4, 5), [[G.estate, 'A1', 25, 1252.5]], { reference: 'MX/0415' }));
await post(opE, await draft(opE, C.roaster, day(4, 20), [[G.estate, 'A2', 10, 502]]));
await post(mgr, await draft(mgr, C.curer, day(3, 14), [[G.curing, 'R3', 30, 1806], [G.town, 'R2', 15, 751]], { reference: 'PO-2260' }));
await post(opT, await draft(opT, C.curer, day(2, 10), [[G.town, 'R3', 20, 1204, 10]], { notes: 'Two bags per label (stitched pairs)' }));
await post(mgr, await draft(mgr, C.export, day(2, 26), [[G.estate, 'A3', 40, 1998]], { reference: 'MX/0502' }));

// Weighed bags: weights must add up before the truck can leave.
const weighed = await draft(mgr, C.export, day(1, 8), [[G.estate, 'A1', 4, 200]], { reference: 'MX/0533', notes: 'Bags weighed at loading' });
const [b1, b2, b3, b4] = weighed.packages;
await must('Bag weights (partial)', mgr, 'PUT', `/dispatches/${weighed.id}/package-weights`, { weights: { [b1.id]: kg(49.5), [b2.id]: kg(50.2) } });
await refused('Truck cannot leave while bag weights do not add up', 422, mgr, 'POST', `/dispatches/${weighed.id}/post`);
await must('Bag weights (all)', mgr, 'PUT', `/dispatches/${weighed.id}/package-weights`, { weights: { [b3.id]: kg(50.1), [b4.id]: kg(50.2) } });
await post(mgr, weighed);
await refused('A despatch cannot be confirmed twice', 409, mgr, 'POST', `/dispatches/${weighed.id}/post`);
await refused('Bag weights cannot change after the truck left', 409, mgr, 'PUT', `/dispatches/${weighed.id}/package-weights`, { weights: { [b1.id]: kg(1) } });

await post(opE, await draft(opE, C.roaster, day(1, 18), [[G.estate, 'A4', 12, 603]]));
await post(mgr, await draft(mgr, C.curer, day(0, 3), [[G.curing, 'R3', 25, 1505]], { reference: 'PO-2318' }));

// Confirmed by mistake (the truck broke down), then undone by the manager.
const undone = await draft(opT, C.curer, day(0, 5), [[G.town, 'R4', 10, 499]]);
await post(opT, undone);
await refused('Operator cannot undo a despatch', 403, opT, 'POST', `/dispatches/${undone.id}/reverse`, { reason: 'Truck broke down' });
await must('Undo despatch', mgr, 'POST', `/dispatches/${undone.id}/reverse`, { reason: 'Truck broke down before leaving' });
await refused('A despatch cannot be undone twice', 409, mgr, 'POST', `/dispatches/${undone.id}/reverse`, { reason: 'Again' });
const undoneLabel = await api(admin, 'GET', `/trace/${undone.packages[0].barcode}`);
check('Labels of an undone despatch show as cancelled', undoneLabel.body.package?.status === 'CANCELLED', JSON.stringify(undoneLabel.body.package));

// Cancelled while loading: the held stock is released.
const cancelled = await draft(mgr, C.export, day(0, 6), [[G.estate, 'A4', 5, 251]]);
await must('Cancel despatch', mgr, 'POST', `/dispatches/${cancelled.id}/cancel`, { reason: 'Client postponed the order' });

// Edited while loading: the old labels are retired and new ones issued.
const edited = await draft(opE, C.roaster, todayIso, [[G.estate, 'A5', 4, 200]]);
const oldCode = edited.packages[0].barcode;
const e2 = await must('Edit despatch lines', opE, 'PUT', `/dispatches/${edited.id}`, {
  clientId: C.roaster, date: todayIso, vehicleNo: edited.vehicleNo, driverName: edited.driverName, driverPhone: edited.driverPhone,
  lines: [{ locationId: G.estate, lotId: L.A5.lotId, bags: 6, grams: kg(301) }]
});
check('Editing lines replaces the bag labels', e2.packages.length === 6 && !e2.packages.some((p) => p.barcode === oldCode));
const retired = await api(admin, 'GET', `/trace/${oldCode}`);
check('A replaced label still scans, marked cancelled', retired.body.found && retired.body.package.status === 'CANCELLED');

// Still loading: holds stock (shows on the dashboards and Stock on hand).
const loadingT = await draft(opT, C.curer, todayIso, [[G.town, 'R4', 15, 749]], { reference: 'PO-2325' });
await draft(mgr, C.export, todayIso, [[G.estate, 'A3', 20, 1000], [G.town, 'A1', 10, 501]], { reference: 'MX/0560' });

const avail = (await must('Balances', admin, 'GET', `/stock/balances?location_id=${G.town}&lot_id=${L.R4.lotId}`)).balances[0];
await refused('A despatch cannot take stock another despatch is holding', 422, mgr, 'POST', '/dispatches', {
  clientId: C.curer, date: todayIso, lines: [{ locationId: G.town, lotId: L.R4.lotId, bags: avail.availableBags + 1, grams: avail.availableGrams + 1000 }]
});
await refused('Operator cannot despatch from another godown', 403, opE, 'POST', '/dispatches', {
  clientId: C.curer, date: todayIso, lines: [{ locationId: G.town, lotId: L.R4.lotId, bags: 1, grams: kg(50) }]
});
await refused('Operator cannot cancel a despatch loading in another godown', 403, opE, 'POST', `/dispatches/${loadingT.id}/cancel`, { reason: 'Not mine' });

console.log('\nOther rules');
await refused('An inward cannot be undone once its coffee was despatched', 422, mgr, 'POST', `/transactions/${a3Receipt.id}/reverse`, { reason: 'Test' });

const code = weighed.packages[1].barcode;
const typo = code.slice(0, 6) + (code[6] === 'A' ? 'B' : 'A') + code.slice(7);
const t1 = await api(viewer, 'GET', `/trace/${typo}`);
check('A mistyped barcode is reported as not valid', t1.body.found === false && t1.body.validFormat === false);
const t2 = await api(viewer, 'GET', `/trace/${code}`);
check('Viewer can track a bag to its client and lot', t2.body.found && t2.body.client?.name?.startsWith('Malabar') && t2.body.lot?.code === L.A1.code);

// Five simultaneous transfers of the same whole stock: exactly one may go through.
const race = await must('Race lot', mgr, 'POST', '/receipts', { date: todayIso, locationId: G.curing, itemId: I.robC, grams: kg(180), bags: 3, lot: { cropYear: '2025-26', notes: 'Demo: simultaneous transfer test' } });
const tries = await Promise.all(Array.from({ length: 5 }, () =>
  api(mgr, 'POST', '/transfers', { date: todayIso, fromLocationId: G.curing, toLocationId: G.town, lotId: race.lotId, grams: kg(180), bags: 3, notes: 'Simultaneous transfer test' })));
check('Simultaneous transfers cannot overdraw (exactly one of five succeeds)', tries.filter((t) => t.status === 201).length === 1, tries.map((t) => t.status).join(','));

const neg = (await must('Balances', admin, 'GET', '/stock/balances')).balances.filter((b) => b.onHandGrams < 0 || b.onHandBags < 0 || b.availableGrams < 0);
check('No godown + lot is below zero', neg.length === 0, `${neg.length} negative`);
const dash = await must('Dashboard', mgr, 'GET', '/dashboard');
check('Dashboard trend has despatches in each of the last 6 months', dash.despatchTrend.filter((m) => m.bags > 0).length === 6, JSON.stringify(dash.despatchTrend));
check('Viewer cannot open Users', (await api(viewer, 'GET', '/users')).status === 403);

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed${failed.length ? ` — ${failed.length} FAILED` : ''}.`);
console.log('\nDemo users (change or disable them under Users when done):');
for (const u of Object.values(U)) console.log(`  ${u.login.padEnd(16)} ${u.password.padEnd(12)} ${u.role}${u.login === 'demo.left' ? ' (disabled)' : ''}`);
console.log('\nEverything demo is named "(demo)" and coded DEMO-…');
process.exit(failed.length ? 1 : 0);
