import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { RotateCw, Eraser } from 'lucide-react';
import type { ServerProfile } from '@cozypad/contracts';
import '@xterm/xterm/css/xterm.css';
import { IconButton } from '../components/Controls';

export function TerminalWorkspace({ server, tool }: { server: ServerProfile; tool?: 'nvtop' | 'htop' }) {
  const container = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const reconnectRef = useRef<() => void>(() => {});
  const [state, setState] = useState('連線中');
  const [connectionError, setConnectionError] = useState('');
  const reconnect = () => reconnectRef.current();
  useEffect(() => {
    if (!container.current) return;
    let disposed = false, sessionId = '', sequence = 0, retries = 0;
    let active: WebSocket | null = null, ready = false;
    let retryTimer: number | undefined, deadline: number | undefined;
    let stopTransport = () => {};
    setState('連線中'); setConnectionError('');
    const terminal = new Terminal({ fontSize: tool ? 12 : 13, fontFamily: 'Cascadia Code, Consolas, monospace', cursorBlink: true, scrollback: 5000,
      theme: { background: '#0c100e', foreground: '#dfe9e3', cursor: '#75dfa9', selectionBackground: '#254c3b' } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(container.current); terminalRef.current = terminal;
    const sendSize = () => {
      // Retained terminals are hidden while another workspace is displayed.
      // Avoid shrinking the PTY to an empty container during that time.
      if (disposed || !container.current?.clientWidth || !container.current.clientHeight) return;
      fit.fit();
      // Keep ncurses tools usable on phones; the panel can scroll horizontally.
      if (tool && terminal.cols < 80) terminal.resize(80, terminal.rows);
      if (ready && active?.readyState === WebSocket.OPEN) active.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    };
    const observer = new ResizeObserver(sendSize); observer.observe(container.current);
    // Never replay keyboard input: a command may already have reached the shell.
    const subscription = terminal.onData(data => { if (ready && active?.readyState === WebSocket.OPEN) active.send(JSON.stringify({ type: 'input', data })); });
    const retry = () => {
      if (disposed || !sessionId || retries >= 5) return false;
      retries++;
      setState('重新接回中');
      setConnectionError(`通道暫時中斷，正在接回原終端機（${retries}/5）。原工作階段最多保留 10 分鐘。`);
      retryTimer = window.setTimeout(connect, Math.min(1000 * 2 ** (retries - 1), 10000));
      return true;
    };
    function connect() {
      if (disposed) return;
      stopTransport();
      clearTimeout(retryTimer); clearTimeout(deadline);
      const previous = active;
      active = null; ready = false; previous?.close();
      setState(sessionId ? '重新接回中' : '連線中');
      const query = new URLSearchParams({ serverId: server.id });
      if (tool) query.set('tool', tool);
      if (sessionId) { query.set('sessionId', sessionId); query.set('after', String(sequence)); }
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminal?${query}`);
      active = ws;
      let failed = false, connected = false, lastReply = Date.now();
      const current = () => !disposed && active === ws;
      const fail = (text: string) => {
        if (!current()) return;
        failed = true; ready = false; setState('連線失敗'); setConnectionError(text);
      };
      const interrupt = (code: number, reason = '') => {
        if (!current()) return;
        clearInterval(heartbeat); clearTimeout(deadline); active = null; ready = false;
        if (failed) return;
        if (code === 4401 || code === 4009) {
          sessionId = ''; sequence = 0;
          setState('連線失敗'); setConnectionError(code === 4401 ? '登入已過期，請重新登入後再開啟終端機。' : '此終端機已在另一個連線開啟。'); return;
        }
        if (code !== 1000 && retry()) return;
        setState(connected || sessionId ? '已中斷' : '連線失敗');
        setConnectionError(reason || (code === 1000 && connected
          ? '終端機工作階段已結束。可按「重新開啟終端機」繼續。'
          : `終端機通道已中斷（WebSocket ${code}）。請重新開啟終端機；若仍失敗，請重新連線 SSH。`));
      };
      ws.onmessage = event => {
        if (!current()) return;
        lastReply = Date.now();
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'output' && typeof payload.data === 'string') {
            if (!Number.isSafeInteger(payload.sequence) || payload.sequence > sequence) {
              terminal.write(payload.data);
              if (Number.isSafeInteger(payload.sequence)) sequence = payload.sequence;
            }
          }
          if (payload.type === 'ready') {
            sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
            ready = true; connected = true; retries = 0;
            clearTimeout(deadline); setState('已連線'); setConnectionError(''); sendSize(); terminal.focus();
          }
          if (payload.type === 'notice') terminal.writeln(`\r\n${String(payload.text)}`);
          if (payload.type === 'ended') { sessionId = ''; sequence = 0; }
          if (payload.type === 'error') {
            if (['TERMINAL_MISSING', 'TERMINAL_ENDED', 'SSH_DISCONNECTED'].includes(payload.code)) { sessionId = ''; sequence = 0; }
            const text = String(payload.text || '終端機通道發生錯誤。'); fail(text); terminal.writeln(`\r\n${text}`);
          }
        } catch { fail('無法解析終端機通道的回覆。請重新開啟終端機。'); }
      };
      ws.onclose = event => interrupt(event.code, event.reason);
      // Browsers also emit close after error; let close decide whether to resume.
      ws.onerror = () => {};
      const heartbeat = window.setInterval(() => {
        if (!current() || ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastReply > 60000) { interrupt(4000); ws.close(); return; }
        ws.send(JSON.stringify({ type: 'ping' }));
      }, 20000);
      deadline = window.setTimeout(() => {
        if (!current() || ready) return;
        if (sessionId) interrupt(4000);
        else { fail('終端機通道啟動逾時。請重新開啟終端機；若仍失敗，請重新連線 SSH。'); interrupt(4000); }
        ws.close();
      }, 20000);
      stopTransport = () => { clearInterval(heartbeat); clearTimeout(deadline); };
    }
    reconnectRef.current = () => { retries = 0; setConnectionError(''); connect(); };
    connect();
    return () => {
      disposed = true; reconnectRef.current = () => {};
      stopTransport();
      clearTimeout(retryTimer); clearTimeout(deadline); observer.disconnect(); subscription.dispose();
      if (active?.readyState === WebSocket.OPEN) active.send(JSON.stringify({ type: 'release' }));
      active?.close(); active = null; terminal.dispose(); terminalRef.current = null;
    };
  }, [server.id, tool]);
  return <section className="terminal-workspace">
    <div className="workspace-toolbar"><span className="terminal-host">{tool ? `${tool} · ${server.name}` : `${server.username}@${server.host}`}</span><span className="muted" role="status" aria-label={tool ? `${tool} 連線狀態` : '終端機連線狀態'}>{state}</span><div className="toolbar-spacer" /><IconButton label={tool ? `清除 ${tool} 畫面` : '清除終端畫面'} onClick={() => terminalRef.current?.clear()}><Eraser size={17} /></IconButton><IconButton label={tool ? `重新開啟 ${tool}` : '重新連線終端機'} onClick={reconnect}><RotateCw size={17} /></IconButton></div>
    {connectionError && <div className="terminal-connection-notice" role="alert"><span>{connectionError}</span><button type="button" className="secondary" onClick={reconnect}>{tool ? `接回 ${tool}` : '重新開啟終端機'}</button></div>}
    <div className="terminal-container"><div className="terminal-surface" ref={container} /></div>
  </section>;
}
