import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { hashPassword, verifyPassword } from '../lib/password';
import { signAccessToken } from '../lib/jwt';
import { requireAuth } from '../middleware/auth';
import { checkRateLimit, getClientIp } from '../lib/rateLimit';
import { ApiError } from '../lib/errors';
import { body } from '../lib/validate';
import { nowIso } from '../db';
import { auditStmt } from '../lib/audit';

export const authRoutes = new Hono<AppEnv>();

type UserRow = { id: string; org_id: string; login: string; full_name: string; role: string; password_hash: string; password_salt: string; disabled_at: string | null };

authRoutes.post('/password', async (c) => {
  const ip = checkRateLimit(getClientIp(c.req.raw), { windowSeconds: 60, maxRequests: 10, keyPrefix: 'auth_ip' });
  if (!ip.allowed) {
    c.header('Retry-After', String(ip.resetInSeconds));
    throw new ApiError(429, 'rate_limited', `Too many sign-in attempts. Please wait ${ip.resetInSeconds} seconds.`);
  }
  const input = await body(c, z.object({ login: z.string().trim().min(1).max(120), password: z.string().min(1).max(200) }));
  const login = input.login.toLowerCase();
  const acct = checkRateLimit(login, { windowSeconds: 60, maxRequests: 5, keyPrefix: 'auth_account' });
  if (!acct.allowed) {
    c.header('Retry-After', String(acct.resetInSeconds));
    throw new ApiError(429, 'rate_limited', `Too many sign-in attempts for this account. Please wait ${acct.resetInSeconds} seconds.`);
  }
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE login = ?').bind(login).first<UserRow>();
  const ok = user && !user.disabled_at && (await verifyPassword(input.password, user.password_hash, user.password_salt));
  if (!ok) throw new ApiError(401, 'invalid_credentials', 'Login or password is incorrect');
  await c.env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(nowIso(), user.id).run();
  const access = await signAccessToken(user.org_id, user.id, c.env.JWT_SECRET);
  return c.json({ access, user: { id: user.id, name: user.full_name, role: user.role, login: user.login, orgId: user.org_id } });
});

authRoutes.get('/me', requireAuth, async (c) => {
  const auth = c.get('auth');
  const godowns = await c.env.DB.prepare('SELECT location_id FROM user_godowns WHERE user_id = ?').bind(auth.userId).all<{ location_id: string }>();
  return c.json({ id: auth.userId, name: auth.name, role: auth.role, orgId: auth.orgId, godownIds: godowns.results.map((g) => g.location_id) });
});

authRoutes.post('/change-password', requireAuth, async (c) => {
  const auth = c.get('auth');
  const input = await body(c, z.object({ current: z.string().min(1), next: z.string().min(8, 'New password needs at least 8 characters').max(200) }));
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(auth.userId).first<UserRow>();
  if (!user || !(await verifyPassword(input.current, user.password_hash, user.password_salt))) {
    throw new ApiError(422, 'validation_error', 'Current password is incorrect', 'current');
  }
  const { hash, salt } = await hashPassword(input.next);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').bind(hash, salt, auth.userId),
    auditStmt(c.env.DB, auth.orgId, 'users', auth.userId, 'change_password', '', auth.userId)
  ]);
  return c.json({ ok: true });
});
