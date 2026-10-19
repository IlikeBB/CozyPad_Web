import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { ProtocolLines } from '../../packages/contracts/src/codex-protocol-lines.mjs';

export function codexExecutable() {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    const binary = path.join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (existsSync(binary)) return { executable: binary, prefix: [] };
    const javascript = path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(javascript)) return { executable: process.execPath, prefix: [javascript] };
  }
  throw new Error('Codex CLI is not installed. Install it and run codex login on this computer first.');
}
export class ConnectorCodex {
  processes = new Map();
  constructor(filesystem, emit, { executable = codexExecutable(), allowFullAccess = false } = {}) {
    Object.assign(this, { filesystem, emit, executable, allowFullAccess });
    const version = spawnSync(executable.executable, [...executable.prefix, '--version'], { timeout: 10000, encoding: 'utf8', windowsHide: true, maxBuffer: 4096 });
    if (version.status !== 0 || !/^codex-cli \d+\.\d+\.\d+/.test(version.stdout?.trim() || '')) throw new Error('Cannot read the local Codex CLI version.');
    this.version = version.stdout.trim();
  }
  async open({ channel, directory, purpose }) {
    if (typeof channel !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(channel) || this.processes.has(channel) || this.processes.size >= 5 || !['chat', 'model', 'cleanup'].includes(purpose)) throw new Error('Invalid or excessive local Codex channels');
    const scope = { pending: '', requestIds: new Set(), stopped: false, writes: Promise.resolve() }; this.processes.set(channel, scope);
    try {
      const cwd = await this.filesystem.location(directory === '~' ? '.' : directory);
      if (scope.stopped) throw new Error('Local Codex launch cancelled');
      const child = scope.child = spawn(this.executable.executable, [...this.executable.prefix, 'app-server'], { cwd, stdio: 'pipe', windowsHide: true, detached: process.platform !== 'win32' });
      const output = new StringDecoder('utf8'), errors = new StringDecoder('utf8'), lines = new ProtocolLines();
      const emitText = (stream, text) => { for (let offset = 0; offset < text.length; offset += 16000) this.emit({ type: 'event', channel, event: 'data', stream, data: text.slice(offset, offset + 16000) }); };
      child.stdout.on('data', data => {
        if (scope.stopped) return;
        const text = output.write(data);
        try {
          lines.write(text, line => {
            try { const message = JSON.parse(line); if (message.method && message.id !== undefined) scope.requestIds.add(JSON.stringify(message.id)); } catch {}
            if (scope.requestIds.size > 64) throw new Error('本機未完成互動請求過多。');
          });
        } catch (error) { scope.failure = error.message; this.stop(channel); return; }
        emitText('stdout', text);
      });
      child.stderr.on('data', data => emitText('stderr', errors.write(data)));
      child.stdin.on('error', () => this.stop(channel));
      let exited = false;
      const exit = error => { if (exited) return; exited = true; this.processes.delete(channel); this.emit({ type: 'event', channel, event: 'exit', ...(error ? { error } : {}) }); };
      child.on('error', error => exit(error.message));
      scope.closed = new Promise(resolve => child.on('close', code => { lines.clear(); exit(scope.failure || (code && !scope.stopped ? `Local Codex exited (${code})` : undefined)); resolve(); }));
      return { directory: this.filesystem.virtual(cwd), version: this.version };
    } catch (error) { this.processes.delete(channel); throw error; }
  }
  write({ channel, data }) {
    const scope = this.processes.get(channel);
    if (!scope) return Promise.reject(new Error('Local Codex channel is unavailable'));
    const operation = scope.writes.then(() => this.writeLines(channel, data));
    scope.writes = operation.catch(() => {}); return operation;
  }
  async writeLines(channel, data) {
    const scope = this.processes.get(channel);
    if (!scope?.child || scope.stopped || typeof data !== 'string' || data.length > 1048576) throw new Error('Local Codex channel is unavailable');
    scope.pending += data;
    if (scope.pending.length > 1048576) throw new Error('Local Codex input exceeds the limit');
    const lines = scope.pending.split('\n'); scope.pending = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.method) {
        if (!['initialize', 'initialized', 'thread/start', 'thread/resume', 'model/list', 'turn/start', 'turn/interrupt', 'thread/delete'].includes(message.method)) throw new Error('Local connector refuses this Codex RPC method');
        if (message.params?.cwd) message.params.cwd = await this.filesystem.location(message.params.cwd);
        if (message.params?.sandbox === 'danger-full-access' && !this.allowFullAccess) throw new Error('Local full access requires starting the connector with --allow-full-access');
        if (message.params?.sandboxPolicy?.type === 'dangerFullAccess' && !this.allowFullAccess) throw new Error('Local full access is disabled');
        const config = message.params?.config;
        if (config && (typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !['agents.enabled', 'agents.max_concurrent_threads_per_session', 'features.multi_agent', 'features.default_mode_request_user_input'].includes(key)) || (Object.hasOwn(config, 'features.default_mode_request_user_input') && typeof config['features.default_mode_request_user_input'] !== 'boolean'))) throw new Error('Local connector refuses configuration overrides');
        if (Array.isArray(message.params?.input)) for (const input of message.params.input) if (input.type === 'localImage') input.path = await this.filesystem.location(input.path);
      } else {
        const key = JSON.stringify(message.id);
        if (!scope.requestIds.delete(key)) throw new Error('Local Codex response has no matching request');
      }
      scope.child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  }
  stop(channel) {
    const scope = this.processes.get(channel); if (!scope) return; scope.stopped = true;
    if (scope.child?.pid) {
      if (process.platform === 'win32') spawn('taskkill.exe', ['/pid', String(scope.child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      else { try { process.kill(-scope.child.pid, 'SIGTERM'); } catch {} }
    }
    scope.child?.stdin.end();
  }
  async close() { const jobs = [...this.processes.values()]; for (const channel of this.processes.keys()) this.stop(channel); await Promise.all(jobs.map(job => job.closed)); }
}
