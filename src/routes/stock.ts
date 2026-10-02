import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { assertGodownAccess, requireAuth, requireRole } from '../middleware/auth';
import { bags, body, grams, id, isoDate, text } from '../lib/validate';
import { auditStmt } from '../lib/audit';
import { conflict, invalid, notFound } from '../lib/errors';
import { nextNo } from '../lib/numbers';
import { assertAvailable, balances, postStatements, requireLocation, requireLot } from '../lib/stock';
import { newId, nowIso, todayIso } from '../db';
import { TXN_TYPES } from '../../drizzle/schema';

export const stockRoutes = new Hono<AppEnv>();
stockRoutes.use('*', requireAuth);

const poster = requireRole('admin', 'manager', 'operator');

// Each direction has its own reasons: a loss can't be a "sample returned", nor a gain a write-off.
export const ADJUSTMENT_REASONS: Record<'OUT' | 'IN', string[]> = {
  OUT: [
    'Moisture / storage weight loss',
    'Sampling / quality draw',
    'Spillage / bag damage',
    'Pest / mould write-off',
    'Physical count correction (short)',
    'Other'
  ],
  IN: [
    'Moisture gain in storage',
    'Sample returned',
    'Physical count correction (extra found)',
    'Other'
  ]
};

function notFuture(date: string) {
  // One day of slack for time zones.
  if (date > new Date(Date.now() + 86400_000).toISOString().slice(0, 10)) throw invalid('Date cannot be in the future', 'date');
}

stockRoutes.get('/stock/balances', async (c) => {
  const q = c.req.query();
  const rows = await balances(c.env.DB, c.get('auth').orgId, {
    locationId: q.location_id || undefined, itemId: q.item_id || undefined, lotId: q.lot_id || undefined, exceptDispatch: q.except_dispatch || undefined
  });
  return c.json({ balances: rows });
});

stockRoutes.get('/lots', async (c) => {
  const q = c.req.query();
  const args: unknown[] = [c.get('auth').orgId];
  let where = 'org_id = ?';
  if (q.item_id) { where += ' AND item_id = ?'; args.push(q.item_id); }
  const rows = await c.env.DB.prepare(`SELECT * FROM lots WHERE ${where} ORDER BY created_at DESC LIMIT 500`).bind(...args).all();
  return c.json({ lots: rows.results.map(lotJson) });
});

function lotJson(r: Record<string, unknown>) {
  return {
    id: r.id, code: r.code, itemId: r.item_id, sourceType: r.source_type, sourceId: r.source_id, sourceRef: r.source_ref,
    cropYear: r.crop_year, moisturePct: r.moisture_pct, outturnPct: r.outturn_pct, notes: r.notes, createdAt: r.created_at
  };
}

stockRoutes.get('/lots/:id', async (c) => {
  const orgId = c.get('auth').orgId;
  const lot = await c.env.DB.prepare('SELECT * FROM lots WHERE id = ? AND org_id = ?').bind(c.req.param('id'), orgId).first();
  if (!lot) throw notFound('Lot');
  const history = await c.env.DB.prepare(`
    SELECT e.id, e.location_id, e.grams, e.bags, e.effective_date, t.id AS txn_id, t.no, t.type, t.status, t.posted_at, t.dispatch_id, t.reference, t.reason
    FROM stock_ledger e JOIN stock_txns t ON t.id = e.txn_id WHERE e.lot_id = ? ORDER BY e.id`).bind(lot.id).all();
  const packages = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM dispatch_packages WHERE lot_id = ? AND status = 'DISPATCHED'").bind(lot.id).first<{ n: number }>();
  return c.json({
    lot: lotJson(lot),
    packagesDispatched: packages!.n,
    history: history.results.map((h) => ({
      locationId: h.location_id, grams: h.grams, bags: h.bags, date: h.effective_date, txnId: h.txn_id, no: h.no, type: h.type,
      status: h.status, postedAt: h.posted_at, dispatchId: h.dispatch_id, reference: h.reference, reason: h.reason
    }))
  });
});

