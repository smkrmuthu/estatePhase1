// Small shared helpers. Routes talk to D1 directly with prepared statements so each
// posting can be sent as one atomic batch; drizzle/schema.ts is the schema of record
// and generates the migrations.

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
