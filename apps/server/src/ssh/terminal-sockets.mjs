import { WebSocketServer } from 'ws';
import { validateOrigin } from '../http.mjs';
import { TerminalSessions, sendTerminal } from './terminal-sessions.mjs';

export function terminalSockets(server, auth, ssh, profiles, options = {}) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  const terminals = new TerminalSessions(ssh, profiles, options);
  sockets.disposeTerminals = () => terminals.close();
  server.on('close', sockets.disposeTerminals);
  server.on('upgrade', async (request, socket, head) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname !== '/api/terminal') { socket.destroy(); return; }
      validateOrigin(request, true);
      const session = await auth.require(request);
      const id = url.searchParams.get('serverId');
      await profiles.find(session.user.username, id);
      const tool = url.searchParams.get('tool') || '';
      if (tool && !['nvtop', 'htop'].includes(tool)) throw Object.assign(new Error('Invalid monitor tool'), { status: 400 });
      const resume = { sessionId: url.searchParams.get('sessionId'), after: Number(url.searchParams.get('after')), tool };
      if (resume.sessionId && !/^[a-f0-9-]{36}$/i.test(resume.sessionId)) throw Object.assign(new Error('Invalid terminal session'), { status: 400 });
      sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws, request, session, id, resume));
    } catch (error) { socket.end(`HTTP/1.1 ${error.status || 400} Rejected\r\nConnection: close\r\n\r\n`); }
  });
  sockets.on('connection', async (ws, request, session, id, resume) => {
    let terminal, alive = true, checkingAuth = false;
    ws.on('error', () => {});
    ws.on('pong', () => { alive = true; });
    // Protocol pings are answered by the browser even when page timers pause.
    const heartbeat = setInterval(() => {
      if (ws.readyState !== 1) return;
      if (!alive) { ws.terminate(); return; }
      alive = false; ws.ping();
    }, options.heartbeatMs || 20000);
    heartbeat.unref();
    const timer = setInterval(async () => {
      if (checkingAuth || ws.readyState !== 1) return;
      checkingAuth = true;
      try { await auth.require(request); }
      catch { ws.close(4401, 'Login expired'); terminals.releaseSocket(ws); }
      finally { checkingAuth = false; }
    }, options.authCheckMs || 30000);
    timer.unref();
    ws.on('close', () => { clearInterval(timer); clearInterval(heartbeat); });
    ws.on('message', raw => {
      try {
        const payload = JSON.parse(raw.toString());
        if (payload.type === 'ping') { alive = true; sendTerminal(ws, { type: 'pong' }); }
        if (!terminal || terminal.ws !== ws || !terminal.live) return;
        if (payload.type === 'release') { terminals.dispose(terminal); return; }
        if (payload.type === 'input' && typeof payload.data === 'string' && payload.data.length <= 65536) terminal.channel.write(payload.data);
        if (payload.type === 'resize') terminal.channel.setWindow(Math.max(2, Math.min(200, Number(payload.rows) || 24)), Math.max(10, Math.min(500, Number(payload.cols) || 80)), 0, 0);
      } catch { sendTerminal(ws, { type: 'error', text: '終端機訊息格式不正確。' }); }
    });
    try { terminal = await terminals.attach(session.user.username, id, ws, resume); }
    catch (error) { sendTerminal(ws, { type: 'error', code: error.code, text: error.message }); ws.close(); }
  });
  return sockets;
}
