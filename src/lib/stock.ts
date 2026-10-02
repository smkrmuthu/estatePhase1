import { invalid, notFound } from './errors';
import { newId, nowIso } from '../db';
import { nextNo, TXN_PREFIX } from './numbers';
import type { TxnType } from '../../drizzle/schema';

export interface Balance {
  locationId: string;
  lotId: string;
  lotCode: string;
  itemId: string;
  onHandGrams: number;
  onHandBags: number;
  reservedGrams: number;
  reservedBags: number;
  availableGrams: number;
  availableBags: number;
}

// On hand from the ledger, minus what draft dispatches hold. exceptDispatch leaves one
// draft's own hold out (used when editing or posting that draft).
export async function balances(
  db: D1Database,
  orgId: string,
  f: { locationId?: string; itemId?: string; lotId?: string; exceptDispatch?: string; includeZero?: boolean } = {}
): Promise<Balance[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.locationId) { where.push('k.location_id = ?'); args.push(f.locationId); }
  if (f.lotId) { where.push('k.lot_id = ?'); args.push(f.lotId); }
  if (f.itemId) { where.push('lt.item_id = ?'); args.push(f.itemId); }
  const sql = `
    WITH h AS (
      SELECT location_id, lot_id, SUM(grams) AS g, SUM(bags) AS b FROM stock_ledger WHERE org_id = ?1 GROUP BY location_id, lot_id
    ), r AS (
      SELECT l.location_id, l.lot_id, SUM(l.grams) AS g, SUM(l.bags) AS b
      FROM dispatch_lines l JOIN dispatches d ON d.id = l.dispatch_id
      WHERE d.org_id = ?1 AND d.status = 'DRAFT' AND l.superseded_at IS NULL AND d.id IS NOT ?2
      GROUP BY l.location_id, l.lot_id
    ), k AS (SELECT location_id, lot_id FROM h UNION SELECT location_id, lot_id FROM r)
    SELECT k.location_id, k.lot_id, lt.code AS lot_code, lt.item_id,
           COALESCE(h.g, 0) AS hg, COALESCE(h.b, 0) AS hb, COALESCE(r.g, 0) AS rg, COALESCE(r.b, 0) AS rb
    FROM k JOIN lots lt ON lt.id = k.lot_id
    LEFT JOIN h ON h.location_id = k.location_id AND h.lot_id = k.lot_id
    LEFT JOIN r ON r.location_id = k.location_id AND r.lot_id = k.lot_id
    ${where.length ? 'WHERE ' + where.map((w, i) => w.replace('?', `?${i + 3}`)).join(' AND ') : ''}
    ORDER BY lt.code`;
  const rows = await db.prepare(sql).bind(orgId, f.exceptDispatch ?? null, ...args)
    .all<{ location_id: string; lot_id: string; lot_code: string; item_id: string; hg: number; hb: number; rg: number; rb: number }>();
  return rows.results
    .filter((r) => f.includeZero || r.hg !== 0 || r.hb !== 0 || r.rg !== 0)
    .map((r) => ({
      locationId: r.location_id, lotId: r.lot_id, lotCode: r.lot_code, itemId: r.item_id,
      onHandGrams: r.hg, onHandBags: r.hb, reservedGrams: r.rg, reservedBags: r.rb,
      availableGrams: r.hg - r.rg, availableBags: r.hb - r.rb
    }));
}

export async function available(db: D1Database, orgId: string, locationId: string, lotId: string, exceptDispatch?: string) {
  const [b] = await balances(db, orgId, { locationId, lotId, exceptDispatch, includeZero: true });
  return { grams: b?.availableGrams ?? 0, bags: b?.availableBags ?? 0 };
}

export const kg = (g: number) => (g / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 });

// Friendly pre-check before posting; the database trigger is the real guarantee.
export async function assertAvailable(
  db: D1Database, orgId: string,
  needs: { locationId: string; lotId: string; grams: number; bags: number }[],
  exceptDispatch?: string
) {
  const total = new Map<string, { locationId: string; lotId: string; grams: number; bags: number }>();
  for (const n of needs) {
    const k = `${n.locationId}|${n.lotId}`;
    const t = total.get(k) ?? { locationId: n.locationId, lotId: n.lotId, grams: 0, bags: 0 };
    t.grams += n.grams; t.bags += n.bags;
    total.set(k, t);
  }
  for (const t of total.values()) {
    const a = await available(db, orgId, t.locationId, t.lotId, exceptDispatch);
    if (t.grams > a.grams || t.bags > a.bags) {
      const info = await db.prepare('SELECT lt.code AS lot, g.name AS godown FROM lots lt, locations g WHERE lt.id = ? AND g.id = ?')
        .bind(t.lotId, t.locationId).first<{ lot: string; godown: string }>();
      throw invalid(`Lot ${info?.lot} in ${info?.godown}: ${kg(a.grams)} kg / ${a.bags} bags available, ${kg(t.grams)} kg / ${t.bags} bags needed.`);
    }
  }
}

export async function requireLocation(db: D1Database, orgId: string, id: string, label = 'Godown') {
  const row = await db.prepare("SELECT id, name, active FROM locations WHERE id = ? AND org_id = ? AND kind = 'GODOWN'").bind(id, orgId)
    .first<{ id: string; name: string; active: number }>();
  if (!row) throw notFound(label);
  if (!row.active) throw invalid(`${label} ${row.name} is inactive`);
  return row;
}

export async function requireLot(db: D1Database, orgId: string, id: string) {
  const row = await db.prepare('SELECT id, code, item_id FROM lots WHERE id = ? AND org_id = ?').bind(id, orgId)
    .first<{ id: string; code: string; item_id: string }>();
  if (!row) throw notFound('Lot');
  return row;
}

export interface Entry { locationId: string; lotId: string; itemId: string; grams: number; bags: number }

// Statements that write one posted transaction and its ledger rows. The caller sends
// them in a single batch together with anything else that must happen atomically.
export async function postStatements(
  db: D1Database,
  p: {
    orgId: string; userId: string; type: TxnType; date: string; entries: Entry[];
    reference?: string; reason?: string; notes?: string; reversesId?: string; dispatchId?: string; no?: string;
  }
) {
  const id = newId();
  const no = p.no ?? (await nextNo(db, p.orgId, TXN_PREFIX[p.type], p.date));
  const postedAt = nowIso();
  const stmts = [
    db.prepare(`INSERT INTO stock_txns (id, org_id, no, type, status, effective_date, posted_at, posted_by, reference, reason, notes, reverses_id, dispatch_id)
                VALUES (?, ?, ?, ?, 'POSTED', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, p.orgId, no, p.type, p.date, postedAt, p.userId, p.reference ?? '', p.reason ?? '', p.notes ?? '', p.reversesId ?? null, p.dispatchId ?? null),
    ...p.entries.map((e) =>
      db.prepare('INSERT INTO stock_ledger (org_id, txn_id, location_id, lot_id, item_id, grams, bags, effective_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(p.orgId, id, e.locationId, e.lotId, e.itemId, e.grams, e.bags, p.date))
  ];
  return { id, no, postedAt, stmts };
}
