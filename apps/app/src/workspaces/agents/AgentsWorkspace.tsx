import { useEffect, useMemo, useState } from 'react';
import type {
  AgentKind,
  AgentSessionStatus,
  AgentSessionSummary,
  ChatItem,
  ConnectionProfile,
} from '@cozypad/contracts';
import {
  mockAgentInstallState,
  mockAgentSessions,
  mockAgentTimelines,
  mockSlashCommands,
} from '@cozypad/test-fixtures';
import { ChatComposer } from './ChatComposer';
import { ChatTimeline } from './ChatTimeline';
import { LegacyAgyPanel } from './LegacyAgyPanel';
import { LegacyClaudePanel } from './LegacyClaudePanel';
import { LegacyCodexPanel } from './LegacyCodexPanel';
import { subscribeCodexTrainingTasks } from './codexTaskQueue';
import { listLegacyServers } from './legacySshApi';
import type { LegacySshServer } from './legacySshApi';
import { rememberLastSelectedLegacyServerId } from '../sshServerPreference';

const AGENTS: { kind: AgentKind; label: string }[] = [
  { kind: 'claude', label: 'Claude' },
  { kind: 'codex', label: 'Codex' },
  { kind: 'agy', label: 'agy' },
  { kind: 'bailian', label: 'baillian' },
];

const STATUS_LABEL: Record<AgentSessionStatus, string> = {
  starting: 'starting',
  ready: 'ready',
  running: 'running',
  waiting_approval: 'approval',
  disconnected: 'offline',
  exited: 'exited',
  error: 'error',
};

const MOCK_REPLIES: Record<AgentKind, string> = {
  claude:
    '（mock 回覆）收到。這裡還沒接上真正的 Claude adapter——Phase 2 會用 stream-json 事件取代這段假字。',
  codex:
    '（mock 回覆）了解。Codex adapter 會在 Phase 3 以 app-server / JSONL exec 接上。',
  agy: '（mock 回覆）agy adapter 尚未定義 protocol。',
  bailian: 'Mock reply: baillian adapter is not wired in mock mode yet.',
};