// Transactions with a one-line summary of what moved where.
stockRoutes.get('/transactions', async (c) => {
  const q = c.req.query();
  const orgId = c.get('auth').orgId;
  const limit = Math.min(Number(q.limit) || 50, 200);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const args: unknown[] = [orgId];
  let where = 't.org_id = ?';
  if (q.type && (TXN_TYPES as readonly string[]).includes(q.type)) { where += ' AND t.type = ?'; args.push(q.type); }
  const txns = await c.env.DB.prepare(`
    SELECT t.*, u.full_name AS posted_by_name FROM stock_txns t LEFT JOIN users u ON u.id = t.posted_by
    WHERE ${where} ORDER BY t.posted_at DESC, t.no DESC LIMIT ? OFFSET ?`).bind(...args, limit + 1, offset).all<Record<string, string>>();
  const page = txns.results.slice(0, limit);
  const entries = page.length
    ? (await c.env.DB.prepare(`SELECT e.txn_id, e.location_id, e.lot_id, lt.code AS lot_code, e.grams, e.bags FROM stock_ledger e JOIN lots lt ON lt.id = e.lot_id WHERE e.txn_id IN (${page.map(() => '?').join(',')}) ORDER BY e.id`)
        .bind(...page.map((t) => t.id)).all<{ txn_id: string; location_id: string; lot_id: string; lot_code: string; grams: number; bags: number }>()).results
    : [];
  return c.json({
    hasMore: txns.results.length > limit,
    transactions: page.map((t) => ({
      id: t.id, no: t.no, type: t.type, status: t.status, date: t.effective_date, postedAt: t.posted_at, postedBy: t.posted_by_name ?? '',
      reference: t.reference, reason: t.reason, notes: t.notes, reversesId: t.reverses_id, dispatchId: t.dispatch_id,
      entries: entries.filter((e) => e.txn_id === t.id).map((e) => ({ locationId: e.location_id, lotId: e.lot_id, lotCode: e.lot_code, grams: e.grams, bags: e.bags }))
    }))
  });
});

const lotDetails = z.object({
  code: z.string().trim().max(40).transform((s) => s.toUpperCase()).default(''),
  cropYear: text(20),
  moisturePct: z.number().min(0).max(100).nullable().default(null),
  outturnPct: z.number().min(0).max(100).nullable().default(null),
  sourceRef: text(120),
  notes: text(300)
});

