// Runs this project's own Wrangler with the current Node, so scripts behave the same on
// Windows, macOS and Linux. (Spawning `npx` fails on Windows without a shell, and a shell
// would mangle the SQL and paths we pass as arguments.)
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const wranglerBin = join(dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');

/** Run wrangler and wait. Same options as execFileSync. */
export const wranglerSync = (args, options = {}) => execFileSync(process.execPath, [wranglerBin, ...args], options);

/** Start wrangler in the background (e.g. `wrangler dev`). Same options as spawn. */
export const wranglerSpawn = (args, options = {}) => spawn(process.execPath, [wranglerBin, ...args], options);

/** Stop a background wrangler and everything it started (workerd), on any OS. */
export function stopTree(child) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGTERM');
  } catch { /* already gone */ }
}
