import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getLegacyPublicWorkflowStatus,
  startLegacyPublicWorkflow,
} from './agents/legacySshApi';
import type {
  LegacyPublicWorkflowStartResponse,
  LegacyPublicWorkflowStatus,
} from './agents/legacySshApi';

type StatusState = 'online' | 'blocked' | 'warning' | 'offline' | 'unknown';

function formatCheckedAt(value: string | undefined) {
  if (!value) return '尚未檢查';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function StatusCard({
  title,
  value,
  detail,
  state,
}: {
  title: string;
  value: string;
  detail: string;
  state: StatusState;
}) {
  return (
    <article className="public-status-card" data-state={state}>
      <div className="public-status-topline">
        <span>{title}</span>
        <span className="public-status-dot" />
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function publicSiteLabel(status: LegacyPublicWorkflowStatus) {
  if (status.publicSite.securityBlocked) return 'Cloudflare 安全層阻擋';
  if (status.publicSite.reachable) return '可連線';
  if (status.publicSite.status > 0) return `HTTP ${status.publicSite.status}`;
  return '無法連線';
}

function publicSiteState(status: LegacyPublicWorkflowStatus): StatusState {
  if (status.publicSite.securityBlocked) return 'blocked';
  if (status.publicSite.reachable) return 'online';
  if (status.publicSite.status >= 500) return 'offline';
  return 'warning';
}

export function PublicWorkspace() {
  const [status, setStatus] = useState<LegacyPublicWorkflowStatus | null>(null);
  const [lastResult, setLastResult] = useState<LegacyPublicWorkflowStartResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await getLegacyPublicWorkflowStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Public status failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const runRepair = useCallback(
    async (restartTunnel: boolean) => {
      setRepairing(true);
      setError(null);
      try {
        const result = await startLegacyPublicWorkflow(restartTunnel);
        setLastResult(result);
        setStatus(result.status);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Public repair failed');
      } finally {
        setRepairing(false);
      }
    },
    [],
  );

  const cards = useMemo(() => {
    if (!status) return [];
    return [
      {
        title: 'CozyPad API',
        value: status.api.online ? 'online' : 'offline',
        detail: `port ${status.api.port}`,
        state: status.api.online ? 'online' : 'offline',
      },
      {
        title: 'Web origin',
        value: status.origin.online ? 'online' : 'offline',
        detail: `${status.originUrl} · ${status.origin.status || status.origin.statusText}`,
        state: status.origin.online ? 'online' : 'offline',
      },
      {
        title: 'Cloudflare Tunnel',
        value: status.tunnel.running ? 'running' : 'stopped',
        detail: `${status.protocol} · ${status.tunnel.count} connector`,
        state: status.tunnel.running ? 'online' : 'offline',
      },
      {
        title: 'Public URL',
        value: publicSiteLabel(status),
        detail: `${status.publicUrl} · HTTP ${status.publicSite.status || 0}`,
        state: publicSiteState(status),
      },
    ] satisfies Array<{
      title: string;
      value: string;
      detail: string;
      state: StatusState;
    }>;
  }, [status]);

  return (
    <div className="public-workspace">
      <header className="public-header">
        <div>
          <p className="workspace-kicker">Public workflow</p>
          <h1>CozyPad 對外站點維護</h1>
          <p>
            固定保存 cozypad.modoubletw.com 的啟動與修復流程：API、Web origin、Cloudflare
            Tunnel 與公開網址會分層檢查。
          </p>
        </div>
        <div className="public-actions">
          <button type="button" onClick={() => void loadStatus()} disabled={loading || repairing}>
            {loading ? '檢查中' : 'Refresh'}
          </button>
          <button type="button" onClick={() => void runRepair(false)} disabled={repairing}>
            {repairing ? '修復中' : 'Start / Repair'}
          </button>
          <button type="button" onClick={() => void runRepair(true)} disabled={repairing}>
            Restart tunnel
          </button>
        </div>
      </header>

      {error ? <div className="public-error">{error}</div> : null}

      <section className="public-status-grid">
        {cards.length > 0 ? (
          cards.map((card) => <StatusCard key={card.title} {...card} />)
        ) : (
          <div className="public-empty">尚未取得狀態</div>
        )}
      </section>

      <section className="public-layout">
        <div className="public-panel public-workflow">
          <div className="public-panel-heading">
            <h2>固定工作流程</h2>
            <span>{status ? formatCheckedAt(status.checkedAt) : '未檢查'}</span>
          </div>
          <ol>
            <li>確認 CozyPad API 已在背景啟動。</li>
            <li>確認 Vite Web origin 可由 localhost 存取。</li>
            <li>使用既有 Cloudflare Tunnel credential 啟動 connector。</li>
            <li>固定使用 HTTP/2，避開 QUIC 連接埠被阻擋造成的 tunnel 失敗。</li>
            <li>確認 Cloudflare Tunnel 有 active connector。</li>
            <li>檢查公開網址；若回傳 403，代表 tunnel 已通，但被 Cloudflare 安全規則阻擋。</li>
          </ol>
        </div>

        <div className="public-panel">
          <div className="public-panel-heading">
            <h2>目前判定</h2>
            <span>{lastResult ? (lastResult.ok ? '修復完成' : '需要檢查') : '等待操作'}</span>
          </div>
          <div className="public-diagnosis">
            {status ? (
              <>
                <p>
                  {status.origin.online && status.tunnel.running
                    ? 'Origin 與 tunnel 目前可用。'
                    : 'Origin 或 tunnel 尚未完整啟動，請按 Start / Repair。'}
                </p>
                <p>
                  {status.publicSite.securityBlocked
                    ? '公開網址目前被 Cloudflare 安全層阻擋，這通常不是 1033 tunnel 問題。'
                    : `公開網址狀態：${publicSiteLabel(status)}。`}
                </p>
              </>
            ) : (
              <p>按 Refresh 取得目前狀態。</p>
            )}
          </div>
          {lastResult?.stderr || lastResult?.stdout || lastResult?.error ? (
            <pre className="public-log">
              {[lastResult.error, lastResult.stderr, lastResult.stdout].filter(Boolean).join('\n')}
            </pre>
          ) : null}
        </div>
      </section>
    </div>
  );
}
