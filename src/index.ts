import { Hono } from 'hono';
import type { AppEnv } from './types';
import { ApiError, fromDbError } from './lib/errors';
import { authRoutes } from './routes/auth';
import { orgRoutes } from './routes/org';
import { userRoutes } from './routes/users';
import { masterRoutes } from './routes/masters';
import { stockRoutes } from './routes/stock';
import { dispatchRoutes } from './routes/dispatches';

// One Worker: static files in public/ are served by Cloudflare directly; only
// /api/* reaches this code (see run_worker_first in wrangler.jsonc).
const app = new Hono<AppEnv>();

app.use('/api/*', async (c, next) => {
  if (!c.env.JWT_SECRET || c.env.JWT_SECRET.length < 32) {
    return c.json({ error: { code: 'not_configured', message: 'Server not configured: set the JWT_SECRET secret (see README → Hosting).' } }, 503);
  }
  await next();
  c.header('Cache-Control', 'no-store');
});

app.get('/api/v1/health', (c) => c.json({ name: 'estate-api', ok: true }));
app.route('/api/v1/auth', authRoutes);
app.route('/api/v1/org', orgRoutes);
app.route('/api/v1/users', userRoutes);
app.route('/api/v1', masterRoutes);
app.route('/api/v1', stockRoutes);
app.route('/api/v1', dispatchRoutes);

app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: { code: 'not_found', message: 'No such route' } }, 404) : c.env.ASSETS.fetch(c.req.raw)));

app.onError((err, c) => {
  const e = err instanceof ApiError ? err : fromDbError(err);
  if (e) return c.json({ error: { code: e.code, message: e.message, ...(e.field ? { field: e.field } : {}) } }, e.status);
  console.error(err);
  return c.json({ error: { code: 'internal_error', message: 'Something went wrong' } }, 500);
});

export default app;