stockRoutes.post('/receipts', poster, async (c) => {
  const auth = c.get('auth');
  const input = await body(c, z.object({
    date: isoDate, locationId: id, itemId: id, lotId: id.optional(), lot: lotDetails.optional(),
    grams, bags, reference: text(80), notes: text(300), opening: z.boolean().default(false)
  }));
  notFuture(input.date);
  const db = c.env.DB;
  await requireLocation(db, auth.orgId, input.locationId);
  await assertGodownAccess(c, [input.locationId]);
  const item = await db.prepare('SELECT id, active FROM items WHERE id = ? AND org_id = ?').bind(input.itemId, auth.orgId).first<{ id: string; active: number }>();
  if (!item) throw notFound('Item');
  if (!item.active) throw invalid('This coffee item is inactive');

  const stmts: D1PreparedStatement[] = [];
  let lotId = input.lotId;
  let lotCode: string;
  if (lotId) {
    const lot = await requireLot(db, auth.orgId, lotId);
    if (lot.item_id !== item.id) throw invalid(`Lot ${lot.code} belongs to a different item`, 'lotId');
    lotCode = lot.code;
  } else {
    const l = input.lot ?? lotDetails.parse({});
    lotCode = l.code || (await nextNo(db, auth.orgId, 'LOT', input.date));
    const dup = await db.prepare('SELECT 1 FROM lots WHERE org_id = ? AND code = ?').bind(auth.orgId, lotCode).first();
    if (dup) throw conflict(`Lot ${lotCode} already exists. Choose "Add to existing lot" instead.`);
    lotId = newId();
    stmts.push(db.prepare(`INSERT INTO lots (id, org_id, code, item_id, source_type, source_ref, crop_year, moisture_pct, outturn_pct, notes, created_at, created_by)
                           VALUES (?, ?, ?, ?, 'RECEIPT', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(lotId, auth.orgId, lotCode, item.id, l.sourceRef, l.cropYear, l.moisturePct, l.outturnPct, l.notes, nowIso(), auth.userId));
  }
  const post = await postStatements(db, {
    orgId: auth.orgId, userId: auth.userId, type: input.opening ? 'OPENING' : 'RECEIPT', date: input.date,
    reference: input.reference, notes: input.notes,
    entries: [{ locationId: input.locationId, lotId, itemId: item.id, grams: input.grams, bags: input.bags }]
  });
  stmts.push(...post.stmts, auditStmt(db, auth.orgId, 'stock_txns', post.id, 'post', `${post.no} lot ${lotCode}`, auth.userId));
  await db.batch(stmts);
  return c.json({ id: post.id, no: post.no, lotId, lotCode }, 201);
});

stockRoutes.post('/transfers', poster, async (c) => {
  const auth = c.get('auth');
  const input = await body(c, z.object({
    date: isoDate, fromLocationId: id, toLocationId: id, lotId: id, grams, bags, reference: text(80), notes: text(300)
  }));
  notFuture(input.date);
  if (input.fromLocationId === input.toLocationId) throw invalid('From and To godown must be different', 'toLocationId');
  const db = c.env.DB;
  await requireLocation(db, auth.orgId, input.fromLocationId, 'From godown');
  await requireLocation(db, auth.orgId, input.toLocationId, 'To godown');
  await assertGodownAccess(c, [input.fromLocationId]);
  const lot = await requireLot(db, auth.orgId, input.lotId);
  await assertAvailable(db, auth.orgId, [{ locationId: input.fromLocationId, lotId: lot.id, grams: input.grams, bags: input.bags }]);
  const post = await postStatements(db, {
    orgId: auth.orgId, userId: auth.userId, type: 'TRANSFER', date: input.date, reference: input.reference, notes: input.notes,
    entries: [
      { locationId: input.fromLocationId, lotId: lot.id, itemId: lot.item_id, grams: -input.grams, bags: -input.bags },
      { locationId: input.toLocationId, lotId: lot.id, itemId: lot.item_id, grams: input.grams, bags: input.bags }
    ]
  });
  await db.batch([...post.stmts, auditStmt(db, auth.orgId, 'stock_txns', post.id, 'post', post.no, auth.userId)]);
  return c.json({ id: post.id, no: post.no }, 201);
});

// Adjustments change stock without a matching document, so they need a manager.
stockRoutes.post('/adjustments', requireRole('admin', 'manager'), async (c) => {
  const auth = c.get('auth');
  const input = await body(c, z.object({
    date: isoDate, locationId: id, lotId: id, direction: z.enum(['IN', 'OUT']),
    grams: z.number().int().min(0).max(1e12), bags, reason: z.string().trim().min(1, 'Choose a reason'),
    reference: text(80), notes: text(300)
  }));
  notFuture(input.date);
  if (input.grams === 0 && input.bags === 0) throw invalid('Enter a kg or bag change');
  if (!ADJUSTMENT_REASONS[input.direction].includes(input.reason)) {
    throw invalid(`"${input.reason}" is not a reason for ${input.direction === 'IN' ? 'an increase' : 'a decrease'}`, 'reason');
  }
  if (input.reason === 'Other' && !input.notes) throw invalid('Notes are required when the reason is Other', 'notes');
  const db = c.env.DB;
  await requireLocation(db, auth.orgId, input.locationId);
  const lot = await requireLot(db, auth.orgId, input.lotId);
  const sign = input.direction === 'IN' ? 1 : -1;
  if (sign < 0) await assertAvailable(db, auth.orgId, [{ locationId: input.locationId, lotId: lot.id, grams: input.grams, bags: input.bags }]);
  const post = await postStatements(db, {
    orgId: auth.orgId, userId: auth.userId, type: 'ADJUSTMENT', date: input.date, reference: input.reference, notes: input.notes, reason: input.reason,
    entries: [{ locationId: input.locationId, lotId: lot.id, itemId: lot.item_id, grams: sign * input.grams, bags: sign * input.bags }]
  });
  await db.batch([...post.stmts, auditStmt(db, auth.orgId, 'stock_txns', post.id, 'post', `${post.no} ${input.reason}`, auth.userId)]);
  return c.json({ id: post.id, no: post.no }, 201);
});

// Reverse a receipt / transfer / adjustment by posting the opposite movement.
// Dispatches are reversed from the dispatch (so their barcodes are retired too).
stockRoutes.post('/transactions/:id/reverse', requireRole('admin', 'manager'), async (c) => {
  const auth = c.get('auth');
  const input = await body(c, z.object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(300) }));
  const db = c.env.DB;
  const txn = await db.prepare('SELECT * FROM stock_txns WHERE id = ? AND org_id = ?').bind(c.req.param('id'), auth.orgId).first<Record<string, string>>();
  if (!txn) throw notFound('Transaction');
  if (txn.type === 'DISPATCH') throw invalid('Undo a despatch from its despatch page');
  if (txn.type === 'REVERSAL') throw invalid('An undo cannot itself be undone. Record a new entry instead.');
  if (txn.status !== 'POSTED') throw conflict(`${txn.no} has already been undone`);
  const rev = await reversalStatements(db, auth.orgId, auth.userId, txn, input.reason);
  await db.batch([
    db.prepare("UPDATE stock_txns SET status = 'REVERSED' WHERE id = ? AND status = 'POSTED'").bind(txn.id),
    ...rev.stmts,
    auditStmt(db, auth.orgId, 'stock_txns', txn.id, 'reverse', `${txn.no} by ${rev.no}: ${input.reason}`, auth.userId)
  ]);
  return c.json({ id: rev.id, no: rev.no }, 201);
});

// Opposite ledger rows for a posted transaction; checks stock first for a clear message.
export async function reversalStatements(db: D1Database, orgId: string, userId: string, txn: Record<string, string>, reason: string) {
  const rows = await db.prepare('SELECT location_id, lot_id, item_id, grams, bags FROM stock_ledger WHERE txn_id = ?').bind(txn.id)
    .all<{ location_id: string; lot_id: string; item_id: string; grams: number; bags: number }>();
  const entries = rows.results.map((r) => ({ locationId: r.location_id, lotId: r.lot_id, itemId: r.item_id, grams: -r.grams, bags: -r.bags }));
  await assertAvailable(db, orgId, entries.filter((e) => e.grams < 0 || e.bags < 0).map((e) => ({ ...e, grams: -e.grams, bags: -e.bags })),
    txn.dispatch_id || undefined);
  return postStatements(db, { orgId, userId, type: 'REVERSAL', date: todayIso(), entries, reference: txn.no, reason, reversesId: txn.id, dispatchId: txn.dispatch_id || undefined });
}

// Full ledger as CSV (Excel-friendly), for audit and offline analysis.
stockRoutes.get('/exports/ledger.csv', async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT t.no, t.type, t.status, e.effective_date, g.name AS godown, lt.code AS lot, i.name AS item, e.grams, e.bags,
           t.reference, t.reason, t.posted_at, u.full_name AS posted_by
    FROM stock_ledger e JOIN stock_txns t ON t.id = e.txn_id JOIN locations g ON g.id = e.location_id
    JOIN lots lt ON lt.id = e.lot_id JOIN items i ON i.id = e.item_id LEFT JOIN users u ON u.id = t.posted_by
    WHERE e.org_id = ? ORDER BY e.id`).bind(c.get('auth').orgId).all<Record<string, string | number>>();
  return csv(c, 'stock-ledger.csv',
    ['Txn no', 'Type', 'Status', 'Date', 'Godown', 'Lot', 'Item', 'kg', 'Bags', 'Reference', 'Reason', 'Posted at', 'Posted by'],
    rows.results.map((r) => [r.no, r.type, r.status, r.effective_date, r.godown, r.lot, r.item, Number(r.grams) / 1000, r.bags, r.reference, r.reason, r.posted_at, r.posted_by]));
});

export function csv(c: { body: (b: string, s: 200, h: Record<string, string>) => Response }, name: string, head: string[], rows: unknown[][]) {
  const cell = (v: unknown) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(s) && !/^-?\d/.test(s)) s = "'" + s; // stop spreadsheet formulas running
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = '﻿' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  return c.body(text, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
}

stockRoutes.get('/reference/adjustment-reasons', (c) => c.json({ reasons: ADJUSTMENT_REASONS }));
