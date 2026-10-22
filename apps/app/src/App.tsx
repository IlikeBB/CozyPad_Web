import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Activity, BookOpen, Bot, Bug, ChevronDown, FileKey2, Files, LogOut, PlugZap, Settings2, ShieldCheck, SquareTerminal, TerminalSquare, X } from 'lucide-react';
import type { ServerProfile, Session } from '@cozypad/contracts';
import { api, ApiError, message, post } from './api';
import { Busy, Dialog, EmptyConnection, IconButton } from './components/Controls';
import { LoginScreen } from './components/LoginScreen';
import { ConnectionManager } from './components/ConnectionManager';
const TerminalWorkspace = lazy(() => import('./workspaces/TerminalWorkspace').then(module => ({ default: module.TerminalWorkspace })));
const FilesWorkspace = lazy(() => import('./workspaces/FilesWorkspace').then(module => ({ default: module.FilesWorkspace })));
const AgentsWorkspace = lazy(() => import('./workspaces/AgentsWorkspace').then(module => ({ default: module.AgentsWorkspace })));
const MonitorWorkspace = lazy(() => import('./workspaces/MonitorWorkspace').then(module => ({ default: module.MonitorWorkspace })));
const IssuesWorkspace = lazy(() => import('./workspaces/IssuesWorkspace').then(module => ({ default: module.IssuesWorkspace })));
const MarkdownWorkspace = lazy(() => import('./workspaces/MarkdownWorkspace').then(module => ({ default: module.MarkdownWorkspace })));

