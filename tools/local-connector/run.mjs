import { parseArgs } from 'node:util';
import { mkdir, open, unlink, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import os from 'node:os';
import path from 'node:path';
import { ConnectorFilesystem } from './filesystem.mjs';
import { ConnectorCodex } from './codex-processes.mjs';
import { readCredentials, saveCredentials } from './credentials.mjs';
import { chooseProject, pairingCode } from './setup.mjs';
import { connectorFiles, connectorProtocol, connectorRelease } from '../../packages/contracts/src/connector-protocol.mjs';

const { values } = parseArgs({ options: { url: { type: 'string', default: 'https://cozypadtt.modoubletw.com' }, root: { type: 'string', multiple: true }, pair: { type: 'boolean', default: false }, 'pair-file': { type: 'string' }, 'allow-full-access': { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
if (values.help) { console.log('node tools/local-connector/run.mjs --url https://cozypadtt.modoubletw.com --root "your project directory"\nNode.js 22+ and a signed-in Codex CLI are required. Full access is disabled unless --allow-full-access is explicitly supplied.'); process.exit(0); }
if (typeof WebSocket !== 'function') throw new Error('Node.js 22 or newer is required.');
const packageRoot = fileURLToPath(new URL('../../', import.meta.url)), hashes = {};
for (const file of connectorFiles) hashes[file] = crypto.createHash('sha256').update(await readFile(path.join(packageRoot, file))).digest('hex');
const identity = { protocol: connectorProtocol, release: connectorRelease, payloadHash: crypto.createHash('sha256').update(JSON.stringify(hashes)).digest('hex') };
const origin = new URL(values.url);
if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname)))) throw new Error('Use an HTTPS CozyPad origin, or a loopback development origin.');
const key = Buffer.from(origin.origin).toString('base64url'), state = path.join(os.homedir(), '.cozypad-local-connector');
await mkdir(state, { recursive: true, mode: 0o700 });
const lockPath = path.join(state, `${key}.lock`);
const previousCredentials = await readCredentials(path.join(state, `${key}.auth`));
let credentials = values.pair || values['pair-file'] ? null : previousCredentials;
let consoleInput;
const ask = question => { consoleInput ||= createInterface({ input: process.stdin, output: process.stdout }); return consoleInput.question(question); };
const knownRoots = values.root || credentials?.roots;
const selected = knownRoots ? { filesystem: await ConnectorFilesystem.create(knownRoots) } : await chooseProject(ask, console.log);
const filesystem = selected.filesystem;
let code;
if (values['pair-file']) {
  const pairFile = path.resolve(values['pair-file']);
  if (path.dirname(pairFile) !== state || !/^setup-[a-f0-9]{32}\.auth$/.test(path.basename(pairFile))) throw new Error('Invalid protected pairing file');
  code = (await readCredentials(pairFile))?.code;
  await unlink(pairFile);
  if (!pairingCode(code)) throw new Error('Installation pairing is missing or invalid. Download a new installer.');
} else if (!credentials) {
  code = selected.pastedCode;
  while (!pairingCode(code)) { code = (await ask('步驟 2：請貼上 CozyPad 的一次性配對碼：')).trim(); if (!pairingCode(code)) console.log('配對碼格式不正確，請從連線管理重新複製。'); }
}
consoleInput?.close();
let socket, stopping = false, retry = 1000;
const send = payload => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload)); };
const codex = new ConnectorCodex(filesystem, send, { allowFullAccess: values['allow-full-access'] });
async function acquireLock() {
  try { return await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readFile(lockPath, 'utf8'), pid = /^\d+$/.test(existing) ? Number(existing) : 0;
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Unrecognized connector lock; inspect it before starting.');
    try { process.kill(pid, 0); } catch (probe) {
      if (probe.code === 'ESRCH' && await readFile(lockPath, 'utf8') === existing) { await unlink(lockPath); return open(lockPath, 'wx', 0o600); }
    }
    throw new Error('A connector is already running. No duplicate connection was started.');
  }
}
const lock = await acquireLock();
await lock.writeFile(String(process.pid), 'utf8');
const websocketUrl = new URL('/api/local/bridge', origin); websocketUrl.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
async function connect() {
  socket = new WebSocket(websocketUrl);
  let ready = false;
  socket.addEventListener('open', () => send({ type: 'hello', ...identity, ...(credentials ? { owner: credentials.owner, deviceId: credentials.deviceId, token: credentials.token } : { code, ...(previousCredentials ? { previous: { owner: previousCredentials.owner, deviceId: previousCredentials.deviceId, token: previousCredentials.token } } : {}) }), metadata: { name: os.hostname(), platform: process.platform, roots: filesystem.roots.map(root => filesystem.virtual(root)) } }));
  socket.addEventListener('message', async event => {
    let request;
    try {
      request = JSON.parse(String(event.data));
      if (request.type === 'ready') {
        ready = true;
        if (request.token || !credentials?.roots) { credentials = { owner: request.owner, deviceId: request.deviceId, token: request.token || credentials.token, roots: filesystem.roots }; await saveCredentials(path.join(state, `${key}.auth`), credentials); }
        retry = 1000; console.log('CozyPad local connector is ready. Codex authentication remains on this computer.'); return;
      }
      if (!['request', 'notify'].includes(request.type)) throw new Error('Invalid connector command');
      let value;
      if (request.method === 'codex.open') value = await codex.open(request.params);
      else if (request.method === 'codex.write') value = await codex.write(request.params);
      else if (request.method === 'codex.close') value = codex.stop(request.params.channel);
      else if (request.method.startsWith('fs.') && request.type === 'request') value = await filesystem.call(request.method.slice(3), request.params);
      else throw new Error('Unsupported connector command');
      if (request.type === 'request') send({ type: 'response', id: request.id, value });
    } catch (error) {
      if (request?.type === 'request') send({ type: 'response', id: request.id, error: { message: error.message, code: error.code, status: error.status } });
      else if (request?.params?.channel) { codex.stop(request.params.channel); send({ type: 'event', channel: request.params.channel, event: 'exit', error: error.message }); }
      else socket.close();
    }
  });
  socket.addEventListener('error', () => console.error('CozyPad connection failed.'));
  socket.addEventListener('close', async event => {
    await codex.close(); await filesystem.close();
    if (stopping) return;
    if (event.code === 4403) { console.error('Pairing or scope was rejected. Remove the saved pairing and pair this computer again.'); await stop(); return; }
    if (!ready && !credentials) { console.error('Pairing outcome is unknown. Generate a new code and restart with --pair; no task was resubmitted.'); await stop(); return; }
    console.log('Connection interrupted; running work was stopped and will not be resubmitted.');
    setTimeout(() => { if (!stopping) void connect(); }, retry); retry = Math.min(retry * 2, 30000);
  });
}
async function stop() { if (stopping) return; stopping = true; socket?.close(); await codex.close(); await filesystem.close(); await lock.close(); await unlink(lockPath).catch(() => {}); }
process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); });
await connect();
