import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { ROLES } from '../../drizzle/schema';
import { requireAuth, requireRole } from '../middleware/auth';
import { body } from '../lib/validate';
import { hashPassword } from '../lib/password';
import { auditStmt } from '../lib/audit';
import { conflict, invalid, notFound } from '../lib/errors';
import { newId, nowIso } from '../db';

export const userRoutes = new Hono<AppEnv>();
userRoutes.use('*', requireAuth, requireRole('admin'));

async function listUsers(db: D1Database, orgId: string) {
  const users = await db.prepare('SELECT id, login, full_name, role, disabled_at, last_seen_at, created_at FROM users WHERE org_id = ? ORDER BY full_name')
    .bind(orgId).all<Record<string, string | null>>();
  const links = await db.prepare('SELECT ug.user_id, ug.location_id FROM user_godowns ug JOIN users u ON u.id = ug.user_id WHERE u.org_id = ?')
    .bind(orgId).all<{ user_id: string; location_id: string }>();
  return users.results.map((u) => ({
    id: u.id, login: u.login, name: u.full_name, role: u.role, active: !u.disabled_at, lastSeenAt: u.last_seen_at, createdAt: u.created_at,
    godownIds: links.results.filter((l) => l.user_id === u.id).map((l) => l.location_id)
  }));
}

async function checkGodowns(db: D1Database, orgId: string, ids: string[]) {
  if (!ids.length) return;
  const found = await db.prepare(`SELECT COUNT(*) AS n FROM locations WHERE org_id = ? AND id IN (${ids.map(() => '?').join(',')})`)
    .bind(orgId, ...ids).first<{ n: number }>();
  if (found!.n !== new Set(ids).size) throw invalid('Unknown godown in assignment', 'godownIds');
}

userRoutes.get('/', async (c) => c.json({ users: await listUsers(c.env.DB, c.get('auth').orgId) }));

const loginField = z.string().trim().toLowerCase().min(3, 'Login needs at least 3 characters').max(120).regex(/^[a-z0-9@._+-]+$/, 'Use letters, digits and @ . _ + - only');

userRoutes.post('/', async (c) => {
  const auth = c.get('auth');
  const input = await body(c, z.object({
    login: loginField,
    name: z.string().trim().min(1).max(80),
    role: z.enum(ROLES),
    password: z.string().min(8, 'Password needs at least 8 characters').max(200),
    godownIds: z.array(z.string()).max(200).default([])
  }));
  const taken = await c.env.DB.prepare('SELECT 1 FROM users WHERE login = ?').bind(input.login).first();
  if (taken) throw conflict(`The login "${input.login}" is already used`);
  await checkGodowns(c.env.DB, auth.orgId, input.godownIds);
  const id = newId();
  const { hash, salt } = await hashPassword(input.password);
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO users (id, org_id, login, full_name, role, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, auth.orgId, input.login, input.name, input.role, hash, salt, nowIso()),
    ...input.godownIds.map((g) => c.env.DB.prepare('INSERT INTO user_godowns (user_id, location_id) VALUES (?, ?)').bind(id, g)),
    auditStmt(c.env.DB, auth.orgId, 'users', id, 'create', `${input.login} (${input.role})`, auth.userId)
  ]);
  return c.json({ users: await listUsers(c.env.DB, auth.orgId) }, 201);
});

userRoutes.patch('/:id', async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id')!;
  const input = await body(c, z.object({
    name: z.string().trim().min(1).max(80).optional(),
    role: z.enum(ROLES).optional(),
    active: z.boolean().optional(),
    password: z.string().min(8, 'Password needs at least 8 characters').max(200).optional(),
    godownIds: z.array(z.string()).max(200).optional()
  }));
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ? AND org_id = ?').bind(id, auth.orgId).first<Record<string, string>>();
  if (!user) throw notFound('User');
  if (id === auth.userId && (input.active === false || (input.role && input.role !== 'admin'))) {
    throw invalid('You cannot disable yourself or remove your own admin role');
  }
  if (input.godownIds) await checkGodowns(c.env.DB, auth.orgId, input.godownIds);
  const stmts: D1PreparedStatement[] = [];
  if (input.name !== undefined) stmts.push(c.env.DB.prepare('UPDATE users SET full_name = ? WHERE id = ?').bind(input.name, id));
  if (input.role !== undefined) stmts.push(c.env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(input.role, id));
  if (input.active !== undefined) stmts.push(c.env.DB.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').bind(input.active ? null : nowIso(), id));
  if (input.password) {
    const { hash, salt } = await hashPassword(input.password);
    stmts.push(c.env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').bind(hash, salt, id));
  }
  if (input.godownIds) {
    stmts.push(c.env.DB.prepare('DELETE FROM user_godowns WHERE user_id = ?').bind(id));
    for (const g of new Set(input.godownIds)) stmts.push(c.env.DB.prepare('INSERT INTO user_godowns (user_id, location_id) VALUES (?, ?)').bind(id, g));
  }
  if (!stmts.length) throw invalid('Nothing to update');
  const summary = Object.keys(input).filter((k) => k !== 'password').join(', ') + (input.password ? ' password reset' : '');
  stmts.push(auditStmt(c.env.DB, auth.orgId, 'users', id, 'update', summary, auth.userId));
  await c.env.DB.batch(stmts);
  return c.json({ users: await listUsers(c.env.DB, auth.orgId) });
});
