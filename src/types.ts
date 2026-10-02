import type { Role } from '../drizzle/schema';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  JWT_SECRET: string;
}

export type { Role };

// What every authenticated request carries. Set by the auth middleware from the
// verified JWT *and* the current user row (so disabling a user or changing their
// role takes effect immediately) — never from the request body.
export interface AuthContext {
  orgId: string;
  userId: string;
  role: Role;
  name: string;
}

export type Vars = { auth: AuthContext };

export type AppEnv = { Bindings: Env; Variables: Vars };
