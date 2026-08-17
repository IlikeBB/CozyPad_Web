import { execFile, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const startupTimeoutMs = 20_000;
const checkOnly = process.argv.includes('--check');
const execFileAsync = promisify(execFile);

const services = [
  {
    name: 'api',
    port: 5174,
    command: process.execPath,
    args: ['scripts/legacy-v2-api-server.mjs'],
    healthUrl: 'http://127.0.0.1:5174/api/health',
  },
  {
    name: 'local-cmd',
    port: 5175,
    command: process.execPath,
    args: ['scripts/legacy-v2-local-cmd-bridge.mjs'],
    healthUrl: 'http://127.0.0.1:5175/api/local-cmd/health',
    healthHeaders: { Origin: 'http://localhost:5173' },
  },
  {
    name: 'web',
    port: 5173,
    command: process.execPath,
    args: ['node_modules/vite/bin/vite.js'],
    cwd: path.join(root, 'apps', 'app'),
    healthUrl: 'http://127.0.0.1:5173/',
  },
];

const children = new Map();
let closing = false;

function log(message) {
  process.stdout.write(`[suite] ${message}\n`);
}

function portIsListening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(350);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    const unavailable = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once('timeout', unavailable);
    socket.once('error', unavailable);
  });
}

async function serviceIsHealthy(service) {
  try {
    const response = await fetch(service.healthUrl, {
      headers: service.healthHeaders,
      signal: AbortSignal.timeout(900),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function reportHealth() {
  const health = await Promise.all(services.map(async (service) => ({
    service,
    healthy: await serviceIsHealthy(service),
  })));
  for (const result of health) {
    log(`${result.service.name.padEnd(9)} ${result.healthy ? 'READY' : 'DOWN'}  :${result.service.port}`);
  }
  const allHealthy = health.every((result) => result.healthy);
  log(allHealthy ? 'ALL SERVICES READY' : 'SUITE NOT READY');
  return allHealthy;
}

function pipeOutput(stream, name, target) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) target.write(`[${name}] ${line}\n`);
  });
  stream.on('end', () => {
    if (pending) target.write(`[${name}] ${pending}\n`);
  });
}

function stopProcessTree(child) {
  if (!child.pid) return Promise.resolve();
  if (!isWindows) {
    child.kill('SIGTERM');
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      cwd: root,
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('exit', resolve);
    killer.once('error', resolve);
  });
}

async function stopManagedPortListeners() {
  if (!isWindows) return;
  const managedPorts = new Set(services.map((service) => service.port));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let stdout = '';
    try {
      ({ stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], {
        cwd: root,
        windowsHide: true,
      }));
    } catch {
      return;
    }
    const listenerPids = new Set();
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (!match || !managedPorts.has(Number(match[1]))) continue;
      listenerPids.add(Number(match[2]));
    }
    if (!listenerPids.size) return;
    await Promise.all([...listenerPids].map((pid) => new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        cwd: root,
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('exit', resolve);
      killer.once('error', resolve);
    })));
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function shutdown(exitCode, reason) {
  if (closing) return;
  closing = true;
  log(`STOPPING ALL SERVICES${reason ? ` · ${reason}` : ''}`);
  await Promise.all([...children.values()].map(stopProcessTree));
  await stopManagedPortListeners();
  log('ALL SERVICES STOPPED');
  process.exit(exitCode);
}

function startService(service) {
  const child = spawn(service.command, service.args, {
    cwd: service.cwd || root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.set(service.name, child);
  pipeOutput(child.stdout, service.name, process.stdout);
  pipeOutput(child.stderr, service.name, process.stderr);
  child.once('error', (error) => {
    void shutdown(1, `${service.name} failed to start: ${error.message}`);
  });
  child.once('exit', (code, signal) => {
    if (closing) return;
    void shutdown(1, `${service.name} exited (${signal || (code ?? 'unknown')})`);
  });
}

async function waitUntilReady() {
  const deadline = Date.now() + startupTimeoutMs;
  while (!closing && Date.now() < deadline) {
    const results = await Promise.all(services.map(serviceIsHealthy));
    if (results.every(Boolean)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

if (checkOnly) {
  process.exit(await reportHealth() ? 0 : 1);
}

const occupied = [];
for (const service of services) {
  if (await portIsListening(service.port)) occupied.push(`${service.name}:${service.port}`);
}
if (occupied.length) {
  log(`START ABORTED · occupied ports: ${occupied.join(', ')}`);
  log('No service was started. Stop the existing suite before retrying.');
  process.exit(1);
}

process.once('SIGINT', () => void shutdown(0, 'SIGINT'));
process.once('SIGTERM', () => void shutdown(0, 'SIGTERM'));

for (const service of services) startService(service);
if (await waitUntilReady()) {
  log('ALL SERVICES READY · web:5173 api:5174 local-cmd:5175');
} else {
  await shutdown(1, 'startup health check timed out');
}
