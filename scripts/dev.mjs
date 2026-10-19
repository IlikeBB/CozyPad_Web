import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
try { process.loadEnvFile?.(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
async function freePort(preferred) {
  for (let port = preferred; port < preferred + 100; port++) {
    const available = await new Promise(resolve => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error('No available port for CozyPad TT');
}
const webPort = await freePort(Number(process.env.COZYPAD_WEB_PORT || 5673));
const apiPort = await freePort(Math.max(Number(process.env.COZYPAD_API_PORT || 5674), webPort + 1));
const env = { ...process.env, COZYPAD_WEB_PORT: String(webPort), COZYPAD_API_PORT: String(apiPort) };
const children = [
  spawn(process.execPath, ['--watch', 'apps/server/src/index.mjs'], { cwd: root, env, stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { cwd: path.join(root, 'apps/app'), env, stdio: 'inherit' })
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
for (const child of children) {
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code || 0); });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
console.log(`CozyPad TT: http://127.0.0.1:${webPort} | API: ${apiPort}`);
