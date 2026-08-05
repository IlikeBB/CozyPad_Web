import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  isLegacyAuthError,
  listLegacyServers,
} from './agents/legacySshApi';
import type { LegacySshServer } from './agents/legacySshApi';
import {
  readLastSelectedLegacyServerId,
  rememberLastSelectedLegacyServerId,
  resolveLastSelectedLegacyServerId,
  subscribeLastSelectedLegacyServerId,
} from './sshServerPreference';

interface MonitorWorkspaceProps {
  active: boolean;
  connected: boolean;
  host: string | null;
  selectedServerId?: string | null;
}

type MonitorMetrics = {
  hostname: string;
  kernel: string;
  cpuPercent: number;
  memoryPercent: number;
  memoryTotalKb: number;
  memoryAvailableKb: number;
  diskPercent: number;
  diskTotalKb: number;
  diskUsedKb: number;
  disks?: MonitorDisk[];
  load1: number;
  load5: number;
  load15: number;
  uptimeSeconds: number;
  processCount: number;
  gpuPercent: number | null;
  gpuMemoryPercent: number | null;
  gpuTemperatureC: number | null;
  gpuCount: number;
  gpus?: MonitorGpu[];
};

type MonitorDisk = {
  name: string;
  mount: string;
  fsType: string;
  totalKb: number;
  usedKb: number;
  availableKb: number;
  percent: number;
};

type MonitorGpu = {
  index: number;
  name: string;
  gpuPercent: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
  memoryPercent: number | null;
  temperatureC: number | null;
  powerDrawW: number | null;
  powerLimitW: number | null;
};

type MonitorServer = {
  id: string;
  name: string;
  source: 'client' | 'system' | 'local' | 'ssh-config' | string;
  target: string;
  online: boolean;
  checkedAt: string;
  latencyMs: number;
  localOnly?: boolean;
  monitorBlocked?: boolean;
  monitorConnecting?: boolean;
  blockedAt?: string;
  error?: string;
  metrics?: MonitorMetrics;
};

type MonitorSnapshot = {
  type: 'snapshot';
  generatedAt: string;
  intervalMs: number;
  totals: {
    total: number;
    online: number;
    offline: number;
    blocked?: number;
  };
  servers: MonitorServer[];
};

type MonitorConnectionState = 'connecting' | 'live' | 'offline';
type MonitorScope = 'selected' | 'all';
type MonitorDrawerServer = {
  id: string;
  name: string;
  source: MonitorServer['source'];
  target: string;
  online?: boolean;
  monitorBlocked?: boolean;
  monitorConnecting?: boolean;
  error?: string;
  metrics?: MonitorMetrics;
};

function isMonitorSnapshot(value: unknown): value is MonitorSnapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'snapshot' &&
    Array.isArray((value as { servers?: unknown }).servers)
  );
}

function isDisplayServer(server: MonitorServer) {
  return server.source === 'system' || server.source === 'local' || server.source === 'ssh-config';
}

function isDisplayLegacyServer(server: LegacySshServer) {
  return server.source === 'system' || server.source === 'local' || server.source === 'ssh-config';
}

function legacyServerTarget(server: LegacySshServer) {
  if (server.source === 'system' || server.source === 'ssh-config') {
    return server.alias || server.name;
  }

  const user = server.user ? `${server.user}@` : '';
  const port = server.port ? `:${server.port}` : '';
  return `${user}${server.host}${port}`;
}

function resolveMonitorServerId(
  servers: LegacySshServer[],
  preferredId: string | null | undefined,
  currentId = '',
) {
  if (preferredId && servers.some((server) => server.id === preferredId)) {
    return preferredId;
  }

  const remembered = resolveLastSelectedLegacyServerId(servers, currentId);
  if (remembered) {
    return remembered;
  }

  const remoteServer = servers.find((server) => !server.localOnly && server.source !== 'system');
  return remoteServer?.id || servers[0]?.id || '';
}

function mergeDrawerServers(
  availableServers: LegacySshServer[],
  monitoredServers: MonitorServer[],
): MonitorDrawerServer[] {
  const monitoredById = new Map(monitoredServers.map((server) => [server.id, server]));
  return availableServers.filter(isDisplayLegacyServer).map((server) => {
    const monitored = monitoredById.get(server.id);
    if (monitored) {
      return monitored;
    }

    return {
      id: server.id,
      name: server.name,
      source: server.source,
      target: legacyServerTarget(server),
      online: false,
    };
  });
}

