import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { requireAuth, requireRole } from '../middleware/auth';
import { body } from '../lib/validate';
import { auditStmt } from '../lib/audit';
import { conflict, notFound } from '../lib/errors';
import { newId, nowIso } from '../db';

// Godowns, coffee items and clients share one shape: a unique code, a name, a few
// descriptive fields and an active flag. Records in use are deactivated, never deleted.

type Field = { col: string; key: string; schema: z.ZodTypeAny; json?: (v: unknown) => unknown; db?: (v: unknown) => unknown };

const code = z.string().trim().min(1, 'Code is required').max(30).transform((s) => s.toUpperCase());
const name = z.string().trim().min(1, 'Name is required').max(80);
const str = (max: number) => z.string().trim().max(max).default('');

const MASTERS: Record<string, { table: string; label: string; fields: Field[]; where?: string }> = {
  godowns: {
    table: 'locations', label: 'Godown', where: "kind = 'GODOWN'",
    fields: [{ col: 'address', key: 'address', schema: str(200) }]
  },
  items: {
    table: 'items', label: 'Item',
    fields: [
      { col: 'coffee_type', key: 'coffeeType', schema: str(30) },
      { col: 'form', key: 'form', schema: str(30) },
      { col: 'grade', key: 'grade', schema: str(20) },
      { col: 'bag_grams', key: 'bagGrams', schema: z.number().int().positive().max(1e7).nullable().default(null) }
    ]
  },
  clients: {
    table: 'clients', label: 'Client',
    fields: [
      { col: 'contact_person', key: 'contactPerson', schema: str(80) },
      { col: 'phone', key: 'phone', schema: str(30) },
      { col: 'address', key: 'address', schema: str(300) },
      { col: 'gstin', key: 'gstin', schema: str(15).transform((s) => s.toUpperCase()) }
    ]
  }
};

function toJson(fields: Field[], r: Record<string, unknown>) {
  const out: Record<string, unknown> = { id: r.id, code: r.code, name: r.name, active: !!r.active, createdAt: r.created_at };
  for (const f of fields) out[f.key] = r[f.col];
  return out;
}

export const masterRoutes = new Hono<AppEnv>();
masterRoutes.use('*', requireAuth);

for (const [path, m] of Object.entries(MASTERS)) {
  const schema = z.object({ code, name, active: z.boolean().default(true), ...Object.fromEntries(m.fields.map((f) => [f.key, f.schema])) });
  const scope = m.where ? ` AND ${m.where}` : '';

  masterRoutes.get(`/${path}`, async (c) => {
    const rows = await c.env.DB.prepare(`SELECT * FROM ${m.table} WHERE org_id = ?${scope} ORDER BY active DESC, code`).bind(c.get('auth').orgId).all();
    return c.json({ [path]: rows.results.map((r) => toJson(m.fields, r)) });
  });

  masterRoutes.post(`/${path}`, requireRole('admin', 'manager'), async (c) => {
    const auth = c.get('auth');
    const input = (await body(c, schema)) as Record<string, unknown>;
    const dup = await c.env.DB.prepare(`SELECT 1 FROM ${m.table} WHERE org_id = ? AND code = ?`).bind(auth.orgId, input.code).first();
    if (dup) throw conflict(`${m.label} code "${input.code}" is already used`);
    const id = newId();
    const cols = ['id', 'org_id', 'code', 'name', 'active', 'created_at', ...m.fields.map((f) => f.col)];
    const vals = [id, auth.orgId, input.code, input.name, input.active ? 1 : 0, nowIso(), ...m.fields.map((f) => input[f.key] ?? null)];
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO ${m.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...vals),
      auditStmt(c.env.DB, auth.orgId, m.table, id, 'create', String(input.code), auth.userId)
    ]);
    const row = await c.env.DB.prepare(`SELECT * FROM ${m.table} WHERE id = ?`).bind(id).first();
    return c.json(toJson(m.fields, row!), 201);
  });

  masterRoutes.put(`/${path}/:id`, requireRole('admin', 'manager'), async (c) => {
    const auth = c.get('auth');
    const id = c.req.param('id')!;
    const input = (await body(c, schema)) as Record<string, unknown>;
    const exists = await c.env.DB.prepare(`SELECT 1 FROM ${m.table} WHERE id = ? AND org_id = ?${scope}`).bind(id, auth.orgId).first();
    if (!exists) throw notFound(m.label);
    const dup = await c.env.DB.prepare(`SELECT 1 FROM ${m.table} WHERE org_id = ? AND code = ? AND id <> ?`).bind(auth.orgId, input.code, id).first();
    if (dup) throw conflict(`${m.label} code "${input.code}" is already used`);
    const sets = ['code = ?', 'name = ?', 'active = ?', ...m.fields.map((f) => `${f.col} = ?`)];
    const vals = [input.code, input.name, input.active ? 1 : 0, ...m.fields.map((f) => input[f.key] ?? null)];
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE ${m.table} SET ${sets.join(', ')} WHERE id = ? AND org_id = ?${scope}`).bind(...vals, id, auth.orgId),
      auditStmt(c.env.DB, auth.orgId, m.table, id, 'update', String(input.code), auth.userId)
    ]);
    const row = await c.env.DB.prepare(`SELECT * FROM ${m.table} WHERE id = ?`).bind(id).first();
    return c.json(toJson(m.fields, row!));
  });
}
