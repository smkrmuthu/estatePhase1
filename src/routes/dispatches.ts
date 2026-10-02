import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, AuthContext } from '../types';
import { assertGodownAccess, requireAuth, requireRole } from '../middleware/auth';
import { bags, body, grams, id, isoDate, text } from '../lib/validate';
import { auditStmt } from '../lib/audit';
import { conflict, invalid, notFound } from '../lib/errors';
import { nextNo } from '../lib/numbers';
import { newBarcodeValue, normaliseBarcode } from '../lib/barcode';
import { assertAvailable, kg, postStatements, requireLocation, requireLot } from '../lib/stock';
import { newId, nowIso } from '../db';
import { csv, reversalStatements } from './stock';

export const dispatchRoutes = new Hono<AppEnv>();
dispatchRoutes.use('*', requireAuth);

const poster = requireRole('admin', 'manager', 'operator');
const MAX_PACKAGES = 1000;

const lineSchema = z.object({ locationId: id, lotId: id, grams, bags, packages: z.number().int().min(1).max(MAX_PACKAGES).optional() });
const draftSchema = z.object({
  clientId: id,
  date: isoDate,
  destination: text(300),
  vehicleNo: text(20).transform((s) => s.toUpperCase()),
  transporter: text(80),
  driverName: text(60),
  driverPhone: text(20),
  reference: text(80),
  notes: text(500),
  lines: z.array(lineSchema).min(1, 'Add at least one line').max(50)
});
type Draft = z.infer<typeof draftSchema>;

type DispatchRow = Record<string, string | null>;

async function loadDispatch(db: D1Database, orgId: string, dispatchId: string) {
  const d = await db.prepare('SELECT * FROM dispatches WHERE id = ? AND org_id = ?').bind(dispatchId, orgId).first<DispatchRow>();
  if (!d) throw notFound('Despatch');
  return d;
}

// Validates lines and resolves each lot's item. Packages default to one per bag.
async function cleanLines(c: { env: { DB: D1Database }; get: (k: 'auth') => AuthContext }, lines: Draft['lines']) {
  const { orgId } = c.get('auth');
  const out = [];
  for (const [i, l] of lines.entries()) {
    await requireLocation(c.env.DB, orgId, l.locationId, `Line ${i + 1} godown`);
    const lot = await requireLot(c.env.DB, orgId, l.lotId);
    const packages = l.packages ?? l.bags;
    if (packages < 1) throw invalid(`Line ${i + 1}: enter bags or the number of packages`, `lines.${i}.packages`);
    out.push({ ...l, itemId: lot.item_id, packages, lineNo: i + 1 });
  }
  const total = out.reduce((s, l) => s + l.packages, 0);
  if (total > MAX_PACKAGES) throw invalid(`A despatch can have at most ${MAX_PACKAGES} bag labels (this one has ${total})`);
  return out;
}

