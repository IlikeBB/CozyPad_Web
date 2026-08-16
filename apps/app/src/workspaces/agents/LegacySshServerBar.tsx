import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  createLegacyServer,
  deleteLegacyServer,
  getLegacySession,
  isLegacyAuthError,
  listLegacyServers,
  loginLegacy,
  verifyLegacyTwoFactor,
} from './legacySshApi';
import type {
  LegacyAuthUser,
  LegacyLoginResponse,
  LegacySshServer,
  LegacyTwoFactorSetup,
} from './legacySshApi';
import {
  findRememberedLegacyServer,
  rememberLastSelectedLegacyServerId,
  subscribeLastSelectedLegacyServerId,
} from '../sshServerPreference';

type LoginStep =
  | { kind: 'credentials' }
  | {
      kind: 'twoFactor';
      challengeId: string;
      username: string;
      setup?: LegacyTwoFactorSetup;
    };

const EMPTY_FORM = {
  name: '',
  host: '',
  user: '',
  port: '22',
  password: '',
  defaultPath: '~',
};

function serverTarget(server: LegacySshServer): string {
  if (server.source === 'system') {
    return server.alias || server.name;
  }
  if (server.source === 'ssh-config') {
    return server.alias || server.name;
  }
  const user = server.user ? `${server.user}@` : '';
  const port = server.port ? `:${server.port}` : '';
  return `${user}${server.host}${port}`;
}

function isLocalTerminalServer(server: LegacySshServer | null): boolean {
  if (!server) return false;
  if (server.localOnly) return true;
  if (server.source === 'system' && server.id === 'system:localhost') return true;

  const host = server.host.trim().toLowerCase();
  const labels = [server.id, server.name, server.alias, server.source]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  const labelledLocalTerminal = labels.some(
    (value) => value === 'local terminal' || value.includes('local terminal'),
  );
  const noSshPort =
    server.port === undefined ||
    server.port === null ||
    Number(server.port) <= 0 ||
    !Number.isFinite(Number(server.port));

  return (
    (host === 'localhost' || host === '::1' || host.startsWith('127.')) &&
    (labelledLocalTerminal || noSshPort)
  );
}

function loginResponseToStep(
  response: LegacyLoginResponse,
  fallbackUsername: string,
): LoginStep | null {
  if ((response.requiresTwoFactor || response.requiresTwoFactorSetup) && response.challengeId) {
    return {
      kind: 'twoFactor',
      challengeId: response.challengeId,
      username: response.user?.username || fallbackUsername,
      setup: response.requiresTwoFactorSetup ? response.setup : undefined,
    };
  }
  return null;
}

