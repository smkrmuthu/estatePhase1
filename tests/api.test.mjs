// Integration tests: runs the real Worker + local D1 (wrangler dev) in a temp
// directory and drives the API over HTTP. Run: npm test
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8790 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const dir = mkdtempSync(join(tmpdir(), 'estate-test-'));
let server;

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
// Wrangler reports a failed statement (e.g. a trigger's RAISE) on stdout, so surface both streams.
const d1 = (command) => {
  try {
    return run('npx', ['wrangler', 'd1', 'execute', 'estate-db', '--local', '--persist-to', dir, '--command', command, '--json']);
  } catch (e) {
    throw new Error(`${e.stdout}\n${e.stderr}`);
  }
};

before(async () => {
  run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'estate-db', '--local', '--persist-to', dir]);
  run('node', ['scripts/create-user.mjs', '--local', '--persist-to', dir, '--login', 'admin', '--name', 'Test Admin', '--password', 'adminpass1', '--org', 'Test Estate']);
  // Own process group, so after() can stop wrangler and the workerd it starts.
  server = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', dir, '--var', 'JWT_SECRET:test-secret-test-secret-test-secret'],
    { stdio: 'ignore', detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start');
});

after(() => {
  try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ }
  rmSync(dir, { recursive: true, force: true });
});

async function api(token, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
}