// Statements for new lines and their packages. Weight is split evenly with the
// remainder on the last package; bags are spread as evenly as possible.
function lineStatements(db: D1Database, orgId: string, dispatchId: string, lines: Awaited<ReturnType<typeof cleanLines>>) {
  const stmts: D1PreparedStatement[] = [];
  const at = nowIso();
  let seq = 1;
  for (const l of lines) {
    const lineId = newId();
    stmts.push(db.prepare('INSERT INTO dispatch_lines (id, org_id, dispatch_id, line_no, location_id, lot_id, item_id, grams, bags, packages) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(lineId, orgId, dispatchId, l.lineNo, l.locationId, l.lotId, l.itemId, l.grams, l.bags, l.packages));
    const baseG = Math.floor(l.grams / l.packages);
    const baseB = Math.floor(l.bags / l.packages);
    const extraBags = l.bags - baseB * l.packages;
    const rows: unknown[][] = [];
    for (let i = 0; i < l.packages; i++) {
      const g = i === l.packages - 1 ? l.grams - baseG * (l.packages - 1) : baseG;
      rows.push([newId(), orgId, dispatchId, lineId, l.lotId, seq++, newBarcodeValue(), g, baseB + (i < extraBags ? 1 : 0), at]);
    }
    // D1 allows 100 bound parameters per statement: 10 per row → 9 rows per insert.
    for (let i = 0; i < rows.length; i += 9) {
      const chunk = rows.slice(i, i + 9);
      stmts.push(db.prepare(`INSERT INTO dispatch_packages (id, org_id, dispatch_id, line_id, lot_id, seq, barcode, grams, bags, created_at) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`)
        .bind(...chunk.flat()));
    }
  }
  return stmts;
}

async function requireClient(db: D1Database, orgId: string, clientId: string) {
  const cl = await db.prepare('SELECT id, name, address, active FROM clients WHERE id = ? AND org_id = ?').bind(clientId, orgId)
    .first<{ id: string; name: string; address: string; active: number }>();
  if (!cl) throw notFound('Client');
  if (!cl.active) throw invalid(`Client ${cl.name} is inactive`, 'clientId');
  return cl;
}

async function assertDispatchGodowns(c: Parameters<typeof assertGodownAccess>[0], dispatchId: string) {
  const rows = await c.env.DB.prepare('SELECT DISTINCT location_id FROM dispatch_lines WHERE dispatch_id = ? AND superseded_at IS NULL').bind(dispatchId).all<{ location_id: string }>();
  await assertGodownAccess(c, rows.results.map((r) => r.location_id));
}

const headerValues = (input: Draft, destination: string) =>
  [input.clientId, input.date, destination, input.vehicleNo, input.transporter, input.driverName, input.driverPhone, input.reference, input.notes];

// ── list / detail ─────────────────────────────────────────────────────────

dispatchRoutes.get('/dispatches', async (c) => {
  const q = c.req.query();
  const orgId = c.get('auth').orgId;
  const limit = Math.min(Number(q.limit) || 50, 200);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const args: unknown[] = [orgId];
  let where = 'd.org_id = ?';
  if (q.status) { where += ' AND d.status = ?'; args.push(q.status); }
  const rows = await c.env.DB.prepare(`
    SELECT d.id, d.no, d.status, d.dispatch_date, d.vehicle_no, d.created_at, c.name AS client_name,
      (SELECT COALESCE(SUM(grams), 0) FROM dispatch_lines WHERE dispatch_id = d.id AND superseded_at IS NULL) AS grams,
      (SELECT COALESCE(SUM(bags), 0) FROM dispatch_lines WHERE dispatch_id = d.id AND superseded_at IS NULL) AS bags,
      (SELECT COUNT(*) FROM dispatch_packages WHERE dispatch_id = d.id AND status <> 'CANCELLED') AS packages
    FROM dispatches d JOIN clients c ON c.id = d.client_id
    WHERE ${where} ORDER BY d.created_at DESC LIMIT ? OFFSET ?`).bind(...args, limit + 1, offset).all<Record<string, string | number>>();
  return c.json({
    hasMore: rows.results.length > limit,
    dispatches: rows.results.slice(0, limit).map((r) => ({
      id: r.id, no: r.no, status: r.status, date: r.dispatch_date, vehicleNo: r.vehicle_no, createdAt: r.created_at,
      clientName: r.client_name, grams: r.grams, bags: r.bags, packages: r.packages
    }))
  });
});

async function detail(db: D1Database, orgId: string, dispatchId: string) {
  const d = await db.prepare(`
    SELECT d.*, cu.full_name AS created_by_name, pu.full_name AS posted_by_name FROM dispatches d
    LEFT JOIN users cu ON cu.id = d.created_by LEFT JOIN users pu ON pu.id = d.posted_by
    WHERE d.id = ? AND d.org_id = ?`).bind(dispatchId, orgId).first<DispatchRow>();
  if (!d) throw notFound('Despatch');
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(d.client_id).first<Record<string, string>>();
  const lines = await db.prepare(`
    SELECT l.*, lt.code AS lot_code, i.name AS item_name, i.coffee_type, i.form, i.grade, g.name AS godown_name
    FROM dispatch_lines l JOIN lots lt ON lt.id = l.lot_id JOIN items i ON i.id = l.item_id JOIN locations g ON g.id = l.location_id
    WHERE l.dispatch_id = ? AND l.superseded_at IS NULL ORDER BY l.line_no`).bind(d.id).all<Record<string, string | number>>();
  // Live packages; for a cancelled/reversed dispatch, the ones retired with it.
  const live = d.status === 'DRAFT' || d.status === 'DISPATCHED';
  const packages = await db.prepare(`
    SELECT p.*, lt.code AS lot_code FROM dispatch_packages p JOIN lots lt ON lt.id = p.lot_id
    WHERE p.dispatch_id = ? AND ${live ? "p.status <> 'CANCELLED'" : 'p.cancelled_at = ?'} ORDER BY p.seq`)
    .bind(...(live ? [d.id] : [d.id, d.closed_at])).all<Record<string, string | number>>();
  return {
    id: d.id, no: d.no, status: d.status, date: d.dispatch_date, destination: d.destination, vehicleNo: d.vehicle_no,
    transporter: d.transporter, driverName: d.driver_name, driverPhone: d.driver_phone, reference: d.reference, notes: d.notes,
    statusReason: d.status_reason, createdAt: d.created_at, createdBy: d.created_by_name, postedAt: d.posted_at, postedBy: d.posted_by_name,
    closedAt: d.closed_at, txnId: d.txn_id,
    client: { id: client!.id, code: client!.code, name: client!.name, contactPerson: client!.contact_person, phone: client!.phone, address: client!.address, gstin: client!.gstin },
    lines: lines.results.map((l) => {
      const mine = packages.results.filter((p) => p.line_id === l.id);
      const pg = mine.reduce((s, p) => s + Number(p.grams), 0);
      const pb = mine.reduce((s, p) => s + Number(p.bags), 0);
      return {
        id: l.id, lineNo: l.line_no, locationId: l.location_id, godownName: l.godown_name, lotId: l.lot_id, lotCode: l.lot_code,
        itemId: l.item_id, itemName: l.item_name, coffeeType: l.coffee_type, form: l.form, grade: l.grade,
        grams: l.grams, bags: l.bags, packages: l.packages, packageGrams: pg, packageBags: pb, reconciles: pg === l.grams && pb === l.bags
      };
    }),
    packages: packages.results.map((p) => ({
      id: p.id, lineId: p.line_id, lotId: p.lot_id, lotCode: p.lot_code, seq: p.seq, barcode: p.barcode, grams: p.grams, bags: p.bags,
      status: p.status, printCount: p.print_count, createdAt: p.created_at, dispatchedAt: p.dispatched_at, cancelledAt: p.cancelled_at
    }))
  };
}

dispatchRoutes.get('/dispatches/:id', async (c) => c.json(await detail(c.env.DB, c.get('auth').orgId, c.req.param('id')!)));

// ── drafts ─────────────────────────────────────────────────────────────────

// Saving a draft holds the stock and issues one barcode per package, so labels
// can be printed and stuck on before the vehicle is loaded.
dispatchRoutes.post('/dispatches', poster, async (c) => {
  const auth = c.get('auth');
  const db = c.env.DB;
  const input = await body(c, draftSchema);
  const client = await requireClient(db, auth.orgId, input.clientId);
  const lines = await cleanLines(c, input.lines);
  await assertGodownAccess(c, lines.map((l) => l.locationId));
  await assertAvailable(db, auth.orgId, lines);
  const id = newId();
  const no = await nextNo(db, auth.orgId, 'DSP', input.date);
  const at = nowIso();
  await db.batch([
    db.prepare(`INSERT INTO dispatches (id, org_id, no, status, client_id, dispatch_date, destination, vehicle_no, transporter, driver_name, driver_phone, reference, notes, created_at, created_by, updated_at)
                VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, auth.orgId, no, ...headerValues(input, input.destination || client.address), at, auth.userId, at),
    ...lineStatements(db, auth.orgId, id, lines),
    auditStmt(db, auth.orgId, 'dispatches', id, 'create', no, auth.userId)
  ]);
  return c.json(await detail(db, auth.orgId, id), 201);
});

// Header-only changes keep the barcodes. Changing godown, lot, bags, kg or package
// count retires the old barcodes (never reused) and issues new ones.
dispatchRoutes.put('/dispatches/:id', poster, async (c) => {
  const auth = c.get('auth');
  const db = c.env.DB;
  const d = await loadDispatch(db, auth.orgId, c.req.param('id')!);
  if (d.status !== 'DRAFT') throw conflict('Only despatches still loading can be edited');
  const input = await body(c, draftSchema);
  const client = await requireClient(db, auth.orgId, input.clientId);
  const lines = await cleanLines(c, input.lines);
  const old = await db.prepare('SELECT location_id, lot_id, grams, bags, packages FROM dispatch_lines WHERE dispatch_id = ? AND superseded_at IS NULL ORDER BY line_no')
    .bind(d.id).all<{ location_id: string; lot_id: string; grams: number; bags: number; packages: number }>();
  const changed = JSON.stringify(old.results.map((l) => [l.location_id, l.lot_id, l.grams, l.bags, l.packages]))
    !== JSON.stringify(lines.map((l) => [l.locationId, l.lotId, l.grams, l.bags, l.packages]));
  await assertGodownAccess(c, [...lines.map((l) => l.locationId), ...old.results.map((l) => l.location_id)]);
  const at = nowIso();
  const stmts = [
    db.prepare(`UPDATE dispatches SET client_id = ?, dispatch_date = ?, destination = ?, vehicle_no = ?, transporter = ?, driver_name = ?, driver_phone = ?, reference = ?, notes = ?, updated_at = ?
                WHERE id = ? AND status = 'DRAFT'`).bind(...headerValues(input, input.destination || client.address), at, d.id)
  ];
  if (changed) {
    await assertAvailable(db, auth.orgId, lines, d.id!);
    stmts.push(
      db.prepare('UPDATE dispatch_lines SET superseded_at = ? WHERE dispatch_id = ? AND superseded_at IS NULL').bind(at, d.id),
      db.prepare("UPDATE dispatch_packages SET status = 'CANCELLED', cancelled_at = ? WHERE dispatch_id = ? AND status = 'PREPARED'").bind(at, d.id),
      ...lineStatements(db, auth.orgId, d.id!, lines)
    );
  }
  stmts.push(auditStmt(db, auth.orgId, 'dispatches', d.id!, 'update', `${d.no}${changed ? ' lines changed, barcodes reissued' : ''}`, auth.userId));
  await db.batch(stmts);
  return c.json(await detail(db, auth.orgId, d.id!));
});

// Actual weighed net kg per package (draft only). Totals must match the line before posting.
dispatchRoutes.put('/dispatches/:id/package-weights', poster, async (c) => {
  const auth = c.get('auth');
  const db = c.env.DB;
  const d = await loadDispatch(db, auth.orgId, c.req.param('id')!);
  if (d.status !== 'DRAFT') throw conflict('Bag weights can only be changed while loading');
  await assertDispatchGodowns(c, d.id!);
  const input = await body(c, z.object({ weights: z.record(z.string(), grams) }));
  const ids = Object.keys(input.weights);
  if (!ids.length) throw invalid('No weights given');
  const found = await db.prepare(`SELECT COUNT(*) AS n FROM dispatch_packages WHERE dispatch_id = ? AND status = 'PREPARED' AND id IN (${ids.map(() => '?').join(',')})`)
    .bind(d.id, ...ids).first<{ n: number }>();
  if (found!.n !== ids.length) throw invalid('Some bags are not on this despatch');
  await db.batch([
    ...ids.map((pid) => db.prepare('UPDATE dispatch_packages SET grams = ? WHERE id = ? AND dispatch_id = ?').bind(input.weights[pid], pid, d.id)),
    db.prepare('UPDATE dispatches SET updated_at = ? WHERE id = ?').bind(nowIso(), d.id),
    auditStmt(db, auth.orgId, 'dispatches', d.id!, 'package_weights', `${d.no}: ${ids.length} package weight(s)`, auth.userId)
  ]);
  return c.json(await detail(db, auth.orgId, d.id!));
});

// ── post / cancel / reverse ──────────────────────────────────────────────

dispatchRoutes.post('/dispatches/:id/post', poster, async (c) => {
  const auth = c.get('auth');
  const db = c.env.DB;
  const d = await loadDispatch(db, auth.orgId, c.req.param('id')!);
  if (d.status !== 'DRAFT') throw conflict(`${d.no} is already ${d.status === 'DISPATCHED' ? 'despatched' : String(d.status).toLowerCase()}`);
  const info = await detail(db, auth.orgId, d.id!);
  const bad = info.lines.find((l) => !l.reconciles);
  if (bad) throw invalid(`Line ${bad.lineNo}: packages total ${kg(Number(bad.packageGrams))} kg / ${bad.packageBags} bags but the line is ${kg(Number(bad.grams))} kg / ${bad.bags} bags. Fix the bag weights first.`);
  await assertGodownAccess(c, info.lines.map((l) => String(l.locationId)));
  const entries = info.lines.map((l) => ({ locationId: String(l.locationId), lotId: String(l.lotId), itemId: String(l.itemId), grams: -Number(l.grams), bags: -Number(l.bags) }));
  await assertAvailable(db, auth.orgId, entries.map((e) => ({ ...e, grams: -e.grams, bags: -e.bags })), d.id!);
  const post = await postStatements(db, { orgId: auth.orgId, userId: auth.userId, type: 'DISPATCH', date: d.dispatch_date!, no: d.no!, reference: info.client.name, notes: d.notes!, dispatchId: d.id!, entries });
  // Order matters: the dispatch leaves DRAFT first (so its own hold stops counting),
  // then the transaction row (whose trigger checks this happened exactly once), then the ledger.
  await db.batch([
    db.prepare("UPDATE dispatches SET status = 'DISPATCHED', txn_id = ?, posted_at = ?, posted_by = ?, updated_at = ? WHERE id = ? AND status = 'DRAFT'")
      .bind(post.id, post.postedAt, auth.userId, post.postedAt, d.id),
    ...post.stmts,
    db.prepare("UPDATE dispatch_packages SET status = 'DISPATCHED', dispatched_at = ? WHERE dispatch_id = ? AND status = 'PREPARED'").bind(post.postedAt, d.id),
    auditStmt(db, auth.orgId, 'dispatches', d.id!, 'post', `${d.no} dispatched (${info.packages.length} packages)`, auth.userId)
  ]);
  return c.json(await detail(db, auth.orgId, d.id!));
});

dispatchRoutes.post('/dispatches/:id/cancel', poster, async (c) => {
  const auth = c.get('auth');
  const db = c.env.DB;
  const d = await loadDispatch(db, auth.orgId, c.req.param('id')!);
  if (d.status !== 'DRAFT') throw conflict('Only despatches still loading can be cancelled');
  await assertDispatchGodowns(c, d.id!);
  const input = await body(c, z.object({ reason: text(300) }));
  const at = nowIso();
  await db.batch([
    db.prepare("UPDATE dispatches SET status = 'CANCELLED', status_reason = ?, closed_at = ?, updated_at = ? WHERE id = ? AND status = 'DRAFT'").bind(input.reason, at, at, d.id),
    db.prepare("UPDATE dispatch_packages SET status = 'CANCELLED', cancelled_at = ? WHERE dispatch_id = ? AND status = 'PREPARED'").bind(at, d.id),
    auditStmt(db, auth.orgId, 'dispatches', d.id!, 'cancel', `${d.no}: ${input.reason}`, auth.userId)
  ]);
  return c.json(await detail(db, auth.orgId, d.id!));
});

// For a posting made by mistake (the goods did not leave): stock returns to the same
// godown and lot, and the barcodes are retired (they still resolve, showing REVERSED).
dispatchRoutes.post('/dispatches/:id/reverse', requireRole('admin', 'manager'), async (c) => {
  const auth = c.get('auth');
  const db = c.env.DB;
  const d = await loadDispatch(db, auth.orgId, c.req.param('id')!);
  if (d.status !== 'DISPATCHED') throw conflict('Only despatches whose truck has left can be undone');
  const input = await body(c, z.object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(300) }));
  const txn = await db.prepare('SELECT * FROM stock_txns WHERE id = ?').bind(d.txn_id).first<Record<string, string>>();
  const rev = await reversalStatements(db, auth.orgId, auth.userId, txn!, input.reason);
  await db.batch([
    db.prepare("UPDATE stock_txns SET status = 'REVERSED' WHERE id = ? AND status = 'POSTED'").bind(txn!.id),
    ...rev.stmts,
    db.prepare("UPDATE dispatches SET status = 'REVERSED', status_reason = ?, closed_at = ?, updated_at = ? WHERE id = ? AND status = 'DISPATCHED'")
      .bind(input.reason, rev.postedAt, rev.postedAt, d.id),
    db.prepare("UPDATE dispatch_packages SET status = 'CANCELLED', cancelled_at = ? WHERE dispatch_id = ? AND status = 'DISPATCHED'").bind(rev.postedAt, d.id),
    auditStmt(db, auth.orgId, 'dispatches', d.id!, 'reverse', `${d.no} by ${rev.no}: ${input.reason}`, auth.userId)
  ]);
  return c.json(await detail(db, auth.orgId, d.id!));
});

dispatchRoutes.post('/dispatches/:id/printed', async (c) => {
  const auth = c.get('auth');
  const db = c.env.DB;
  const d = await loadDispatch(db, auth.orgId, c.req.param('id')!);
  const input = await body(c, z.object({ packageIds: z.array(z.string()).min(1).max(MAX_PACKAGES) }));
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < input.packageIds.length; i += 90) {
    const chunk = input.packageIds.slice(i, i + 90);
    stmts.push(db.prepare(`UPDATE dispatch_packages SET print_count = print_count + 1 WHERE dispatch_id = ? AND id IN (${chunk.map(() => '?').join(',')})`).bind(d.id, ...chunk));
  }
  stmts.push(auditStmt(db, auth.orgId, 'dispatches', d.id!, 'print', `${d.no}: ${input.packageIds.length} label(s)`, auth.userId));
  await db.batch(stmts);
  return c.json({ ok: true });
});

// ── trace ────────────────────────────────────────────────────────────────

dispatchRoutes.get('/trace/:code', async (c) => {
  const orgId = c.get('auth').orgId;
  const db = c.env.DB;
  const n = normaliseBarcode(c.req.param('code'));
  const p = await db.prepare('SELECT * FROM dispatch_packages WHERE barcode = ? AND org_id = ?').bind(n.value, orgId).first<Record<string, string | number>>();
  if (!p) return c.json({ found: false, value: n.value, validFormat: n.valid });
  const d = await detail(db, orgId, String(p.dispatch_id));
  const line = await db.prepare(`SELECT l.location_id, g.name AS godown_name FROM dispatch_lines l JOIN locations g ON g.id = l.location_id WHERE l.id = ?`)
    .bind(p.line_id).first<{ location_id: string; godown_name: string }>();
  const lot = await db.prepare('SELECT * FROM lots WHERE id = ?').bind(p.lot_id).first<Record<string, unknown>>();
  const item = await db.prepare('SELECT * FROM items WHERE id = ?').bind(lot!.item_id).first<Record<string, unknown>>();
  const receipts = await db.prepare(`
    SELECT DISTINCT t.no, t.type, t.posted_at, g.name AS godown_name FROM stock_ledger e JOIN stock_txns t ON t.id = e.txn_id JOIN locations g ON g.id = e.location_id
    WHERE e.lot_id = ? AND t.type IN ('RECEIPT', 'OPENING') ORDER BY t.posted_at`).bind(p.lot_id).all<Record<string, string>>();
  const siblings = await db.prepare("SELECT COUNT(*) AS n FROM dispatch_packages WHERE dispatch_id = ? AND (status <> 'CANCELLED' OR cancelled_at = ?)")
    .bind(p.dispatch_id, p.cancelled_at ?? '').first<{ n: number }>();
  return c.json({
    found: true,
    value: p.barcode,
    package: { id: p.id, seq: p.seq, barcode: p.barcode, grams: p.grams, bags: p.bags, status: p.status, printCount: p.print_count, createdAt: p.created_at, dispatchedAt: p.dispatched_at, cancelledAt: p.cancelled_at },
    packageNo: `${d.no}-${String(p.seq).padStart(3, '0')}`,
    packageCount: siblings!.n,
    dispatch: { id: d.id, no: d.no, status: d.status, date: d.date, vehicleNo: d.vehicleNo, driverName: d.driverName, destination: d.destination, statusReason: d.statusReason },
    client: { name: d.client.name },
    lot: { id: lot!.id, code: lot!.code, cropYear: lot!.crop_year, sourceType: lot!.source_type, sourceRef: lot!.source_ref, moisturePct: lot!.moisture_pct },
    item: { name: item!.name, coffeeType: item!.coffee_type, form: item!.form, grade: item!.grade },
    godown: line ? { id: line.location_id, name: line.godown_name } : null,
    receipts: receipts.results.map((r) => ({ no: r.no, type: r.type, postedAt: r.posted_at, godownName: r.godown_name }))
  });
});

dispatchRoutes.get('/exports/dispatches.csv', async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT d.no, d.dispatch_date, d.status, c.name AS client, d.destination, d.vehicle_no, d.driver_name, g.name AS godown, lt.code AS lot, i.name AS item, l.grams, l.bags, l.packages
    FROM dispatches d JOIN clients c ON c.id = d.client_id JOIN dispatch_lines l ON l.dispatch_id = d.id AND l.superseded_at IS NULL
    JOIN locations g ON g.id = l.location_id JOIN lots lt ON lt.id = l.lot_id JOIN items i ON i.id = l.item_id
    WHERE d.org_id = ? ORDER BY d.created_at, l.line_no`).bind(c.get('auth').orgId).all<Record<string, string | number>>();
  return csv(c, 'dispatch-register.csv',
    ['Dispatch no', 'Date', 'Status', 'Client', 'Destination', 'Vehicle', 'Driver', 'Godown', 'Lot', 'Item', 'kg', 'Bags', 'Packages'],
    rows.results.map((r) => [r.no, r.dispatch_date, r.status, r.client, r.destination, r.vehicle_no, r.driver_name, r.godown, r.lot, r.item, Number(r.grams) / 1000, r.bags, r.packages]));
});

// ── dashboard ──────────────────────────────────────────────────────────────

dispatchRoutes.get('/dashboard', async (c) => {
  const orgId = c.get('auth').orgId;
  const db = c.env.DB;
  const month = new Date().toISOString().slice(0, 7);
  const [byGodown, byItem, reserved, drafts, monthly, lots] = await db.batch([
    db.prepare("SELECT g.id, g.name, COALESCE(SUM(e.grams), 0) AS grams, COALESCE(SUM(e.bags), 0) AS bags FROM locations g LEFT JOIN stock_ledger e ON e.location_id = g.id WHERE g.org_id = ? AND g.kind = 'GODOWN' AND g.active = 1 GROUP BY g.id ORDER BY g.name").bind(orgId),
    db.prepare('SELECT i.id, i.name, i.coffee_type, i.form, i.grade, SUM(e.grams) AS grams, SUM(e.bags) AS bags FROM stock_ledger e JOIN items i ON i.id = e.item_id WHERE e.org_id = ? GROUP BY i.id HAVING SUM(e.grams) <> 0 OR SUM(e.bags) <> 0 ORDER BY i.name').bind(orgId),
    db.prepare("SELECT COALESCE(SUM(l.grams), 0) AS grams, COALESCE(SUM(l.bags), 0) AS bags FROM dispatch_lines l JOIN dispatches d ON d.id = l.dispatch_id WHERE d.org_id = ? AND d.status = 'DRAFT' AND l.superseded_at IS NULL").bind(orgId),
    db.prepare("SELECT d.id, d.no, d.status, d.dispatch_date, d.vehicle_no, c.name AS client_name, (SELECT COALESCE(SUM(grams), 0) FROM dispatch_lines WHERE dispatch_id = d.id AND superseded_at IS NULL) AS grams, (SELECT COALESCE(SUM(bags), 0) FROM dispatch_lines WHERE dispatch_id = d.id AND superseded_at IS NULL) AS bags, (SELECT COUNT(*) FROM dispatch_packages WHERE dispatch_id = d.id AND status <> 'CANCELLED') AS packages FROM dispatches d JOIN clients c ON c.id = d.client_id WHERE d.org_id = ? AND d.status = 'DRAFT' ORDER BY d.created_at DESC LIMIT 20").bind(orgId),
    db.prepare("SELECT COUNT(DISTINCT d.id) AS n, COALESCE(SUM(l.grams), 0) AS grams, COALESCE(SUM(l.bags), 0) AS bags FROM dispatches d JOIN dispatch_lines l ON l.dispatch_id = d.id AND l.superseded_at IS NULL WHERE d.org_id = ? AND d.status = 'DISPATCHED' AND substr(d.dispatch_date, 1, 7) = ?").bind(orgId, month),
    db.prepare('SELECT COUNT(*) AS n FROM (SELECT lot_id FROM stock_ledger WHERE org_id = ? GROUP BY lot_id HAVING SUM(grams) > 0)').bind(orgId)
  ]);
  type R = Record<string, string | number>;
  const g = byGodown.results as R[];
  return c.json({
    onHandGrams: g.reduce((s, r) => s + Number(r.grams), 0),
    onHandBags: g.reduce((s, r) => s + Number(r.bags), 0),
    reservedGrams: Number((reserved.results[0] as R).grams),
    reservedBags: Number((reserved.results[0] as R).bags),
    draftCount: drafts.results.length,
    monthDispatchCount: Number((monthly.results[0] as R).n),
    monthDispatchGrams: Number((monthly.results[0] as R).grams),
    monthDispatchBags: Number((monthly.results[0] as R).bags),
    lotsInStock: Number((lots.results[0] as R).n),
    byGodown: g.map((r) => ({ id: r.id, name: r.name, grams: r.grams, bags: r.bags })),
    byItem: (byItem.results as R[]).map((r) => ({ id: r.id, name: r.name, coffeeType: r.coffee_type, form: r.form, grade: r.grade, grams: r.grams, bags: r.bags })),
    drafts: (drafts.results as R[]).map((r) => ({ id: r.id, no: r.no, status: r.status, date: r.dispatch_date, vehicleNo: r.vehicle_no, clientName: r.client_name, grams: r.grams, bags: r.bags, packages: r.packages }))
  });
});