function monitorDrawerStateLabel(server: MonitorDrawerServer) {
  if (server.monitorBlocked) return 'paused';
  if (server.monitorConnecting) return 'connecting';
  if (server.online) return 'live';
  if (server.error) return 'offline';
  return 'idle';
}

function formatPercent(value: number | null | undefined) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }

  const number = Number(value);
  return `${number.toFixed(number >= 10 ? 0 : 1)}%`;
}

function clampPercent(value: number | null | undefined) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Number(value)));
}

function formatDataFromKb(value: number | null | undefined) {
  if (!Number.isFinite(value) || Number(value) <= 0) {
    return 'n/a';
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = Number(value);
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
}

function formatDataFromMb(value: number | null | undefined) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }

  return formatDataFromKb(Number(value) * 1024);
}

function formatOptionalNumber(value: number | null | undefined, suffix: string) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }

  const number = Number(value);
  return `${number.toFixed(number >= 10 ? 0 : 1)}${suffix}`;
}

function formatUptime(seconds: number | null | undefined) {
  if (!Number.isFinite(seconds) || Number(seconds) <= 0) {
    return 'n/a';
  }

  const totalSeconds = Number(seconds);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
}

function formatClock(value: string | null | undefined) {
  if (!value) {
    return 'n/a';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'n/a';
  }

  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function getDisplayDisks(metrics: MonitorMetrics): MonitorDisk[] {
  if (metrics.disks?.length) {
    return metrics.disks;
  }

  if (metrics.diskTotalKb <= 0) {
    return [];
  }

  return [
    {
      name: 'disk',
      mount: '',
      fsType: '',
      totalKb: metrics.diskTotalKb,
      usedKb: metrics.diskUsedKb,
      availableKb: Math.max(metrics.diskTotalKb - metrics.diskUsedKb, 0),
      percent: metrics.diskPercent,
    },
  ];
}

function formatDiskLabel(disk: MonitorDisk) {
  const primary = disk.mount || disk.name || 'disk';
  if (!disk.name || disk.name === primary) {
    return primary;
  }

  return `${primary} - ${disk.name}`;
}

function UsageBar({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | null | undefined;
  tone?: 'warn' | 'hot' | 'gpu';
}) {
  return (
    <div className="server-usage-bar">
      <div>
        <span>{label}</span>
        <strong>{formatPercent(value)}</strong>
      </div>
      <i aria-hidden="true">
        <span
          className={
            tone === 'hot' ? 'usage-hot' : tone === 'warn' ? 'usage-warn' : tone === 'gpu' ? 'usage-gpu' : undefined
          }
          style={{ width: `${clampPercent(value)}%` }}
        />
      </i>
    </div>
  );
}

function DiskUsageList({ disks }: { disks: MonitorDisk[] }) {
  if (!disks.length) {
    return <div className="monitor-panel-empty">No disk data</div>;
  }

  return (
    <div className="server-disk-list" aria-label="Disk usage">
      {disks.map((disk) => (
        <div className="server-disk-row" key={`${disk.name}-${disk.mount}`}>
          <div>
            <span>{formatDiskLabel(disk)}</span>
            <strong>{formatPercent(disk.percent)}</strong>
          </div>
          <i aria-hidden="true">
            <span style={{ width: `${clampPercent(disk.percent)}%` }} />
          </i>
          <small>
            {formatDataFromKb(disk.usedKb)} / {formatDataFromKb(disk.totalKb)}
            {disk.fsType ? ` - ${disk.fsType}` : ''}
          </small>
        </div>
      ))}
    </div>
  );
}

function GpuUsageList({ gpus }: { gpus: MonitorGpu[] }) {
  if (!gpus.length) {
    return <div className="monitor-panel-empty">No GPU detected</div>;
  }

  return (
    <div className="server-gpu-list" aria-label="GPU usage">
      {gpus.map((gpu) => (
        <article className="server-gpu-card" key={`${gpu.index}-${gpu.name}`}>
          <div className="server-gpu-heading">
            <span>
              GPU{gpu.index} - {gpu.name || 'GPU'}
            </span>
            <strong>{formatPercent(gpu.gpuPercent)}</strong>
          </div>
          <i aria-hidden="true">
            <span style={{ width: `${clampPercent(gpu.gpuPercent)}%` }} />
          </i>
          <div className="server-gpu-meta">
            <span>
              mem {formatDataFromMb(gpu.memoryUsedMb)} / {formatDataFromMb(gpu.memoryTotalMb)}
            </span>
            <span>vram {formatPercent(gpu.memoryPercent)}</span>
            <span>temp {formatOptionalNumber(gpu.temperatureC, 'C')}</span>
            <span>
              power {formatOptionalNumber(gpu.powerDrawW, 'W')}
              {Number.isFinite(gpu.powerLimitW)
                ? ` / ${formatOptionalNumber(gpu.powerLimitW, 'W')}`
                : ''}
            </span>
          </div>
        </article>
      ))}
    </div>
  );
}

function MonitorMachinePage({ server }: { server: MonitorServer }) {
  const metrics = server.metrics;

  if (!server.online) {
    return (
      <div className="server-usage-empty">
        <span>
          {server.monitorConnecting
            ? `Opening monitor stream for ${server.name}`
            : server.error || `${server.name} is offline`}
        </span>
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="server-usage-empty">
        <span>{server.name} is online, but no monitor metrics are available yet.</span>
      </div>
    );
  }

  const disks = getDisplayDisks(metrics);
  const memoryUsedKb = Math.max(metrics.memoryTotalKb - metrics.memoryAvailableKb, 0);

  return (
    <article className="monitor-machine-page">
      <section className="monitor-machine-summary" aria-label="Machine summary">
        <header>
          <span>{server.source === 'ssh-config' ? 'SSH config' : 'CozyPad server'}</span>
          <h3>{server.name}</h3>
          <p>{metrics.hostname || server.target}</p>
        </header>

        <div className="monitor-machine-meta">
          <span>latency {Math.round(server.latencyMs)}ms</span>
          <span>load {metrics.load1.toFixed(2)}</span>
          <span>uptime {formatUptime(metrics.uptimeSeconds)}</span>
          <span>process {metrics.processCount}</span>
          <span>kernel {metrics.kernel || 'n/a'}</span>
          <span>checked {formatClock(server.checkedAt)}</span>
        </div>

        <div className="server-usage-bars">
          <UsageBar label="CPU" value={metrics.cpuPercent} />
          <UsageBar label="RAM" value={metrics.memoryPercent} tone="warn" />
          <UsageBar label="Disk" value={metrics.diskPercent} tone="warn" />
          <UsageBar label="GPU" value={metrics.gpuPercent} tone="gpu" />
        </div>

        <div className="monitor-machine-facts">
          <div>
            <span>RAM</span>
            <strong>
              {formatDataFromKb(memoryUsedKb)} / {formatDataFromKb(metrics.memoryTotalKb)}
            </strong>
          </div>
          <div>
            <span>Disk total</span>
            <strong>
              {formatDataFromKb(metrics.diskUsedKb)} / {formatDataFromKb(metrics.diskTotalKb)}
            </strong>
          </div>
          <div>
            <span>GPU count</span>
            <strong>{metrics.gpuCount}</strong>
          </div>
        </div>
      </section>

      <section className="monitor-machine-gpu" aria-label="GPU status">
        <div className="monitor-panel-heading">
          <span>Center</span>
          <h3>GPU</h3>
        </div>
        <GpuUsageList gpus={metrics.gpus || []} />
      </section>

      <section className="monitor-machine-disks" aria-label="Disk status">
        <div className="monitor-panel-heading">
          <span>Right</span>
          <h3>Disk status</h3>
        </div>
        <DiskUsageList disks={disks} />
      </section>
    </article>
  );
}

function MonitorServerDrawer({
  servers,
  selectedServerId,
  scope,
  onSelectServer,
}: {
  servers: MonitorDrawerServer[];
  selectedServerId: string;
  scope: MonitorScope;
  onSelectServer: (serverId: string) => void;
}) {
  return (
    <aside className="monitor-server-drawer" tabIndex={0} aria-label="Monitor target drawer">
      <div className="monitor-drawer-handle">
        <span>Servers</span>
      </div>
      <div className="monitor-drawer-panel">
        <header>
          <span>{scope === 'all' ? 'all targets' : 'target list'}</span>
          <strong>{servers.length} servers</strong>
        </header>
        <div className="monitor-drawer-list">
          {servers.map((server) => {
            const state = monitorDrawerStateLabel(server);
            return (
            <button
              type="button"
              key={server.id}
              className={`${server.id === selectedServerId && scope === 'selected' ? 'monitor-drawer-active' : ''} monitor-drawer-${state}`}
              onClick={() => onSelectServer(server.id)}
            >
              <span>
                <strong>{server.name}</strong>
                <i>{state}</i>
              </span>
              <small>{server.metrics?.hostname || server.target}</small>
            </button>
            );
          })}
          {!servers.length ? (
            <div className="monitor-panel-empty">No server target</div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

export function MonitorWorkspace({
  active,
  connected,
  host,
  selectedServerId: selectedProfileServerId,
}: MonitorWorkspaceProps) {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [monitorState, setMonitorState] = useState<MonitorConnectionState>('offline');
  const [monitorError, setMonitorError] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [scope, setScope] = useState<MonitorScope>('selected');
  const [availableServers, setAvailableServers] = useState<LegacySshServer[]>([]);
  const [serverLoading, setServerLoading] = useState(false);
  const [serverError, setServerError] = useState('');
  const [selectedServerId, setSelectedServerId] = useState(() => readLastSelectedLegacyServerId());

  const loadServers = useCallback(
    async (refresh = false) => {
      setServerLoading(true);
      setServerError('');
      try {
        const nextServers = await listLegacyServers(refresh);
        setAvailableServers(nextServers);
        setSelectedServerId((current) =>
          resolveMonitorServerId(nextServers, selectedProfileServerId, current),
        );
      } catch (error) {
        if (isLegacyAuthError(error)) {
          setServerError('Please sign in to CozyPad before opening the monitor.');
        } else {
          setServerError(error instanceof Error ? error.message : 'SSH server list failed.');
        }
      } finally {
        setServerLoading(false);
      }
    },
    [selectedProfileServerId],
  );

  useEffect(() => {
    if (!connected || !active) {
      setEnabled(false);
      setMonitorState('offline');
      setMonitorError('');

      if (!active) {
        setScope('selected');
      }

      if (!connected) {
        setSnapshot(null);
        setSelectedServerId('');
      }
      return;
    }

    void loadServers(false);
  }, [active, connected, loadServers]);

  useEffect(
    () =>
      subscribeLastSelectedLegacyServerId((serverId) => {
        if (!serverId || !availableServers.some((server) => server.id === serverId)) return;
        setSelectedServerId(serverId);
      }),
    [availableServers],
  );

  useEffect(() => {
    if (!selectedProfileServerId || !availableServers.some((server) => server.id === selectedProfileServerId)) {
      return;
    }

    setSelectedServerId(selectedProfileServerId);
  }, [availableServers, selectedProfileServerId]);

  useEffect(() => {
    if (scope !== 'selected') {
      setScope('selected');
    }
  }, [scope]);

  useEffect(() => {
    if (!connected || !active) {
      setEnabled(false);
      return;
    }

    if (scope === 'selected' && !selectedServerId) {
      setEnabled(false);
    }
  }, [active, connected, scope, selectedServerId]);

  useEffect(() => {
    if (!enabled) {
      setMonitorState('offline');
      setMonitorError('');
      return undefined;
    }

    let closedByEffect = false;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams();

    if (selectedServerId) {
      params.set('serverId', selectedServerId);
    }
    const query = params.toString();
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/api/ssh/monitor${query ? `?${query}` : ''}`,
    );
    let socketOpened = false;

    setMonitorState('connecting');
    setMonitorError('');

    socket.addEventListener('open', () => {
      socketOpened = true;
      if (!closedByEffect) {
        setMonitorState('live');
      }
    });

    socket.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(String(event.data)) as unknown;
        if (
          typeof data === 'object' &&
          data !== null &&
          'error' in data &&
          typeof (data as { error?: unknown }).error === 'string'
        ) {
          setMonitorError((data as { error: string }).error);
          return;
        }

        if (!isMonitorSnapshot(data)) {
          setMonitorError('Invalid live monitor payload.');
          return;
        }

        setSnapshot(data);
        setMonitorState('live');
        setMonitorError('');
      } catch {
        setMonitorError('Invalid live monitor payload.');
      }
    });

    socket.addEventListener('close', () => {
      if (!closedByEffect) {
        setMonitorState('offline');
      }
    });

    socket.addEventListener('error', () => {
      if (!closedByEffect) {
        setMonitorState('offline');
        setMonitorError('Live monitor connection failed.');
      }
    });

    return () => {
      closedByEffect = true;
      socket.close();
    };
  }, [enabled, scope, selectedServerId]);

  const servers = useMemo(
    () => (snapshot?.servers ?? []).filter(isDisplayServer),
    [snapshot],
  );
  const onlineServers = useMemo(
    () => servers.filter((server) => server.online),
    [servers],
  );
  const monitoredById = useMemo(() => new Map(servers.map((server) => [server.id, server])), [servers]);
  const drawerServers = useMemo(
    () => mergeDrawerServers(availableServers, servers),
    [availableServers, servers],
  );
  const selectedServer =
    monitoredById.get(selectedServerId) ?? onlineServers[0] ?? servers[0] ?? null;

  useEffect(() => {
    if (!availableServers.length) {
      if (selectedServerId) setSelectedServerId('');
      return;
    }

    if (!availableServers.some((server) => server.id === selectedServerId)) {
      setSelectedServerId(resolveMonitorServerId(availableServers, selectedProfileServerId));
    }
  }, [availableServers, selectedProfileServerId, selectedServerId]);

  const offlineServers = servers.filter((server) => !server.online && !server.monitorBlocked).length;
  const blockedServers = servers.filter((server) => server.monitorBlocked).length;

  const handleSelectServer = (serverId: string) => {
    setScope('selected');
    setSelectedServerId(serverId);
    rememberLastSelectedLegacyServerId(serverId);
  };

  return (
    <div className="monitor-workspace">
      <section className="system-preview monitor-single-preview" aria-labelledby="monitor-title">
        <header className="system-hero">
          <div>
            <p className="module-eyebrow">SSH live monitor</p>
            <h2 id="monitor-title">device Monitor</h2>
            <p>{selectedServer?.name || host || 'Select a server target'}</p>
          </div>
          <div className="system-hero-actions">
            <button
              type="button"
              className="monitor-action-button"
              onClick={() => setEnabled((current) => !current)}
              disabled={!connected || !selectedServerId}
            >
              {enabled ? 'Pause' : 'Resume'}
            </button>
            <button
              type="button"
              className="monitor-action-button"
              onClick={() => void loadServers(true)}
              disabled={!active || serverLoading}
            >
              {serverLoading ? 'Refreshing' : 'Refresh'}
            </button>
            <div
              className={`system-hero-status system-hero-status-${monitorState}`}
              aria-label="Monitor connection state"
            >
              <span>{monitorState === 'live' ? 'real time' : monitorState}</span>
            </div>
          </div>
        </header>

        <div className="connection-strip">
          <span>{availableServers.length} SSH servers</span>
          <span>{servers.length} monitored</span>
          <span>{onlineServers.length} online</span>
          <span>{offlineServers} offline</span>
          <span>{blockedServers} paused</span>
          <span>last refresh {formatClock(snapshot?.generatedAt)}</span>
          <span>interval {(snapshot?.intervalMs ?? 30000) / 1000}s</span>
          <span>{enabled ? 'selected monitor' : 'monitor idle'}</span>
          {connected && host ? <span>selected {host}</span> : null}
        </div>

        {serverError ? (
          <div className="system-monitor-error" role="status">
            {serverError}
          </div>
        ) : null}

        {monitorError ? (
          <div className="system-monitor-error" role="status">
            {monitorError}
          </div>
        ) : null}

        <div className="monitor-machine-stage" aria-live="polite">
          {selectedServer ? (
            <MonitorMachinePage server={selectedServer} />
          ) : (
            <div className="server-usage-empty">
              <span>{monitorState === 'connecting' ? 'Loading live monitor data' : 'No online server'}</span>
            </div>
          )}
        </div>
      </section>

      <MonitorServerDrawer
        servers={drawerServers}
        selectedServerId={selectedServerId}
        scope={scope}
        onSelectServer={handleSelectServer}
      />
    </div>
  );
}