async function login(loginName, password) {
  const r = await api(null, 'POST', '/auth/password', { login: loginName, password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.access;
}

const today = new Date().toISOString().slice(0, 10);
const S = {}; // shared ids
const bal = async (token, locationId, lotId) =>
  (await api(token, 'GET', `/stock/balances?location_id=${locationId}&lot_id=${lotId}`)).body.balances[0] ?? { onHandGrams: 0, availableGrams: 0, onHandBags: 0 };

test('sign-in and auth', async () => {
  assert.equal((await api(null, 'GET', '/godowns')).status, 401);
  assert.equal((await api(null, 'POST', '/auth/password', { login: 'admin', password: 'wrong' })).status, 401);
  S.admin = await login('ADMIN', 'adminpass1'); // login is case-insensitive
  const me = await api(S.admin, 'GET', '/auth/me');
  assert.equal(me.body.role, 'admin');
  assert.equal((await api('not-a-token', 'GET', '/godowns')).status, 401);
});

test('masters', async () => {
  const g1 = await api(S.admin, 'POST', '/godowns', { code: 'gd-main', name: 'Main Godown', address: 'Estate Road' });
  assert.equal(g1.status, 201);
  assert.equal(g1.body.code, 'GD-MAIN');
  S.g1 = g1.body.id;
  S.g2 = (await api(S.admin, 'POST', '/godowns', { code: 'GD-TOWN', name: 'Town Godown' })).body.id;
  assert.equal((await api(S.admin, 'POST', '/godowns', { code: 'GD-MAIN', name: 'Dup' })).status, 409);
  S.item = (await api(S.admin, 'POST', '/items', { code: 'ARA-PCH', name: 'Arabica Parchment', coffeeType: 'Arabica', form: 'Parchment', grade: 'A', bagGrams: 50000 })).body.id;
  S.client = (await api(S.admin, 'POST', '/clients', { code: 'CL1', name: 'Curing Works', address: 'Hassan' })).body.id;
  const upd = await api(S.admin, 'PUT', `/clients/${S.client}`, { code: 'CL1', name: 'Curing Works Ltd', address: 'Hassan', gstin: '29abcde1234f1z5' });
  assert.equal(upd.body.gstin, '29ABCDE1234F1Z5');
  assert.equal((await api(S.admin, 'PUT', `/clients/nope`, { code: 'X', name: 'X' })).status, 404);
  assert.equal((await api(S.admin, 'GET', '/items')).body.items[0].bagGrams, 50000);
});

test('receipt creates a lot and stock', async () => {
  const r = await api(S.admin, 'POST', '/receipts', { date: today, locationId: S.g1, itemId: S.item, grams: 1_000_000, bags: 20, lot: { cropYear: '2025-26', moisturePct: 10.5 }, opening: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.no, /^OPN-\d{4}-00001$/);
  assert.match(r.body.lotCode, /^LOT-\d{4}-00001$/);
  S.lot = r.body.lotId;
  const b = await bal(S.admin, S.g1, S.lot);
  assert.equal(b.onHandGrams, 1_000_000);
  assert.equal(b.onHandBags, 20);
  // Adding to an existing lot.
  const r2 = await api(S.admin, 'POST', '/receipts', { date: today, locationId: S.g1, itemId: S.item, lotId: S.lot, grams: 500, bags: 0 });
  assert.equal(r2.status, 201);
  S.smallReceipt = r2.body.id;
  assert.equal((await api(S.admin, 'POST', '/receipts', { date: '2099-01-01', locationId: S.g1, itemId: S.item, grams: 1, bags: 0 })).status, 422);
});

test('transfer moves stock and refuses to overdraw', async () => {
  const t = await api(S.admin, 'POST', '/transfers', { date: today, fromLocationId: S.g1, toLocationId: S.g2, lotId: S.lot, grams: 200_000, bags: 4 });
  assert.equal(t.status, 201);
  assert.equal((await bal(S.admin, S.g1, S.lot)).onHandGrams, 800_500);
  assert.equal((await bal(S.admin, S.g2, S.lot)).onHandGrams, 200_000);
  const over = await api(S.admin, 'POST', '/transfers', { date: today, fromLocationId: S.g2, toLocationId: S.g1, lotId: S.lot, grams: 200_001, bags: 1 });
  assert.equal(over.status, 422);
  assert.match(over.body.error.message, /available/);
  assert.equal((await bal(S.admin, S.g2, S.lot)).onHandGrams, 200_000);
});

test('adjustment needs a reason; reversal blocked once stock has moved on', async () => {
  assert.equal((await api(S.admin, 'POST', '/adjustments', { date: today, locationId: S.g1, lotId: S.lot, direction: 'OUT', grams: 500, bags: 0, reason: 'nope' })).status, 422);
  // Reasons belong to a direction: a gain can't be a write-off.
  assert.equal((await api(S.admin, 'POST', '/adjustments', { date: today, locationId: S.g1, lotId: S.lot, direction: 'IN', grams: 500, bags: 0, reason: 'Pest / mould write-off' })).status, 422);
  const reasons = (await api(S.admin, 'GET', '/reference/adjustment-reasons')).body.reasons;
  assert.ok(reasons.IN.includes('Sample returned') && !reasons.IN.includes('Spillage / bag damage'));
  const a = await api(S.admin, 'POST', '/adjustments', { date: today, locationId: S.g1, lotId: S.lot, direction: 'OUT', grams: 500, bags: 0, reason: 'Moisture / storage weight loss' });
  assert.equal(a.status, 201);
  assert.equal((await bal(S.admin, S.g1, S.lot)).onHandGrams, 800_000);
  // Reverse the adjustment: stock comes back, and it can't be reversed twice.
  assert.equal((await api(S.admin, 'POST', `/transactions/${a.body.id}/reverse`, { reason: 'entered twice' })).status, 201);
  assert.equal((await bal(S.admin, S.g1, S.lot)).onHandGrams, 800_500);
  assert.equal((await api(S.admin, 'POST', `/transactions/${a.body.id}/reverse`, { reason: 'again' })).status, 409);
});

test('roles and godown scope', async () => {
  const created = await api(S.admin, 'POST', '/users', { login: 'op1', name: 'Operator One', role: 'operator', password: 'operator1', godownIds: [S.g1] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  S.opId = created.body.users.find((u) => u.login === 'op1').id;
  await api(S.admin, 'POST', '/users', { login: 'viewer1', name: 'Viewer', role: 'viewer', password: 'viewer123' });
  assert.equal((await api(S.admin, 'POST', '/users', { login: 'op1', name: 'Dup', role: 'viewer', password: 'whatever1' })).status, 409);
  S.op = await login('op1', 'operator1');
  const viewer = await login('viewer1', 'viewer123');
  assert.equal((await api(viewer, 'POST', '/receipts', { date: today, locationId: S.g1, itemId: S.item, grams: 1, bags: 0 })).status, 403);
  assert.equal((await api(viewer, 'GET', '/stock/balances')).status, 200);
  assert.equal((await api(S.op, 'POST', '/receipts', { date: today, locationId: S.g2, itemId: S.item, grams: 1, bags: 0 })).status, 403);
  assert.equal((await api(S.op, 'POST', '/adjustments', { date: today, locationId: S.g1, lotId: S.lot, direction: 'IN', grams: 1, bags: 0, reason: 'Other', notes: 'x' })).status, 403);
  assert.equal((await api(S.op, 'POST', '/godowns', { code: 'X', name: 'X' })).status, 403);
  assert.equal((await api(S.op, 'GET', '/users')).status, 403);
  // Disabling a user takes effect immediately, even with a valid token.
  const v = (await api(S.admin, 'GET', '/users')).body.users.find((u) => u.login === 'viewer1');
  await api(S.admin, 'PATCH', `/users/${v.id}`, { active: false });
  assert.equal((await api(viewer, 'GET', '/godowns')).status, 401);
});

test('dispatch: draft holds stock, issues barcodes, posts once', async () => {
  const d = await api(S.op, 'POST', '/dispatches', { clientId: S.client, date: today, vehicleNo: 'ka 12 ab 3456', lines: [{ locationId: S.g1, lotId: S.lot, grams: 250_000, bags: 5 }] });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  S.d1 = d.body;
  assert.equal(d.body.status, 'DRAFT');
  assert.equal(d.body.vehicleNo, 'KA 12 AB 3456');
  assert.equal(d.body.destination, 'Hassan'); // defaults to the client address
  assert.equal(d.body.packages.length, 5);
  assert.equal(new Set(d.body.packages.map((p) => p.barcode)).size, 5);
  d.body.packages.forEach((p) => assert.match(p.barcode, /^PKG-[0-9A-Z]{11}$/));
  const b = await bal(S.admin, S.g1, S.lot);
  assert.equal(b.onHandGrams, 800_500);
  assert.equal(b.availableGrams, 550_500);
  // Another draft can't take the held stock.
  const over = await api(S.admin, 'POST', '/dispatches', { clientId: S.client, date: today, lines: [{ locationId: S.g1, lotId: S.lot, grams: 600_000, bags: 1 }] });
  assert.equal(over.status, 422);
  // Nor can an adjustment.
  assert.equal((await api(S.admin, 'POST', '/adjustments', { date: today, locationId: S.g1, lotId: S.lot, direction: 'OUT', grams: 600_000, bags: 0, reason: 'Spillage / bag damage' })).status, 422);

  // Package weights must add up before posting.
  const [p1, p2] = d.body.packages;
  await api(S.op, 'PUT', `/dispatches/${S.d1.id}/package-weights`, { weights: { [p1.id]: 49_500 } });
  const bad = await api(S.op, 'POST', `/dispatches/${S.d1.id}/post`);
  assert.equal(bad.status, 422);
  assert.match(bad.body.error.message, /packages total/);
  await api(S.op, 'PUT', `/dispatches/${S.d1.id}/package-weights`, { weights: { [p2.id]: 50_500 } });

  const posted = await api(S.op, 'POST', `/dispatches/${S.d1.id}/post`);
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  assert.equal(posted.body.status, 'DISPATCHED');
  posted.body.packages.forEach((p) => assert.equal(p.status, 'DISPATCHED'));
  const after = await bal(S.admin, S.g1, S.lot);
  assert.equal(after.onHandGrams, 550_500);
  assert.equal(after.availableGrams, 550_500);
  assert.equal((await api(S.op, 'POST', `/dispatches/${S.d1.id}/post`)).status, 409);
  assert.equal((await api(S.op, 'PUT', `/dispatches/${S.d1.id}/package-weights`, { weights: { [p1.id]: 1 } })).status, 409);
  assert.equal((await api(S.op, 'POST', `/dispatches/${S.d1.id}/printed`, { packageIds: [p1.id] })).status, 409);
});

test('editing draft lines retires old barcodes; header edits keep them', async () => {
  const d = await api(S.admin, 'POST', '/dispatches', { clientId: S.client, date: today, lines: [{ locationId: S.g1, lotId: S.lot, grams: 100_000, bags: 2 }] });
  const old = d.body.packages.map((p) => p.barcode);
  const body = { clientId: S.client, date: today, lines: [{ locationId: S.g1, lotId: S.lot, grams: 150_000, bags: 3 }] };
  const e = await api(S.admin, 'PUT', `/dispatches/${d.body.id}`, body);
  assert.equal(e.status, 200, JSON.stringify(e.body));
  const now = e.body.packages.map((p) => p.barcode);
  assert.equal(now.length, 3);
  assert.ok(old.every((b) => !now.includes(b)));
  for (const b of old) {
    const t = (await api(S.admin, 'GET', `/trace/${b}`)).body;
    assert.equal(t.found, true);
    assert.equal(t.package.status, 'CANCELLED');
  }
  const h = await api(S.admin, 'PUT', `/dispatches/${d.body.id}`, { ...body, vehicleNo: 'TN01' });
  assert.deepEqual(h.body.packages.map((p) => p.barcode), now);
  assert.equal((await bal(S.admin, S.g1, S.lot)).availableGrams, 400_500);
  // Cancelling releases the hold.
  const c = await api(S.admin, 'POST', `/dispatches/${d.body.id}/cancel`, { reason: 'client postponed' });
  assert.equal(c.body.status, 'CANCELLED');
  assert.equal((await bal(S.admin, S.g1, S.lot)).availableGrams, 550_500);
});

test('trace a package barcode', async () => {
  const p = S.d1.packages[1];
  const t = await api(S.admin, 'GET', `/trace/${encodeURIComponent(' ' + p.barcode.toLowerCase() + ' ')}`);
  assert.equal(t.body.found, true);
  assert.equal(t.body.client.name, 'Curing Works Ltd');
  assert.equal(t.body.godown.name, 'Main Godown');
  assert.equal(t.body.packageNo, `${S.d1.no}-002`);
  assert.equal(t.body.packageCount, 5);
  assert.equal(t.body.receipts.length, 2); // opening stock + the top-up into the same lot
  assert.equal(t.body.lot.moisturePct, 10.5);
  const typo = p.barcode.slice(0, 6) + (p.barcode[6] === 'A' ? 'B' : 'A') + p.barcode.slice(7);
  const bad = await api(S.admin, 'GET', `/trace/${typo}`);
  assert.equal(bad.body.found, false);
  assert.equal(bad.body.validFormat, false);
});

test('reverse a dispatch', async () => {
  assert.equal((await api(S.op, 'POST', `/dispatches/${S.d1.id}/reverse`, { reason: 'did not leave' })).status, 403);
  const r = await api(S.admin, 'POST', `/dispatches/${S.d1.id}/reverse`, { reason: 'Truck did not leave' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'REVERSED');
  assert.equal((await bal(S.admin, S.g1, S.lot)).onHandGrams, 800_500);
  assert.equal((await api(S.admin, 'GET', `/trace/${S.d1.packages[0].barcode}`)).body.package.status, 'CANCELLED');
  assert.equal((await api(S.admin, 'POST', `/dispatches/${S.d1.id}/reverse`, { reason: 'again' })).status, 409);
});

test('reversing a receipt is refused once its stock has moved on', async () => {
  const lotB = await api(S.admin, 'POST', '/receipts', { date: today, locationId: S.g1, itemId: S.item, grams: 10_000, bags: 1 });
  await api(S.admin, 'POST', '/transfers', { date: today, fromLocationId: S.g1, toLocationId: S.g2, lotId: lotB.body.lotId, grams: 6_000, bags: 1 });
  const r = await api(S.admin, 'POST', `/transactions/${lotB.body.id}/reverse`, { reason: 'typo' });
  assert.equal(r.status, 422);
});

test('database refuses to overdraw even when requests race', async () => {
  // Five simultaneous transfers of the whole available stock: the API pre-check may
  // pass for several, but the trigger lets exactly one through.
  const lot = await api(S.admin, 'POST', '/receipts', { date: today, locationId: S.g2, itemId: S.item, grams: 30_000, bags: 3 });
  const tries = await Promise.all(Array.from({ length: 5 }, () =>
    api(S.admin, 'POST', '/transfers', { date: today, fromLocationId: S.g2, toLocationId: S.g1, lotId: lot.body.lotId, grams: 30_000, bags: 3 })));
  assert.equal(tries.filter((t) => t.status === 201).length, 1, JSON.stringify(tries.map((t) => t.status)));
  const b = await bal(S.admin, S.g2, lot.body.lotId);
  assert.equal(b.onHandGrams, 0);
});

test('lists, dashboard and exports', async () => {
  const tx = await api(S.admin, 'GET', '/transactions?limit=5');
  assert.equal(tx.body.transactions.length, 5);
  assert.equal(tx.body.hasMore, true);
  const dash = await api(S.admin, 'GET', '/dashboard');
  assert.equal(dash.status, 200);
  assert.ok(dash.body.onHandGrams > 0);
  const lot = await api(S.admin, 'GET', `/lots/${S.lot}`);
  assert.ok(lot.body.history.length >= 5);
  const csv = await api(S.admin, 'GET', '/exports/ledger.csv');
  assert.match(csv.body, /Txn no,Type,Status/);
  const reg = await api(S.admin, 'GET', '/exports/dispatches.csv');
  assert.match(reg.body, /Dispatch no/);
  assert.equal((await api(S.admin, 'GET', '/dispatches?status=REVERSED')).body.dispatches.length, 1);
});

test('change own password', async () => {
  assert.equal((await api(S.op, 'POST', '/auth/change-password', { current: 'wrong', next: 'newpassword1' })).status, 422);
  assert.equal((await api(S.op, 'POST', '/auth/change-password', { current: 'operator1', next: 'newpassword1' })).status, 200);
  await login('op1', 'newpassword1');
});

// Last: writing to the local D1 file from a second process makes wrangler dev reload.
test('database rules hold even for direct SQL', async () => {
  assert.throws(() => d1('UPDATE stock_ledger SET grams = 1'), /ledger_immutable/);
  assert.throws(() => d1('DELETE FROM stock_ledger'), /ledger_immutable/);
  assert.throws(() => d1("UPDATE dispatch_packages SET barcode = 'PKG-XXXXXXXXXXX'"), /barcode_immutable/);
  assert.throws(() => d1('DELETE FROM dispatch_packages'), /barcode_immutable/);
  assert.throws(() => d1("UPDATE stock_txns SET effective_date = '2000-01-01'"), /ledger_immutable/);
  const [{ results }] = JSON.parse(d1('SELECT COUNT(*) AS n FROM (SELECT location_id, lot_id FROM stock_ledger GROUP BY location_id, lot_id HAVING SUM(grams) < 0 OR SUM(bags) < 0)'));
  assert.equal(results[0].n, 0);
});
