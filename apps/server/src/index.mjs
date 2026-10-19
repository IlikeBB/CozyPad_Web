import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';
import { JsonStore } from './storage/json-store.mjs';
import { KeyVault } from './storage/key-vault.mjs';
import { AuthService } from './auth/auth-service.mjs';
import { IssueService } from './issues/issue-service.mjs';
import { ProfileRepository } from './ssh/profile-repository.mjs';
import { SshService } from './ssh/ssh-service.mjs';
import { FilesService } from './ssh/files-service.mjs';
import { FileSearchService } from './ssh/file-search-service.mjs';
import { FoldersService } from './ssh/folders-service.mjs';
import { AgentService } from './ssh/agent-service.mjs';
import { AgentFileDownloads } from './ssh/agent-file-downloads.mjs';
import { CodexModels } from './ssh/codex-models.mjs';
import { RemoteDirectories } from './ssh/remote-directories.mjs';
import { terminalSockets } from './ssh/terminal-sockets.mjs';
import { json, body, validateOrigin, failure } from './http.mjs';
import { attachmentLimits } from '../../../packages/contracts/src/attachments.mjs';

const store = new JsonStore(config.dataDir);
const vault = new KeyVault(config.dataDir);
await vault.initialize();
const auth = new AuthService(store, config);
await auth.bootstrap();
const issues = new IssueService(store);
const profiles = new ProfileRepository(store, vault);
const ssh = new SshService(profiles, vault);
const files = new FilesService(ssh);
const fileSearch = new FileSearchService(files);
const folders = new FoldersService(files);
const agents = new AgentService(store, profiles, ssh);
const directories = new RemoteDirectories(files, agents.directories, profiles);
const agentFiles = new AgentFileDownloads(agents, files);
const models = new CodexModels(profiles, ssh);

