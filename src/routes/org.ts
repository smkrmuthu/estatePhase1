import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { requireAuth, requireRole } from '../middleware/auth';
import { body } from '../lib/validate';
import { auditStmt } from '../lib/audit';

export const orgRoutes = new Hono<AppEnv>();
orgRoutes.use('*', requireAuth);

const orgJson = (r: Record<string, unknown>) => ({
  id: r.id, name: r.name, address: r.address, timezone: r.timezone, labelWidthMm: r.label_width_mm, labelHeightMm: r.label_height_mm
});

orgRoutes.get('/', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM orgs WHERE id = ?').bind(c.get('auth').orgId).first();
  return c.json(orgJson(row!));
});

orgRoutes.patch('/', requireRole('admin'), async (c) => {
  const auth = c.get('auth');
  const input = await body(c, z.object({
    name: z.string().trim().min(1).max(80),
    address: z.string().trim().max(200),
    labelWidthMm: z.number().int().min(40).max(200),
    labelHeightMm: z.number().int().min(30).max(200)
  }));
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE orgs SET name = ?, address = ?, label_width_mm = ?, label_height_mm = ? WHERE id = ?')
      .bind(input.name, input.address, input.labelWidthMm, input.labelHeightMm, auth.orgId),
    auditStmt(c.env.DB, auth.orgId, 'orgs', auth.orgId, 'update', JSON.stringify(input), auth.userId)
  ]);
  const row = await c.env.DB.prepare('SELECT * FROM orgs WHERE id = ?').bind(auth.orgId).first();
  return c.json(orgJson(row!));
});
