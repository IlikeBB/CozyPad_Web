import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TerminalKeysBar } from '../components/TerminalKeysBar';
import { TerminalView } from '../components/TerminalView';
import type { TerminalHandle, TerminalModifiers } from '../components/TerminalView';
import {
  closeLegacyTerminal,
  isLegacyAuthError,
  listLegacyServers,
} from './agents/legacySshApi';
import type { LegacySshServer } from './agents/legacySshApi';
import {
  readLastSelectedLegacyServerId,
  resolveLastSelectedLegacyServerId,
  subscribeLastSelectedLegacyServerId,
} from './sshServerPreference';

interface TerminalWorkspaceProps {
  connected?: boolean;
  profileId?: string | null;
}

type TerminalTab = {
  id: number;
  terminalId: string;
  serverId: string;
  serverName: string;
};

const QUICK_COMMANDS: { label: string; command: string }[] = [
  { label: '列表', command: 'ls -la' },
  { label: '路徑', command: 'pwd' },
  { label: 'Git 狀態', command: 'git status' },
  { label: 'Git 紀錄', command: 'git log --oneline -10' },
  { label: 'GPU 狀態', command: 'nvidia-smi' },
  { label: 'GPU 監看', command: 'watch -n1 nvidia-smi' },
  { label: '記憶體', command: 'free -h' },
  { label: '硬碟', command: 'df -h' },
  { label: '程序', command: 'htop' },
  { label: 'tmux 列表', command: 'tmux ls' },
  { label: 'tmux 連線', command: 'tmux attach -t ' },
  { label: 'Python', command: 'python -V' },
];

function createTerminalSessionId(serverId: string): string {
  const random =
    typeof window !== 'undefined' && window.crypto?.randomUUID
      ? window.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const safeServer = serverId.replace(/[^A-Za-z0-9:_-]/g, '-').slice(0, 48);
  return `term-${safeServer}-${random}`.replace(/[^A-Za-z0-9:_-]/g, '-').slice(0, 150);
}

function resolveTerminalServerId(
  servers: LegacySshServer[],
  preferredId: string | null | undefined,
  currentId = '',
): string {
  if (preferredId && servers.some((server) => server.id === preferredId)) {
    return preferredId;
  }
  return resolveLastSelectedLegacyServerId(servers, currentId);
}

