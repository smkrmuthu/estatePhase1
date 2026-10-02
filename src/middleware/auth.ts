import type { Context, Next } from 'hono';
import type { AppEnv, Role } from '../types';
import { verifyAccessToken } from '../lib/jwt';
import { ApiError } from '../lib/errors';

/**
 * Verifies the bearer token, then loads the user so a disabled account or a
 * changed role takes effect on the very next request. Every route reads
 * org_id / role from c.get('auth') — never from the request body. This is the
 * tenant isolation boundary; D1 has no row-level security behind it.
 */
export async function requireAuth(c: Context<AppEnv>, next: Next) {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new ApiError(401, 'unauthorized', 'Please sign in');
  let claims: { orgId: string; userId: string };
  try {
    claims = await verifyAccessToken(token, c.env.JWT_SECRET);
  } catch {
    throw new ApiError(401, 'unauthorized', 'Your session has expired. Please sign in again.');
  }
  const user = await c.env.DB.prepare('SELECT id, org_id, role, full_name, disabled_at FROM users WHERE id = ?')
    .bind(claims.userId)
    .first<{ id: string; org_id: string; role: Role; full_name: string; disabled_at: string | null }>();
  if (!user || user.disabled_at || user.org_id !== claims.orgId) throw new ApiError(401, 'unauthorized', 'Your account is not active. Please sign in again.');
  c.set('auth', { orgId: user.org_id, userId: user.id, role: user.role, name: user.full_name });
  await next();
}

export function requireRole(...roles: Role[]) {
  return async (c: Context<AppEnv>, next: Next) => {
    if (!roles.includes(c.get('auth').role)) throw new ApiError(403, 'forbidden', `This needs the ${roles.join(' or ')} role.`);
    await next();
  };
}

// Operators may only post in godowns assigned to them; admins and managers anywhere.
export async function assertGodownAccess(c: Context<AppEnv>, locationIds: string[]) {
  const auth = c.get('auth');
  if (auth.role === 'admin' || auth.role === 'manager') return;
  const rows = await c.env.DB.prepare('SELECT location_id FROM user_godowns WHERE user_id = ?').bind(auth.userId).all<{ location_id: string }>();
  const allowed = new Set(rows.results.map((r) => r.location_id));
  const blocked = [...new Set(locationIds)].filter((id) => !allowed.has(id));
  if (blocked.length) {
    const names = await c.env.DB.prepare(`SELECT name FROM locations WHERE id IN (${blocked.map(() => '?').join(',')})`).bind(...blocked).all<{ name: string }>();
    throw new ApiError(403, 'forbidden', `You are not assigned to ${names.results.map((n) => n.name).join(', ') || 'this godown'}.`);
  }
}