async function staticFile(request, response, pathname) {
  const target = path.resolve(config.distDir, `.${decodeURIComponent(pathname)}`);
  if (target !== config.distDir && !target.startsWith(`${config.distDir}${path.sep}`)) { json(response, 404, { error: 'Not found' }); return; }
  let file = target;
  try { if (!(await stat(file)).isFile()) file = path.join(config.distDir, 'index.html'); }
  catch { file = path.join(config.distDir, 'index.html'); }
  try {
    const content = await readFile(file);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
    response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
      'cache-control': path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600' });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch { json(response, 503, { error: '前端尚未建置。開發時請使用 pnpm dev；正式啟動前請執行 pnpm build。' }); }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const route = url.pathname;
    if (!route.startsWith('/api/')) {
      if (!['GET', 'HEAD'].includes(request.method)) { json(response, 405, { error: 'Method not allowed' }); return; }
      await staticFile(request, response, route); return;
    }
    validateOrigin(request);
    if (route === '/api/health' && request.method === 'GET') { json(response, 200, { ok: true, name: 'CozyPad TT', version: '4.0.0', features: { scopedSearch: true, clientDirectoryContext: true, directoryHistory: true, localConnector: false, installationRequired: false, cooperation: true, issueReports: true } }); return; }
    if (route === '/api/auth/session' && request.method === 'GET') { json(response, 200, await auth.session(request)); return; }
    if (route === '/api/auth/login' && request.method === 'POST') { const result = await auth.login(request, await body(request)); json(response, 200, result.body, result.cookies); return; }
    if (route === '/api/auth/verify' && request.method === 'POST') { const result = await auth.verify(request, await body(request)); json(response, 200, result.body, result.cookies); return; }
    const session = await auth.require(request);
    const owner = session.user.username;
    if (route.startsWith('/api/local/')) { json(response, 410, { error: '已改為純網頁模式，不再需要本機連接器、下載或配對。' }); return; }
    if (route === '/api/auth/logout' && request.method === 'POST') {
      const payload = await body(request); const responseCookies = await auth.logout(request, payload.forget === true);
      ssh.disconnectUser(owner); json(response, 200, { ok: true }, responseCookies); return;
    }
    if (route === '/api/auth/forget' && request.method === 'POST') { json(response, 200, { ok: true }, await auth.forget(request)); return; }
    if (route === '/api/issues' && request.method === 'GET') { json(response, 200, await issues.list(session.user, Object.fromEntries(url.searchParams))); return; }
    if (route === '/api/issues' && request.method === 'POST') { json(response, 201, await issues.create(session.user, await body(request, 65536))); return; }
    const issueRoute = /^\/api\/issues\/([^/]+)$/.exec(route);
    if (issueRoute && request.method === 'GET') { json(response, 200, await issues.find(session.user, decodeURIComponent(issueRoute[1]))); return; }
    if (issueRoute && request.method === 'PUT') { json(response, 200, await issues.update(session.user, decodeURIComponent(issueRoute[1]), await body(request, 16384))); return; }
    if (route === '/api/servers' && request.method === 'GET') { json(response, 200, await profiles.list(owner)); return; }
    if (route === '/api/servers' && request.method === 'POST') { json(response, 201, await profiles.save(owner, await body(request))); return; }
    if (route === '/api/servers/import' && request.method === 'POST') { json(response, 200, await profiles.importConfig(owner, await body(request))); return; }
    const match = /^\/api\/servers\/([^/]+)(?:\/(connect|disconnect|trust))?$/.exec(route);
    if (match) {
      const id = decodeURIComponent(match[1]), action = match[2];
      if (request.method === 'PUT' && !action) { const profile = await profiles.save(owner, { ...await body(request), id }); ssh.disconnect(owner, id); json(response, 200, profile); return; }
      if (request.method === 'DELETE' && !action) { await profiles.delete(owner, id); ssh.disconnect(owner, id); json(response, 200, { ok: true }); return; }
      if (request.method === 'POST' && action === 'connect') { await ssh.connect(owner, id); json(response, 200, { ok: true }); return; }
      if (request.method === 'POST' && action === 'disconnect') { await profiles.find(owner, id); ssh.disconnect(owner, id); json(response, 200, { ok: true }); return; }
      if (request.method === 'POST' && action === 'trust') { await ssh.trust(owner, id, (await body(request)).fingerprint); json(response, 200, { ok: true }); return; }
    }
    const id = url.searchParams.get('serverId');
    if (route === '/api/agents/models' && request.method === 'GET') { json(response, 200, await models.list(owner, id)); return; }
    if (route === '/api/agents/directories' && request.method === 'GET') { json(response, 200, await directories.list(owner, id)); return; }
    if (route === '/api/agents/directories' && request.method === 'POST') { const payload = await body(request, 16384); json(response, 200, await directories.select(owner, payload.serverId, payload.path)); return; }
    if (route === '/api/files' && request.method === 'GET') { json(response, 200, await files.list(owner, id, url.searchParams.get('path') || '~')); return; }
    if (route === '/api/files/search' && request.method === 'POST') {
      const payload = await body(request, 8192), controller = new AbortController();
      const cancel = () => { if (!response.writableEnded) controller.abort(); };
      response.once('close', cancel);
      try { json(response, 200, await fileSearch.search(owner, payload.serverId, payload, controller.signal)); }
      finally { response.removeListener('close', cancel); }
      return;
    }
    if (route === '/api/files/folders' && ['POST', 'PUT', 'DELETE'].includes(request.method)) {
      const payload = await body(request, 16384);
      const result = request.method === 'POST' ? await folders.create(owner, payload.serverId, payload.parent, payload.name)
        : request.method === 'PUT' ? await folders.rename(owner, payload.serverId, payload.parent, payload.name, payload.newName)
        : await folders.delete(owner, payload.serverId, payload.parent, payload.name, payload.recursive ?? false, payload.confirmation);
      json(response, request.method === 'POST' ? 201 : 200, result); return;
    }
    if (route === '/api/files/content' && request.method === 'GET') {
      const result = await files.read(owner, id, url.searchParams.get('path'));
      if (result.data.includes(0)) throw Object.assign(new Error('此檔案為二進位檔，請使用下載。'), { status: 415 });
      json(response, 200, { path: result.path, content: result.data.toString('utf8'), revision: (await import('node:crypto')).createHash('sha256').update(result.data).digest('hex') }); return;
    }
    if (route === '/api/files/content' && request.method === 'PUT') {
      const payload = await body(request);
      const previous = await files.read(owner, payload.serverId, payload.path);
      const revision = (await import('node:crypto')).createHash('sha256').update(previous.data).digest('hex');
      if (revision !== payload.revision) throw Object.assign(new Error('檔案已由其他工作更新，請重新讀取後再儲存。'), { status: 409 });
      await files.write(owner, payload.serverId, payload.path, String(payload.content)); json(response, 200, { ok: true }); return;
    }
    if (route === '/api/files/upload' && request.method === 'POST') {
      const payload = await body(request);
      await files.write(owner, payload.serverId, payload.path, Buffer.from(String(payload.content), 'base64')); json(response, 200, { ok: true }); return;
    }
    if (route === '/api/files/download' && request.method === 'GET') {
      const result = await files.read(owner, id, url.searchParams.get('path'), 10485760);
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.posix.basename(result.path))}`, 'cache-control': 'no-store' });
      response.end(result.data); return;
    }
    if (route === '/api/monitor' && request.method === 'GET') {
      const result = await ssh.exec(owner, id, "printf '=== Host ===\\n'; hostname; uname -sr; printf '\\n=== Uptime ===\\n'; uptime; printf '\\n=== Memory ===\\n'; free -m; printf '\\n=== Disk ===\\n'; df -h /; printf '\\n=== GPU ===\\n'; if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader; else printf 'No NVIDIA GPU\\n'; fi");
      json(response, 200, result); return;
    }
    if (route === '/api/tasks' && request.method === 'GET') { json(response, 200, await agents.list(owner)); return; }
    if (route === '/api/tasks' && request.method === 'POST') { json(response, 202, await agents.start(owner, await body(request, Math.ceil(attachmentLimits.bytes / 3) * 4 + 262144))); return; }
    const taskDownload = /^\/api\/tasks\/([^/]+)\/files\/download$/.exec(route);
    if (taskDownload && request.method === 'GET') {
      const result = await agentFiles.read(owner, decodeURIComponent(taskDownload[1]), url.searchParams.get('path'), url.searchParams.get('cwd'));
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': result.data.length, 'x-content-type-options': 'nosniff',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.posix.basename(result.path))}`, 'cache-control': 'no-store' });
      response.end(result.data); return;
    }
    const attachmentRoute = /^\/api\/tasks\/([^/]+)\/attachments\/([^/]+)$/.exec(route);
    if (attachmentRoute && request.method === 'GET') {
      const task = await agents.find(owner, decodeURIComponent(attachmentRoute[1]));
      const { file, data } = await agents.attachments.read(owner, task, decodeURIComponent(attachmentRoute[2]));
      response.writeHead(200, { 'content-type': file.mimeType, 'content-length': data.length, 'x-content-type-options': 'nosniff',
        'content-disposition': `${file.kind === 'image' && !url.searchParams.has('download') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; sandbox" });
      response.end(data); return;
    }
    const taskRoute = /^\/api\/tasks\/([^/]+)(?:\/(events|cancel|approval|answer|steer))?$/.exec(route);
    if (taskRoute && taskRoute[2] === 'steer' && request.method === 'POST') { json(response, 200, await agents.steer(owner, decodeURIComponent(taskRoute[1]), await body(request, 300000))); return; }
    if (taskRoute && !taskRoute[2] && request.method === 'DELETE') { await agents.delete(owner, decodeURIComponent(taskRoute[1])); json(response, 200, { ok: true }); return; }
    if (taskRoute && taskRoute[2] === 'cancel' && request.method === 'POST') { await agents.cancel(owner, taskRoute[1]); json(response, 200, { ok: true }); return; }
    if (taskRoute && taskRoute[2] === 'approval' && request.method === 'POST') { await agents.approve(owner, taskRoute[1], await body(request)); json(response, 200, { ok: true }); return; }
    if (taskRoute && taskRoute[2] === 'answer' && request.method === 'POST') { await agents.answer(owner, taskRoute[1], await body(request)); json(response, 200, { ok: true }); return; }
    if (taskRoute && taskRoute[2] === 'events' && request.method === 'GET') {
      const task = await agents.find(owner, taskRoute[1]);
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      const send = event => { if (!response.writableEnded) response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`); };
      const after = Number(request.headers['last-event-id'] || url.searchParams.get('after') || 0);
      for (const event of [...task.events].sort((a, b) => a.id - b.id)) if (event.id > after) send(event);
      if (task.status !== 'running') { response.end(); return; }
      agents.events.on(task.id, send);
      const timer = setInterval(async () => {
        try { await auth.require(request); response.write(': heartbeat\n\n'); } catch { response.end(); }
      }, 15000);
      response.on('close', () => { clearInterval(timer); agents.events.off(task.id, send); });
      return;
    }
    json(response, 404, { error: '找不到此 API。' });
  } catch (error) { failure(response, error); }
});
const sockets = terminalSockets(server, auth, ssh, profiles);
// Large JSON attachments expand by one third in Base64; retain a shorter header deadline.
server.requestTimeout = 120000;
server.headersTimeout = 30000;
server.listen(config.port, config.host, () => console.log(`CozyPad TT API: http://${config.host}:${config.port}`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
function stop() { agents.close(); sockets.disposeTerminals(); ssh.close(); for (const socket of sockets.clients) socket.close(); server.close(); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