export function LegacySshServerBar({
  selectedServer,
  onServerChange,
}: {
  selectedServer: LegacySshServer | null;
  onServerChange: (server: LegacySshServer | null) => void;
}) {
  const [sessionUser, setSessionUser] = useState<LegacyAuthUser | null>(null);
  const [loginStep, setLoginStep] = useState<LoginStep>({ kind: 'credentials' });
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [servers, setServers] = useState<LegacySshServer[]>([]);
  const [checkingSession, setCheckingSession] = useState(true);
  const [loadingServers, setLoadingServers] = useState(false);
  const [savingServer, setSavingServer] = useState(false);
  const [serverModalOpen, setServerModalOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [status, setStatus] = useState('');

  const selectedId = selectedServer?.id ?? '';
  const canManageServers = sessionUser !== null;
  const selectedServerTarget = useMemo(
    () => (selectedServer ? serverTarget(selectedServer) : ''),
    [selectedServer],
  );

  const loadServers = useCallback(
    async (refresh = false) => {
      if (!canManageServers) return;
      setLoadingServers(true);
      setStatus(refresh ? '正在同步 SSH server...' : '');
      try {
        const nextServers = await listLegacyServers(refresh);
        setServers(nextServers);
        if (!selectedServer) {
          const remembered = findRememberedLegacyServer(nextServers);
          if (remembered) onServerChange(remembered);
        }
        setStatus(refresh ? '已重新整理 SSH server' : '');
      } catch (error) {
        if (isLegacyAuthError(error)) {
          setSessionUser(null);
          onServerChange(null);
          setStatus('CozyPad session 已過期，請重新登入。');
        } else {
          setStatus(error instanceof Error ? error.message : 'SSH server 載入失敗');
        }
      } finally {
        setLoadingServers(false);
      }
    },
    [canManageServers, onServerChange],
  );

  useEffect(() => {
    let active = true;

    async function checkSession() {
      setCheckingSession(true);
      try {
        const session = await getLegacySession();
        if (!active) return;
        setSessionUser(session.authenticated ? session.user : null);
        if (session.authenticated) {
          setStatus('');
        }
      } catch (error) {
        if (!active) return;
        setSessionUser(null);
        setStatus(error instanceof Error ? error.message : 'CozyPad session 檢查失敗');
      } finally {
        if (active) setCheckingSession(false);
      }
    }

    void checkSession();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (sessionUser) {
      void loadServers(false);
    } else {
      setServers([]);
      onServerChange(null);
    }
  }, [loadServers, onServerChange, sessionUser]);

  useEffect(() => {
    if (!selectedServer) return;
    const updated = servers.find((server) => server.id === selectedServer.id) || null;
    if (!updated) {
      onServerChange(null);
      rememberLastSelectedLegacyServerId('');
    } else if (updated !== selectedServer) {
      onServerChange(updated);
    }
  }, [onServerChange, selectedServer, servers]);

  useEffect(
    () =>
      subscribeLastSelectedLegacyServerId((serverId) => {
        if (!serverId) {
          onServerChange(null);
          return;
        }
        const server = servers.find((item) => item.id === serverId);
        if (server) onServerChange(server);
      }),
    [onServerChange, servers],
  );

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus('');
    try {
      const result = await loginLegacy(username.trim(), password);
      const nextStep = loginResponseToStep(result, username.trim());
      if (nextStep) {
        setLoginStep(nextStep);
        setStatus('請輸入 TOTP 驗證碼。');
        return;
      }
      if (result.user) {
        setSessionUser(result.user);
        setPassword('');
        setStatus('已登入 CozyPad SSH API');
        return;
      }
      throw new Error(result.error || '登入回應格式不正確');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '登入失敗');
    }
  };

  const handleVerify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loginStep.kind !== 'twoFactor') return;
    setStatus('');
    try {
      const result = await verifyLegacyTwoFactor(loginStep.challengeId, twoFactorCode.trim());
      if (!result.user) {
        throw new Error(result.error || '驗證回應格式不正確');
      }
      setSessionUser(result.user);
      setLoginStep({ kind: 'credentials' });
      setPassword('');
      setTwoFactorCode('');
      setStatus('已通過 CozyPad 2FA');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '驗證失敗');
    }
  };

  const handleAddServer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSavingServer(true);
    setStatus('正在安裝 SSH key 並測試連線...');
    try {
      const server = await createLegacyServer({
        name: form.name.trim(),
        host: form.host.trim(),
        user: form.user.trim(),
        port: Number(form.port || 22),
        password: form.password,
        defaultPath: form.defaultPath.trim() || '~',
      });
      setServers((current) => [server, ...current.filter((item) => item.id !== server.id)]);
      onServerChange(server);
      rememberLastSelectedLegacyServerId(server.id);
      setForm(EMPTY_FORM);
      setServerModalOpen(false);
      setStatus(`已新增 ${server.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '新增 SSH server 失敗');
    } finally {
      setSavingServer(false);
      setForm((current) => ({ ...current, password: '' }));
    }
  };

  const handleDeleteServer = async () => {
    if (!selectedServer) return;
    const confirmed = window.confirm(`刪除 ${selectedServer.name} 的 SSH 設定？`);
    if (!confirmed) return;
    setLoadingServers(true);
    try {
      await deleteLegacyServer(selectedServer.id);
      setServers((current) => current.filter((server) => server.id !== selectedServer.id));
      onServerChange(null);
      rememberLastSelectedLegacyServerId('');
      setStatus(`已刪除 ${selectedServer.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '刪除 SSH server 失敗');
    } finally {
      setLoadingServers(false);
    }
  };

  return (
    <section className="legacy-ssh-bar" aria-label="Legacy SSH servers">
      <div className="legacy-ssh-bar-main">
        <div className="legacy-ssh-title">
          <strong>SSH server</strong>
          <span>
            {checkingSession
              ? '檢查 session'
              : sessionUser
                ? `${sessionUser.username} · ${servers.length} 台`
                : '需要登入'}
          </span>
        </div>

        {sessionUser ? (
          <>
            <select
              value={selectedId}
              onChange={(event) => {
                const server =
                  servers.find((item) => item.id === event.currentTarget.value) || null;
                onServerChange(server);
                rememberLastSelectedLegacyServerId(server?.id || '');
              }}
              disabled={loadingServers}
            >
              <option value="">選擇 SSH server</option>
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name} | {isLocalTerminalServer(server) ? 'local machine' : serverTarget(server)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void loadServers(true)}
              disabled={loadingServers}
            >
              重新整理
            </button>
            <button type="button" onClick={() => setServerModalOpen(true)}>
              新增 server
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => void handleDeleteServer()}
              disabled={!selectedServer || selectedServer.source === 'system' || loadingServers}
            >
              刪除
            </button>
          </>
        ) : loginStep.kind === 'credentials' ? (
          <form className="legacy-ssh-login" onSubmit={(event) => void handleLogin(event)}>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="CozyPad 帳號"
            />
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="密碼"
              type="password"
            />
            <button type="submit" disabled={!username.trim() || !password}>
              登入
            </button>
          </form>
        ) : (
          <form className="legacy-ssh-login" onSubmit={(event) => void handleVerify(event)}>
            <input value={loginStep.username} readOnly />
            <input
              value={twoFactorCode}
              onChange={(event) => setTwoFactorCode(event.target.value)}
              placeholder="TOTP 驗證碼"
              inputMode="numeric"
            />
            <button type="submit" disabled={!twoFactorCode.trim()}>
              驗證
            </button>
          </form>
        )}
      </div>

      {selectedServer ? (
        <p className="legacy-ssh-selected">
          已選擇 {selectedServer.name}
          {selectedServerTarget ? ` · ${selectedServerTarget}` : ''}
          {selectedServer.defaultPath ? ` · ${selectedServer.defaultPath}` : ''}
        </p>
      ) : null}

      {loginStep.kind === 'twoFactor' && loginStep.setup ? (
        <div className="legacy-ssh-setup">
          <strong>首次啟用 2FA</strong>
          <span>Secret: {loginStep.setup.secret}</span>
          <code>{loginStep.setup.otpauthUrl}</code>
        </div>
      ) : null}

      {status ? <p className="legacy-ssh-status">{status}</p> : null}

      {serverModalOpen ? (
        <div className="legacy-ssh-modal-backdrop" role="presentation">
          <section className="legacy-ssh-modal" role="dialog" aria-modal="true">
            <header>
              <div>
                <span>Install key once</span>
                <h3>新增 SSH server</h3>
              </div>
              <button
                type="button"
                onClick={() => {
                  setForm(EMPTY_FORM);
                  setServerModalOpen(false);
                }}
                disabled={savingServer}
              >
                關閉
              </button>
            </header>
            <form onSubmit={(event) => void handleAddServer(event)}>
              <label>
                <span>名稱</span>
                <input
                  autoFocus
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder="NCKU-91"
                  required
                />
              </label>
              <label>
                <span>Host</span>
                <input
                  value={form.host}
                  onChange={(event) => setForm({ ...form, host: event.target.value })}
                  placeholder="140.113.xxx.xxx"
                  required
                />
              </label>
              <div className="legacy-ssh-form-row">
                <label>
                  <span>User</span>
                  <input
                    value={form.user}
                    onChange={(event) => setForm({ ...form, user: event.target.value })}
                    placeholder="ubuntu"
                    required
                  />
                </label>
                <label>
                  <span>Port</span>
                  <input
                    value={form.port}
                    onChange={(event) => setForm({ ...form, port: event.target.value })}
                    inputMode="numeric"
                    required
                  />
                </label>
              </div>
              <label>
                <span>SSH 密碼</span>
                <input
                  value={form.password}
                  onChange={(event) => setForm({ ...form, password: event.target.value })}
                  placeholder="只用於這次安裝 key"
                  type="password"
                  required
                />
              </label>
              <label>
                <span>起始路徑</span>
                <input
                  value={form.defaultPath}
                  onChange={(event) => setForm({ ...form, defaultPath: event.target.value })}
                  placeholder="~"
                />
              </label>
              <footer>
                <button
                  type="button"
                  onClick={() => {
                    setForm(EMPTY_FORM);
                    setServerModalOpen(false);
                  }}
                  disabled={savingServer}
                >
                  取消
                </button>
                <button type="submit" disabled={savingServer}>
                  {savingServer ? '處理中...' : '儲存 server'}
                </button>
              </footer>
            </form>
          </section>
        </div>
      ) : null}
    </section>
  );
}