type Workspace = 'agents' | 'terminal' | 'files' | 'markdown' | 'monitor' | 'settings' | 'issues';
const temporarilyHiddenWorkspaces: ReadonlySet<Workspace> = new Set(['markdown']);
const navigation = [
  { id: 'agents' as const, label: 'Agents', icon: Bot }, { id: 'terminal' as const, label: 'Terminal', icon: TerminalSquare },
  { id: 'files' as const, label: 'Files', icon: Files }, { id: 'markdown' as const, label: 'Markdown', icon: BookOpen }, { id: 'monitor' as const, label: 'Monitor', icon: Activity },
  { id: 'issues' as const, label: '問題回報', icon: Bug }
];
export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [servers, setServers] = useState<ServerProfile[]>([]);
  const [selected, setSelected] = useState('');
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace>('agents');
  const [manage, setManage] = useState(false);
  const [error, setError] = useState('');
  const [hostKey, setHostKey] = useState<{ fingerprint: string; id: string; changed: boolean } | null>(null);
  const [terminalOpened, setTerminalOpened] = useState(false);
  const [markdownOpened, setMarkdownOpened] = useState(false);
  const [taskTarget, setTaskTarget] = useState<{ serverId: string; taskId: string } | null>(null);
  const server = servers.find(item => item.id === selected);
  const refreshSession = useCallback(async () => { setSession(await api<Session>('/auth/session')); }, []);
  const refreshServers = useCallback(async () => { setServers(await api<ServerProfile[]>('/servers')); }, []);
  const managerRefresh = useCallback(async (changedId?: string) => { await refreshServers(); if (changedId === selected) { setConnected(false); setTerminalOpened(false); } }, [refreshServers, selected]);
  useEffect(() => {
    void refreshSession().catch(error => setError(message(error))).finally(() => setInitializing(false));
    const expire = () => { setSession(previous => previous ? { ...previous, user: null } : null); setConnected(false); setTerminalOpened(false); setError('登入已過期。'); };
    window.addEventListener('cozypad:session-expired', expire); return () => window.removeEventListener('cozypad:session-expired', expire);
  }, [refreshSession]);
  useEffect(() => {
    if (!session?.user) { setConnected(false); setTerminalOpened(false); return; }
    const username = session.user.username.toLowerCase();
    let mounted = true;
    void api<ServerProfile[]>('/servers').then(items => {
      if (!mounted) return; setServers(items);
      const remembered = localStorage.getItem(`cozypad-tt:${username}:server`);
      setSelected(items.find(item => item.id === remembered)?.id || items[0]?.id || '');
    }).catch(error => { if (mounted) setError(message(error)); });
    return () => { mounted = false; };
  }, [session?.user?.username]);
  useEffect(() => {
    if (!session?.user) return;
    const check = () => { void refreshSession().catch(() => {}); };
    const timer = window.setInterval(check, 60000);
    window.addEventListener('focus', check);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', check); };
  }, [session?.user?.username, refreshSession]);
  useEffect(() => {
    setConnected(false); setTerminalOpened(false); setHostKey(null); setError('');
    if (selected && session?.user) localStorage.setItem(`cozypad-tt:${session.user.username.toLowerCase()}:server`, selected);
  }, [selected]);
  const connect = async (id = selected) => {
    if (!id || connecting) return; setConnecting(true); setError('');
    try { await post(`/servers/${encodeURIComponent(id)}/connect`); setConnected(true); }
    catch (error) {
      if (error instanceof ApiError && error.details.code === 'HOST_KEY' && error.details.fingerprint) setHostKey({ id, fingerprint: error.details.fingerprint, changed: Boolean(error.details.changed) });
      else setError(message(error));
    } finally { setConnecting(false); }
  };
  const logout = async () => {
    try { await post('/auth/logout'); setSession(previous => previous ? { ...previous, user: null } : null); setServers([]); setConnected(false); setTerminalOpened(false); }
    catch (error) { setError(message(error)); }
  };
  if (initializing) return <main className="app-loading"><Busy label="連接 CozyPad TT" /></main>;
  if (!session) return <main className="app-loading"><p className="error">{error || '無法連線至 API。'}</p><button className="secondary" onClick={() => void refreshSession().catch(error => setError(message(error)))}>重新連線</button></main>;
  if (!session.user) return <LoginScreen trustDays={session.trustDays} onLogin={refreshSession} />;
  return <div className="app-shell">
    <aside className="app-sidebar"><div className="brand" title="CozyPad TT"><SquareTerminal size={24} /><strong>CozyPad<span>TT</span></strong></div>
      <span className="nav-section-label">WORKSPACE</span><nav>{navigation.filter(item => !temporarilyHiddenWorkspaces.has(item.id)).map(item => <button key={item.id} aria-label={item.label} title={item.label} disabled={server?.kind === 'local' && ['terminal', 'monitor'].includes(item.id)} className={workspace === item.id ? 'active' : ''} onClick={() => { setWorkspace(item.id); if (item.id === 'terminal') setTerminalOpened(true); if (item.id === 'markdown') setMarkdownOpened(true); }}><item.icon size={18} /><span>{item.label}</span>{workspace === item.id && <i />}</button>)}</nav>
      <div className="sidebar-bottom"><button onClick={() => setManage(true)}><FileKey2 size={18} /><span>連線管理</span><span className="count">{servers.length}</span></button><button className={workspace === 'settings' ? 'active' : ''} onClick={() => setWorkspace('settings')}><Settings2 size={18} /><span>設定</span></button><div className="user-row"><div className="avatar">{session.user.username.slice(0, 1).toUpperCase()}</div><div><strong>{session.user.username}</strong><span>{session.user.role}</span></div><IconButton label="登出" onClick={() => void logout()}><LogOut size={17} /></IconButton></div></div>
    </aside>
    <main className="app-main">
    <div className="app-statusbar" aria-label="主機與版本資訊"><span><i className={`status-dot ${connected ? 'completed' : ''}`} />{workspace === 'issues' ? `回報帳號 · ${session.user.username}` : server ? server.kind === 'local' ? `本機 · ${server.name}` : `${server.username}@${server.host}:${server.port}` : '尚未選擇伺服器'}</span><span>CozyPad TT · V4.0</span></div>
    <header className={`app-header ${workspace === 'issues' ? 'issues-header' : ''}`}><h1>{workspace === 'settings' ? '設定' : navigation.find(item => item.id === workspace)?.label}</h1>{workspace !== 'issues' && <><div className="header-divider" />
      <label className="server-select"><PlugZap size={16} /><select aria-label="選擇伺服器" value={selected} disabled={connecting} onChange={event => { setSelected(event.target.value); if (workspace !== 'markdown') setWorkspace('agents'); }}>{!servers.length && <option value="">尚無伺服器</option>}{servers.map(item => <option key={item.id} value={item.id}>{item.kind === 'local' ? '本機' : 'SSH'} · {item.name}</option>)}</select><ChevronDown size={14} /></label>
      <span className={`connection-badge ${connected ? 'connected' : ''}`}><i />{connected ? '已連線' : '未連線'}</span><div className="toolbar-spacer" />
      <button className={connected ? 'secondary connect-button' : 'primary connect-button'} disabled={!server || connecting} onClick={() => {
        if (connected) void post(`/servers/${encodeURIComponent(selected)}/disconnect`).then(() => { setConnected(false); setTerminalOpened(false); }).catch(error => setError(message(error)));
        else void connect();
      }}>{connecting ? <Busy label="連線中" /> : <><PlugZap size={16} />{connected ? '中斷連線' : '連線'}</>}</button><IconButton label="開啟連線管理" onClick={() => setManage(true)}><Settings2 size={18} /></IconButton></>}
    </header>
    {error && <div className="global-alert" role="alert"><span>{error}</span><IconButton label="關閉錯誤訊息" onClick={() => setError('')}><X size={16} /></IconButton></div>}
    <div className="workspace-content">
      {workspace === 'settings' && <section className="settings-workspace"><h2>帳號與登入</h2><dl><div><dt>使用者</dt><dd>{session.user.username}</dd></div><div><dt>瀏覽器驗證期限</dt><dd>{session.trustDays} 天</dd></div><div><dt>信任有效至</dt><dd>{session.trustedUntil ? new Date(session.trustedUntil).toLocaleString('zh-TW') : '未記住此瀏覽器'}</dd></div></dl><button className="secondary" onClick={() => void post('/auth/forget').then(refreshSession).catch(error => setError(message(error)))}><ShieldCheck size={17} />撤銷此瀏覽器信任</button><h2>連線</h2><button className="secondary" onClick={() => setManage(true)}><FileKey2 size={17} />管理 SSH 連線</button></section>}
      {workspace === 'issues' && <Suspense fallback={<div className="app-loading"><Busy /></div>}><IssuesWorkspace key={session.user.username} user={session.user} /></Suspense>}
      {markdownOpened && <Suspense fallback={<div className="app-loading"><Busy /></div>}><div className="retained-markdown" hidden={workspace !== 'markdown'}><MarkdownWorkspace key={`markdown:${session.user.username}`} server={server} connected={connected} /></div></Suspense>}
      {!['settings', 'issues', 'markdown'].includes(workspace) && (!server || !connected) && <EmptyConnection onManage={() => setManage(true)} />}
      {server && connected && <Suspense fallback={<div className="app-loading"><Busy /></div>}>
        <div className="retained-agents" hidden={workspace !== 'agents'}><AgentsWorkspace key={`agents:${session.user.username}:${server.id}:${taskTarget?.serverId === server.id ? taskTarget.taskId : ''}`} server={server} servers={servers} username={session.user.username} initialTaskId={taskTarget?.serverId === server.id ? taskTarget.taskId : undefined} onOpenTask={(serverId, taskId) => { if (connecting || !servers.some(server => server.id === serverId)) return; setTaskTarget({ serverId, taskId }); setSelected(serverId); setWorkspace('agents'); void connect(serverId); }} /></div>
        {terminalOpened && <div className="retained-terminal" hidden={workspace !== 'terminal'}><TerminalWorkspace key={`terminal:${server.id}`} server={server} /></div>}
        {workspace === 'files' && <FilesWorkspace key={`files:${server.id}`} server={server} />}
        {workspace === 'monitor' && <MonitorWorkspace key={`monitor:${server.id}`} server={server} />}
      </Suspense>}
    </div>
    </main>
    {manage && <ConnectionManager servers={servers} onClose={() => setManage(false)} onRefresh={managerRefresh} />}
    {hostKey && <Dialog title={hostKey.changed ? 'SSH 主機金鑰已變更' : '確認 SSH 主機'} onClose={() => setHostKey(null)}><div className="dialog-body"><p>{hostKey.changed ? '已停止連線。請向伺服器管理員確認主機金鑰。' : '請確認以下指紋與伺服器提供的金鑰相同。'}</p><code className="host-fingerprint">{hostKey.fingerprint}</code><div className="dialog-actions"><button className="secondary" onClick={() => setHostKey(null)}>取消</button>{!hostKey.changed && <button className="primary" onClick={() => {
      const key = hostKey; setHostKey(null); void post(`/servers/${encodeURIComponent(key.id)}/trust`, { fingerprint: key.fingerprint }).then(() => connect(key.id)).catch(error => setError(message(error)));
    }}><ShieldCheck size={16} />信任並連線</button>}</div></div></Dialog>}
  </div>;
}