function formatTime(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function legacyServerTarget(server: LegacySshServer | null): string {
  if (!server) return '';
  if (server.source === 'system') return server.alias || server.name;
  if (server.source === 'ssh-config') return server.alias || server.name;
  return `${server.user ? `${server.user}@` : ''}${server.host}${server.port ? `:${server.port}` : ''}`;
}

function normalizeProfileToken(value: string | undefined): string {
  return String(value || '').trim().toLowerCase();
}

function isLoopbackHost(value: string | undefined): boolean {
  const host = normalizeProfileToken(value);
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function isLocalProfile(profile: ConnectionProfile): boolean {
  return (
    profile.id === 'mock-local' ||
    profile.id === 'system:localhost' ||
    normalizeProfileToken(profile.host) === 'mock.local' ||
    isLoopbackHost(profile.host)
  );
}

function sameHost(left: string | undefined, right: string | undefined): boolean {
  const leftHost = normalizeProfileToken(left);
  const rightHost = normalizeProfileToken(right);
  if (!leftHost || !rightHost) return false;
  if (isLoopbackHost(leftHost) && isLoopbackHost(rightHost)) return true;
  return leftHost === rightHost;
}

function profileMatchesLegacyServer(
  profile: ConnectionProfile,
  server: LegacySshServer,
): boolean {
  const profileId = normalizeProfileToken(profile.id);
  const profileName = normalizeProfileToken(profile.name);
  const serverTokens = [server.id, server.name, server.alias]
    .map(normalizeProfileToken)
    .filter(Boolean);

  if (serverTokens.includes(profileId) || serverTokens.includes(profileName)) {
    return true;
  }

  const profilePort = Number(profile.port || 22);
  const serverPort = Number(server.port || 22);
  const profileUser = normalizeProfileToken(profile.username);
  const serverUser = normalizeProfileToken(server.user);
  return sameHost(profile.host, server.host) && profilePort === serverPort && profileUser === serverUser;
}

function profileToLegacyServer(profile: ConnectionProfile | null): LegacySshServer | null {
  if (profile === null) return null;
  if (isLocalProfile(profile)) {
    return {
      id: 'system:localhost',
      source: 'system',
      name: profile.name || 'localhost',
      alias: profile.name || 'localhost',
      host: '127.0.0.1',
      user: profile.username,
      port: 0,
      defaultPath: '~',
      localOnly: true,
    };
  }

  return {
    id: profile.id,
    source: 'local',
    name: profile.name,
    alias: profile.name,
    host: profile.host,
    user: profile.username,
    port: profile.port || 22,
    defaultPath: '~',
  };
}

export function AgentsWorkspace({
  mockData,
  selectedProfile,
  connected,
  openTarget,
}: {
  mockData: boolean;
  selectedProfile: ConnectionProfile | null;
  connected: boolean;
  openTarget?: {
    agent: 'codex' | 'claude' | 'agy' | 'bailian';
    taskId: string;
    profileId: string;
    nonce: number;
  } | null;
}) {
  const [agent, setAgent] = useState<AgentKind>('claude');
  const [remoteServer, setRemoteServer] = useState<LegacySshServer | null>(null);
  const [sessions, setSessions] = useState<AgentSessionSummary[]>(
    mockData ? mockAgentSessions : [],
  );
  const [timelines, setTimelines] = useState<Record<string, ChatItem[]>>(
    mockData ? mockAgentTimelines : {},
  );
  const [selected, setSelected] = useState<Record<AgentKind, string | null>>(
    mockData
      ? { claude: 'claude-s1', codex: 'codex-s1', agy: null, bailian: null }
      : { claude: null, codex: null, agy: null, bailian: null },
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [filters, setFilters] = useState<Record<AgentKind, string>>({
    claude: '',
    codex: '',
    agy: '',
    bailian: '',
  });
  const [nextItemId, setNextItemId] = useState(1);
  const remoteServerTarget = legacyServerTarget(remoteServer);

  useEffect(
    () =>
      subscribeCodexTrainingTasks((detail) => {
        const queuedAgent = (detail?.task as { agent?: AgentKind } | undefined)?.agent;
        if (!queuedAgent) return;
        setAgent(queuedAgent);
      }),
    [],
  );

  useEffect(() => {
    if (openTarget) setAgent(openTarget.agent);
  }, [openTarget?.nonce]);

  useEffect(() => {
    const fallbackServer = profileToLegacyServer(selectedProfile);
    setRemoteServer(fallbackServer);
    if (!selectedProfile || !connected) return;

    let active = true;
    void listLegacyServers(false)
      .then((servers) => {
        if (!active) return;
        const matchedServer =
          servers.find((server) => server.id === selectedProfile.id) ??
          servers.find((server) => profileMatchesLegacyServer(selectedProfile, server)) ??
          fallbackServer;
        setRemoteServer(matchedServer);
        if (matchedServer?.id) rememberLastSelectedLegacyServerId(matchedServer.id);
      })
      .catch(() => {
        if (active) setRemoteServer(fallbackServer);
      });

    return () => {
      active = false;
    };
  }, [connected, selectedProfile]);

  const agentSessions = useMemo(
    () =>
      sessions
        .filter((session) => session.agentKind === agent)
        .filter((session) =>
          filters[agent] === ''
            ? true
            : `${session.title} ${session.host} ${session.project}`
                .toLowerCase()
                .includes(filters[agent].toLowerCase()),
        ),
    [sessions, agent, filters],
  );

  const selectedSessionId = selected[agent];
  const selectedSession =
    sessions.find((session) => session.id === selectedSessionId) ?? null;
  const timeline = selectedSessionId ? (timelines[selectedSessionId] ?? []) : [];

  const selectSession = (sessionId: string) => {
    setSelected((current) => ({ ...current, [agent]: sessionId }));
    setSessions((current) =>
      current.map((session) =>
        session.id === sessionId ? { ...session, unread: 0 } : session,
      ),
    );
  };

  const appendItems = (sessionId: string, items: ChatItem[]) => {
    setTimelines((current) => ({
      ...current,
      [sessionId]: [...(current[sessionId] ?? []), ...items],
    }));
  };

  const streamAssistant = (sessionId: string, reply: string) => {
    const assistantId = `local-a${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    appendItems(sessionId, [
      {
        kind: 'message',
        id: assistantId,
        role: 'assistant',
        text: '',
        streaming: true,
        timestamp: new Date().toISOString(),
      },
    ]);
    let cursor = 0;
    const interval = setInterval(() => {
      cursor = Math.min(cursor + 3, reply.length);
      const done = cursor >= reply.length;
      setTimelines((current) => ({
        ...current,
        [sessionId]: (current[sessionId] ?? []).map((item) =>
          item.id === assistantId && item.kind === 'message'
            ? { ...item, text: reply.slice(0, cursor), streaming: !done }
            : item,
        ),
      }));
      if (done) clearInterval(interval);
    }, 30);
  };

  const appendUserMessage = (sessionId: string, text: string) => {
    appendItems(sessionId, [
      {
        kind: 'message',
        id: `local-u${nextItemId}`,
        role: 'user',
        text,
        timestamp: new Date().toISOString(),
      },
    ]);
    setNextItemId((current) => current + 1);
  };

  const runSlashCommand = (sessionId: string, text: string) => {
    const name = text.slice(1).split(/\s+/)[0] ?? '';
    const known = mockSlashCommands[agent].find((command) => command.name === name);
    if (name === 'clear') {
      setTimelines((current) => ({ ...current, [sessionId]: [] }));
      return;
    }
    appendUserMessage(sessionId, text);
    if (name === 'help') {
      const list = mockSlashCommands[agent]
        .map((command) => `- \`/${command.name}\` — ${command.description}`)
        .join('\n');
      streamAssistant(sessionId, `可用指令：\n\n${list}`);
      return;
    }
    if (known) {
      streamAssistant(
        sessionId,
        `（mock）已執行 \`/${known.name}\`——真實行為將由 ${agent} adapter 提供（Phase 2+）。`,
      );
      return;
    }
    streamAssistant(sessionId, `未知指令 \`/${name}\`，輸入 \`/help\` 查看可用指令。`);
  };

  const sendMessage = (text: string) => {
    if (!selectedSessionId) return;
    const sessionId = selectedSessionId;
    setDrafts((current) => ({ ...current, [sessionId]: '' }));
    if (text.startsWith('/')) {
      runSlashCommand(sessionId, text);
      return;
    }
    appendUserMessage(sessionId, text);
    streamAssistant(sessionId, MOCK_REPLIES[agent]);
  };

  const createRemoteSession = () => {
    if (!remoteServer || agent === 'codex') return;
    const now = new Date().toISOString();
    const agentLabel = AGENTS.find((entry) => entry.kind === agent)?.label ?? agent;
    const id = `${agent}:${remoteServer.id}:${Date.now().toString(36)}`;
    const cwd = remoteServer.defaultPath || '~';
    const session: AgentSessionSummary = {
      id,
      agentKind: agent,
      title: `${agentLabel} · ${remoteServer.name}`,
      host: remoteServer.name,
      project: cwd,
      cwd,
      status: 'ready',
      unread: 0,
      updatedAt: now,
    };
    setSessions((current) => [session, ...current]);
    setTimelines((current) => ({
      ...current,
      [id]: [
        {
          kind: 'message',
          id: `${id}:system`,
          role: 'assistant',
          text:
            `${agentLabel} session 已綁定遠端 SSH server：${remoteServer.name}` +
            `${remoteServerTarget ? ` (${remoteServerTarget})` : ''}。\n` +
            '目前 UI 已準備好遠端 context；正式 Claude adapter 接上後會在這台 server 執行。',
          timestamp: now,
        },
      ],
    }));
    setSelected((current) => ({ ...current, [agent]: id }));
  };

  const answerQuestion = (itemId: string, optionIndex: number) => {
    if (!selectedSessionId) return;
    const sessionId = selectedSessionId;
    let chosenLabel: string | null = null;
    setTimelines((current) => ({
      ...current,
      [sessionId]: (current[sessionId] ?? []).map((item) => {
        if (item.id === itemId && item.kind === 'question') {
          chosenLabel = item.options[optionIndex]?.label ?? null;
          return { ...item, selectedIndex: optionIndex };
        }
        return item;
      }),
    }));
    setTimeout(() => {
      if (chosenLabel !== null) {
        appendUserMessage(sessionId, chosenLabel);
        streamAssistant(
          sessionId,
          `好，採用 **${chosenLabel}**。（mock）我會照這個方向繼續——真實 agent 會由 adapter 把選擇回傳（Phase 2+）。`,
        );
      }
    }, 0);
  };

  const resolveApproval = (itemId: string, resolution: 'allowed' | 'denied') => {
    if (!selectedSessionId) return;
    const sessionId = selectedSessionId;
    setTimelines((current) => ({
      ...current,
      [sessionId]: (current[sessionId] ?? []).map((item) =>
        item.id === itemId && item.kind === 'approval' ? { ...item, resolution } : item,
      ),
    }));
    setSessions((current) =>
      current.map((session) =>
        session.id === sessionId
          ? { ...session, status: resolution === 'allowed' ? 'running' : 'ready' }
          : session,
      ),
    );
  };

  const diffPaths = timeline
    .filter((item): item is Extract<ChatItem, { kind: 'file_diff' }> => item.kind === 'file_diff')
    .map((item) => item.path);
  const usage = timeline
    .filter((item): item is Extract<ChatItem, { kind: 'usage' }> => item.kind === 'usage')
    .reduce(
      (sum, item) => ({
        input: sum.input + item.inputTokens,
        output: sum.output + item.outputTokens,
      }),
      { input: 0, output: 0 },
    );

  return (
    <div className="agents-workspace">
      <div className="agent-tabs">
        {AGENTS.map(({ kind, label }) => (
          <button
            key={kind}
            className={`agent-tab${agent === kind ? ' agent-tab-active' : ''}`}
            onClick={() => setAgent(kind)}
          >
            {label}
          </button>
        ))}
        <button className="agent-tab agent-tab-disabled" title="Custom adapters：Phase 5 adapter SDK">
          ＋
        </button>
      </div>

      {agent === 'codex' ? (
        <LegacyCodexPanel
          selectedProfile={selectedProfile}
          connected={connected}
          legacyServer={remoteServer}
          focusTaskId={openTarget?.agent === 'codex' ? openTarget.taskId : ''}
          focusRequestNonce={openTarget?.agent === 'codex' ? openTarget.nonce : 0}
        />
      ) : agent === 'claude' ? (
        <LegacyClaudePanel
          legacyServer={remoteServer}
          connected={connected}
          focusTaskId={openTarget?.agent === 'claude' ? openTarget.taskId : ''}
          focusRequestNonce={openTarget?.agent === 'claude' ? openTarget.nonce : 0}
        />
      ) : agent === 'agy' ? (
        <LegacyAgyPanel
          key="legacy-agent-agy"
          agentName="agy"
          legacyServer={remoteServer}
          connected={connected}
          focusTaskId={openTarget?.agent === 'agy' ? openTarget.taskId : ''}
          focusRequestNonce={openTarget?.agent === 'agy' ? openTarget.nonce : 0}
        />
      ) : agent === 'bailian' ? (
        <LegacyAgyPanel
          key="legacy-agent-bailian"
          agentName="bailian"
          legacyServer={remoteServer}
          connected={connected}
          focusTaskId={openTarget?.agent === 'bailian' ? openTarget.taskId : ''}
          focusRequestNonce={openTarget?.agent === 'bailian' ? openTarget.nonce : 0}
        />
      ) : mockAgentInstallState[agent] === 'not_detected' ? (
        <div className="agent-setup">
          <h2>{agent} 尚未偵測到</h2>
          <p>遠端主機上找不到 {agent} 可執行檔。安裝後 CozyPad 會自動偵測版本與能力。</p>
        </div>
      ) : (
        <div className="agent-panes">
          <aside className="session-sidebar">
            <input
              className="session-filter"
              placeholder="搜尋 sessions…"
              value={filters[agent]}
              onChange={(event) =>
                setFilters((current) => ({ ...current, [agent]: event.target.value }))
              }
            />
            <div className="session-list">
              {agentSessions.map((session) => (
                <button
                  key={session.id}
                  className={`session-item${
                    session.id === selectedSessionId ? ' session-item-active' : ''
                  }`}
                  onClick={() => selectSession(session.id)}
                >
                  <span className="session-title">{session.title}</span>
                  <span className="session-meta">
                    {session.host} · {session.project}
                  </span>
                  <span className="session-footer">
                    <span className={`chip chip-${session.status}`}>
                      {STATUS_LABEL[session.status]}
                    </span>
                    {session.unread > 0 ? (
                      <span className="unread">{session.unread}</span>
                    ) : null}
                    <span className="session-time">{formatTime(session.updatedAt)}</span>
                  </span>
                </button>
              ))}
              {agentSessions.length === 0 ? (
                <p className="hint session-empty">沒有符合的 session。</p>
              ) : null}
            </div>
            <button
              className="session-new"
              onClick={createRemoteSession}
              disabled={!remoteServer || !connected}
              title={
                remoteServer && connected
                  ? '建立綁定目前 SSH server 的 agent session'
                  : '請先選擇 SSH server'
              }
            >
              ＋ New session
            </button>
          </aside>

          <div className="chat-column">
            {selectedSession ? (
              <>
                <ChatTimeline
                  sessionId={selectedSession.id}
                  items={timeline}
                  onResolveApproval={resolveApproval}
                  onAnswerQuestion={answerQuestion}
                />
                <ChatComposer
                  agentLabel={AGENTS.find((entry) => entry.kind === agent)?.label ?? agent}
                  value={drafts[selectedSession.id] ?? ''}
                  commands={mockSlashCommands[agent]}
                  onChange={(value) =>
                    setDrafts((current) => ({ ...current, [selectedSession.id]: value }))
                  }
                  onSend={sendMessage}
                />
              </>
            ) : (
              <div className="placeholder">
                <p>選一個 session 開始。</p>
              </div>
            )}
          </div>

          <aside className="context-panel">
            {selectedSession ? (
              <>
                <h3>Context</h3>
                <dl>
                  <dt>Host</dt>
                  <dd>{remoteServer?.name || selectedSession.host}</dd>
                  <dt>Target</dt>
                  <dd>{remoteServerTarget || selectedSession.host}</dd>
                  <dt>Project</dt>
                  <dd>{selectedSession.project}</dd>
                  <dt>cwd</dt>
                  <dd className="mono">{selectedSession.cwd}</dd>
                  <dt>Status</dt>
                  <dd>
                    <span className={`chip chip-${selectedSession.status}`}>
                      {STATUS_LABEL[selectedSession.status]}
                    </span>
                  </dd>
                  <dt>tmux</dt>
                  <dd className="mono">sdh_{selectedSession.id.replace('-', '_')}</dd>
                </dl>
                <h3>Changed files</h3>
                {diffPaths.length > 0 ? (
                  <ul className="changed-files">
                    {diffPaths.map((path) => (
                      <li key={path} className="mono">
                        {path}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="hint">尚無變更。</p>
                )}
                <h3>Usage</h3>
                {usage.input + usage.output > 0 ? (
                  <p className="hint">
                    in {usage.input.toLocaleString()} / out {usage.output.toLocaleString()}{' '}
                    tokens
                  </p>
                ) : (
                  <p className="hint">此對話尚無 usage 事件。</p>
                )}
              </>
            ) : null}
          </aside>
        </div>
      )}
    </div>
  );
}