export function TerminalWorkspace({ connected = false, profileId = null }: TerminalWorkspaceProps) {
  const [servers, setServers] = useState<LegacySshServer[]>([]);
  const [selectedServerId, setSelectedServerId] = useState(() => readLastSelectedLegacyServerId());
  const [serverError, setServerError] = useState('');
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [quickOpen, setQuickOpen] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [modifiers, setModifiers] = useState<TerminalModifiers>({
    ctrl: false,
    alt: false,
  });
  const [keysBarOn, setKeysBarOn] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(pointer: coarse), (max-width: 600px)').matches,
  );
  const nextId = useRef(1);
  const handles = useRef(new Map<number, TerminalHandle>());

  const selectedServer = useMemo(
    () => servers.find((server) => server.id === selectedServerId) ?? null,
    [selectedServerId, servers],
  );

  const loadServers = useCallback(
    async (refresh = false) => {
      setServerError('');
      try {
        const nextServers = await listLegacyServers(refresh);
        setServers(nextServers);
        setSelectedServerId((current) =>
          resolveTerminalServerId(nextServers, profileId, current),
        );
      } catch (error) {
        if (isLegacyAuthError(error)) {
          setServerError('請先登入 CozyPad，Terminal 才能載入已匯入 SSH server。');
        } else {
          setServerError(error instanceof Error ? error.message : 'SSH server 載入失敗');
        }
      }
    },
    [profileId],
  );

  useEffect(() => {
    if (!connected) {
      setServers((current) => (current.length ? [] : current));
      setSelectedServerId((current) => (current ? '' : current));
      setServerError('Press Connect before opening SSH terminals.');
      for (const tab of tabs) {
        void closeLegacyTerminal(tab.terminalId).catch(() => undefined);
      }
      handles.current.clear();
      setTabs((current) => (current.length ? [] : current));
      setActive((current) => (current === null ? current : null));
      return;
    }

    void loadServers(false);
  }, [connected, loadServers]);

  useEffect(() => {
    if (!profileId || !servers.some((server) => server.id === profileId)) return;
    setSelectedServerId(profileId);
  }, [profileId, servers]);

  useEffect(
    () =>
      subscribeLastSelectedLegacyServerId((serverId) => {
        if (!serverId || !servers.some((server) => server.id === serverId)) return;
        setSelectedServerId(serverId);
      }),
    [servers],
  );

  const addTab = useCallback(() => {
    if (!connected) {
      setServerError('Press Connect before opening SSH terminals.');
      return;
    }

    if (!selectedServer) {
      setServerError('請先選擇已匯入的 SSH server。');
      return;
    }

    const id = nextId.current++;
    const tab: TerminalTab = {
      id,
      terminalId: createTerminalSessionId(selectedServer.id),
      serverId: selectedServer.id,
      serverName: selectedServer.name,
    };
    setTabs((current) => [...current, tab]);
    setActive(id);
    setServerError('');
  }, [connected, selectedServer]);

  useEffect(() => {
    if (!connected) return undefined;
    const handleNewTerminal = () => addTab();
    window.addEventListener('cozypad:terminal:new', handleNewTerminal);
    return () => window.removeEventListener('cozypad:terminal:new', handleNewTerminal);
  }, [addTab, connected]);

  const closeTab = (id: number) => {
    const tab = tabs.find((item) => item.id === id);
    if (tab) {
      void closeLegacyTerminal(tab.terminalId).catch((error) => {
        setServerError(error instanceof Error ? error.message : 'Terminal 關閉失敗');
      });
    }

    handles.current.delete(id);
    setTabs((current) => {
      const remaining = current.filter((tabItem) => tabItem.id !== id);
      setActive((activeId) =>
        activeId === id ? (remaining[remaining.length - 1]?.id ?? null) : activeId,
      );
      return remaining;
    });
  };

  const runQuick = (command: string, execute: boolean) => {
    const handle = active !== null ? handles.current.get(active) : undefined;
    if (!handle) return;
    if (execute) handle.run(command);
    else handle.paste(command);
    handle.focus();
  };

  return (
    <div className="terminal-workspace">
      <div className="tab-bar">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab${active === tab.id ? ' tab-active' : ''}`}
            onClick={() => setActive(tab.id)}
          >
            <span>{tab.serverName}</span>
            <button
              className="tab-close"
              title="Close"
              onClick={(event) => {
                event.stopPropagation();
                closeTab(tab.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <span className="spacer" />
        <span className="hint terminal-hint">右鍵：有選取＝複製，無選取＝貼上</span>
        <button
          className={`tab-quick-toggle${keysBarOn ? ' tab-quick-toggle-on' : ''}`}
          onClick={() => setKeysBarOn((on) => !on)}
          title="手機快捷鍵"
        >
          Keys
        </button>
        <button
          className={`tab-quick-toggle${quickOpen ? ' tab-quick-toggle-on' : ''}`}
          onClick={() => setQuickOpen((open) => !open)}
          title="快速指令"
        >
          Commands
        </button>
      </div>
      <div className="terminal-body">
        <div className="terminal-panes">
          {tabs.length === 0 ? (
            <div className="placeholder">
              <p>No terminals open.</p>
              <p className="hint">{serverError || '左上角選擇已匯入 SSH server 後，按齒輪旁的 + 開始連線。'}</p>
            </div>
          ) : null}
          {tabs.map((tab) => (
            <div key={tab.id} className="terminal-pane" hidden={active !== tab.id}>
              <TerminalView
                legacyServerId={tab.serverId}
                legacyTerminalId={tab.terminalId}
                onNotify={(message) => {
                  setToast(message);
                  setTimeout(() => setToast(null), 1600);
                }}
                onModifiersChange={setModifiers}
                onHandle={(handle) => {
                  if (handle) handles.current.set(tab.id, handle);
                  else handles.current.delete(tab.id);
                }}
              />
            </div>
          ))}
        </div>
        {quickOpen && tabs.length > 0 ? (
          <aside className="quick-commands">
            <div className="quick-head hint">快速指令：點左側貼上，點右側執行</div>
            {QUICK_COMMANDS.map((entry) => (
              <div key={entry.command} className="quick-row">
                <button
                  className="quick-paste"
                  title={entry.command}
                  onClick={() => runQuick(entry.command, false)}
                >
                  <span className="quick-label">{entry.label}</span>
                  <span className="quick-cmd mono">{entry.command}</span>
                </button>
                <button
                  className="quick-run"
                  title={`執行 ${entry.command}`}
                  onClick={() => runQuick(entry.command, true)}
                >
                  ↵
                </button>
              </div>
            ))}
          </aside>
        ) : null}
      </div>
      {keysBarOn && tabs.length > 0 ? (
        <TerminalKeysBar
          modifiers={modifiers}
          onSend={(sequence) => {
            const handle = active !== null ? handles.current.get(active) : undefined;
            handle?.sendRaw(sequence);
            handle?.focus();
          }}
          onToggleModifier={(mod) => {
            const handle = active !== null ? handles.current.get(active) : undefined;
            handle?.setModifier(mod, !modifiers[mod]);
            handle?.focus();
          }}
        />
      ) : null}
      {toast !== null ? <div className="terminal-toast">{toast}</div> : null}
    </div>
  );
}
