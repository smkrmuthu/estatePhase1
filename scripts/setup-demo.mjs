#!/usr/bin/env node
// One-time setup of the demo / test site at estate-demo.oneuptech.co: its own Worker
// ("estate-demo") and database ("estate-demo-db"), so test data never touches the live
// site. Safe to run again: each step skips what is already done.
//
//   npm run demo:setup -- --login demo.admin
//
// Steps: create the database and save its ID in wrangler.jsonc, create the tables,
// deploy, set a sign-in secret, create the admin, then fill it with demo data
// (scripts/seed-demo.mjs). Needs `npx wrangler login` on this laptop.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';

const DB = 'estate-demo-db';
const SITE = 'https://estate-demo.oneuptech.co';
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const login = opt('login', 'demo.admin');
const env = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' };

const wrangler = (wArgs, input) =>
  execFileSync('npx', ['wrangler', ...wArgs], { encoding: 'utf8', env, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'] });
const step = (s) => console.log(`\n▸ ${s}`);

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a); }));
}

// 1. Database, and its ID in wrangler.jsonc (env.demo).
step(`Database ${DB}`);
const findId = () => {
  const out = wrangler(['d1', 'list', '--json']);
  return JSON.parse(out.slice(out.indexOf('['))).find((d) => d.name === DB)?.uuid;
};
let id = findId();
if (!id) {
  wrangler(['d1', 'create', DB]);
  id = findId();
}
if (!id) throw new Error(`Could not find the ID of ${DB}. Check \`npx wrangler d1 list\`.`);
const cfg = readFileSync('wrangler.jsonc', 'utf8');
if (!cfg.includes(id)) {
  const marker = `"database_name": "${DB}",`;
  if (!cfg.includes(marker)) throw new Error(`wrangler.jsonc has no ${marker} line under env.demo`);
  writeFileSync('wrangler.jsonc', cfg.replace(marker, `${marker}\n          "database_id": "${id}",`));
  console.log(`  saved database_id ${id} in wrangler.jsonc — commit this change`);
} else {
  console.log(`  ${id} (already in wrangler.jsonc)`);
}

// 2. Tables and stock rules.
step('Tables and stock rules');
wrangler(['d1', 'migrations', 'apply', DB, '--remote', '--env', 'demo']);

// 3. Deploy the Worker and app.
step(`Deploying to ${SITE}`);
wrangler(['deploy', '--env', 'demo']);

// 4. Sign-in secret (only the first time; the site answers 503 until it is set).
step('Sign-in secret');
const secrets = wrangler(['secret', 'list', '--env', 'demo', '--format', 'json']);
if (secrets.includes('"JWT_SECRET"')) {
  console.log('  already set');
} else {
  wrangler(['secret', 'put', 'JWT_SECRET', '--env', 'demo'], randomBytes(32).toString('hex'));
  console.log('  set (random, never shown)');
}

// 5. Administrator.
step(`Administrator "${login}"`);
const password = opt('password') || (await ask(`Password for ${login} on the demo site (8+ characters): `));
const existing = execFileSync('node', ['scripts/create-user.mjs', '--remote', '--env', 'demo', '--db', DB, '--list'], { encoding: 'utf8', env });
if (existing.includes(`  ${login}  `)) {
  console.log('  already exists — using it');
} else {
  execFileSync('node', ['scripts/create-user.mjs', '--remote', '--env', 'demo', '--db', DB,
    '--org', 'OneUpTech Estate (Demo)', '--login', login, '--name', 'Demo Admin', '--role', 'admin', '--password', password], { stdio: 'inherit', env });
}

// 6. Wait for the new address to answer, then add the demo data and run the checks.
step('Waiting for the site');
for (let i = 0; ; i++) {
  try { if ((await fetch(`${SITE}/api/v1/health`)).ok) break; } catch { /* DNS/certificate still coming up */ }
  if (i === 60) throw new Error(`${SITE} is not answering yet. Wait a few minutes, then: npm run seed:demo -- --url ${SITE} --login ${login}`);
  await new Promise((r) => setTimeout(r, 5000));
}
step('Demo data and checks');
try {
  execFileSync('node', ['scripts/seed-demo.mjs', '--url', SITE, '--login', login, '--password', password], { stdio: 'inherit', env });
} catch {
  // seed-demo prints its own reasons (e.g. demo data already there, or a failed check).
}
console.log(`\nDemo site: ${SITE}  (sign in as ${login})`);
