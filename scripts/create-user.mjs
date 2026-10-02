#!/usr/bin/env node
// Creates a user (and the organisation, the first time) directly in D1.
// Use it once to create the first admin; after that, admins add users in the app.
//
//   npm run user:create:remote -- --org "OneUpTech Estate" --login admin@example.com --name "Estate Admin" --role admin
//   npm run user:create:local  -- --login admin --name Admin --password localpass123
//
// The password is prompted for when --password is not given, and is hashed here
// (PBKDF2, same as the Worker) — it never goes to Cloudflare in plain text.
import { execFileSync } from 'node:child_process';
import { webcrypto as crypto, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const target = flag('remote') ? '--remote' : '--local';
const login = (opt('login') || '').trim().toLowerCase();
const name = (opt('name') || '').trim();
const role = opt('role', 'admin');
const orgName = opt('org', 'OneUpTech Estate');
const persist = opt('persist-to');

if (!login || !name) {
  console.error('Usage: create-user.mjs --local|--remote --login <login> --name "<full name>" [--role admin|manager|operator|viewer] [--org "<organisation>"] [--password <pw>]');
  process.exit(1);
}
if (!['admin', 'manager', 'operator', 'viewer'].includes(role)) {
  console.error('Role must be admin, manager, operator or viewer');
  process.exit(1);
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a); }));
}

const password = opt('password') || (await ask('Password (at least 8 characters): '));
if (password.length < 8) {
  console.error('Password needs at least 8 characters');
  process.exit(1);
}

const toHex = (buf) => Buffer.from(buf).toString('hex');
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
const hash = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' }, key, 256);

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const now = new Date().toISOString();
const orgId = randomUUID();
const userId = randomUUID();

// One organisation per deployment for now: reuse it if it exists, else create it.
const sql = `
INSERT INTO orgs (id, name, created_at) SELECT ${q(orgId)}, ${q(orgName)}, ${q(now)} WHERE NOT EXISTS (SELECT 1 FROM orgs);
INSERT INTO users (id, org_id, login, full_name, role, password_hash, password_salt, created_at)
  SELECT ${q(userId)}, (SELECT id FROM orgs ORDER BY created_at LIMIT 1), ${q(login)}, ${q(name)}, ${q(role)}, ${q(toHex(hash))}, ${q(toHex(salt))}, ${q(now)};
`;

const dir = mkdtempSync(join(tmpdir(), 'estate-user-'));
const file = join(dir, 'user.sql');
writeFileSync(file, sql);
try {
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'estate-db', target, `--file=${file}`, '--yes', ...(persist ? ['--persist-to', persist] : [])], { stdio: 'inherit' });
  console.log(`\nCreated ${role} "${login}" (${target.slice(2)}).`);
} catch {
  console.error('\nFailed. If the login already exists, pick another or reset its password in the app (Users).');
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
