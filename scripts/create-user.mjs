#!/usr/bin/env node
// Manages users directly in D1 from the command line — for the first admin, and for
// getting back in when the admin password is forgotten. After that, admins manage
// users in the app (Users).
//
//   Create (and the organisation, the first time):
//     npm run user:create:remote -- --org "OneUpTech Estate" --login admin@example.com --name "Estate Admin" --role admin
//   List who can sign in:
//     npm run user:list:remote
//   Forgot password — set a new one (also re-enables the account):
//     npm run user:reset:remote -- --login admin@example.com
//
// Passwords are prompted for when --password is not given, and are hashed here
// (PBKDF2, same as the Worker) — they never go to Cloudflare in plain text.
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
const mode = flag('list') ? 'list' : flag('reset') ? 'reset' : 'create';
const login = (opt('login') || '').trim().toLowerCase();
const name = (opt('name') || '').trim();
const role = opt('role', 'admin');
const orgName = opt('org', 'OneUpTech Estate');
const persist = opt('persist-to');
// The demo site (wrangler env "demo") has its own database: --env demo --db estate-demo-db.
const envName = opt('env');
const dbName = opt('db', 'estate-db');

const wranglerArgs = (extra) => ['wrangler', 'd1', 'execute', dbName, target, ...extra, ...(persist ? ['--persist-to', persist] : []), ...(envName ? ['--env', envName] : [])];
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

function query(sql) {
  const out = execFileSync('npx', wranglerArgs(['--command', sql, '--json']), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

function runFile(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'estate-user-'));
  const file = join(dir, 'user.sql');
  writeFileSync(file, sql);
  try {
    execFileSync('npx', wranglerArgs([`--file=${file}`, '--yes']), { stdio: 'inherit' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function listUsers() {
  const rows = query('SELECT login, full_name, role, disabled_at FROM users ORDER BY role, full_name');
  if (!rows.length) return console.log('No users yet. Create one with user:create.');
  console.log('\nUsers who can sign in (login → name, role):');
  for (const r of rows) console.log(`  ${r.login}  →  ${r.full_name}, ${r.role}${r.disabled_at ? ' (DISABLED)' : ''}`);
  console.log('');
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a); }));
}

async function newPassword() {
  const password = opt('password') || (await ask('New password (at least 8 characters): '));
  if (password.length < 8) {
    console.error('Password needs at least 8 characters');
    process.exit(1);
  }
  const toHex = (buf) => Buffer.from(buf).toString('hex');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' }, key, 256);
  return { hash: toHex(hash), salt: toHex(salt) };
}

if (mode === 'list') {
  listUsers();
  process.exit(0);
}

if (mode === 'reset') {
  if (!login) {
    console.error('Usage: --reset --login <login>   (run with --list to see the logins)');
    process.exit(1);
  }
  if (!query(`SELECT 1 FROM users WHERE login = ${q(login)}`).length) {
    console.error(`No user with login "${login}".`);
    listUsers();
    process.exit(1);
  }
  const { hash, salt } = await newPassword();
  runFile(`UPDATE users SET password_hash = ${q(hash)}, password_salt = ${q(salt)}, disabled_at = NULL WHERE login = ${q(login)};`);
  console.log(`\nPassword reset for "${login}" (${target.slice(2)}). Sign in with the new password.`);
  process.exit(0);
}

if (!login || !name) {
  console.error('Usage: create-user.mjs --local|--remote --login <login> --name "<full name>" [--role admin|manager|operator|viewer] [--org "<organisation>"] [--password <pw>]');
  process.exit(1);
}
if (!['admin', 'manager', 'operator', 'viewer'].includes(role)) {
  console.error('Role must be admin, manager, operator or viewer');
  process.exit(1);
}

const { hash, salt } = await newPassword();
const now = new Date().toISOString();

// One organisation per deployment for now: reuse it if it exists, else create it.
try {
  runFile(`
INSERT INTO orgs (id, name, created_at) SELECT ${q(randomUUID())}, ${q(orgName)}, ${q(now)} WHERE NOT EXISTS (SELECT 1 FROM orgs);
INSERT INTO users (id, org_id, login, full_name, role, password_hash, password_salt, created_at)
  SELECT ${q(randomUUID())}, (SELECT id FROM orgs ORDER BY created_at LIMIT 1), ${q(login)}, ${q(name)}, ${q(role)}, ${q(hash)}, ${q(salt)}, ${q(now)};
`);
  console.log(`\nCreated ${role} "${login}" (${target.slice(2)}).`);
} catch {
  console.error('\nFailed. If the login already exists, use --reset to set a new password (see --list).');
  process.exitCode = 1;
}
