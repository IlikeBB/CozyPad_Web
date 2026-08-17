import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  deleteWorkRun,
  formatWorkDate,
  readWorkRuns,
  WORK_REFRESH_EVENT,
  currentWorkStorageKeys,
  type WorkRun,
} from './workRuns';
import { CODEX_TASK_QUEUE_EVENT } from './agents/codexTaskQueue';

export function WorkWorkspace({
  active = false,
  onOpenRun,
}: {
  active?: boolean;
  onOpenRun?: (run: WorkRun) => void;
}) {
  const [runs, setRuns] = useState(() => readWorkRuns());
  const [lastRefresh, setLastRefresh] = useState(() => new Date());

  const refreshRuns = useCallback(() => {
    setRuns(readWorkRuns());
    setLastRefresh(new Date());
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || currentWorkStorageKeys().some((key) => key === event.key)) {
        refreshRuns();
      }
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener(WORK_REFRESH_EVENT, refreshRuns);
    window.addEventListener(CODEX_TASK_QUEUE_EVENT, refreshRuns);
    window.addEventListener('focus', refreshRuns);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(WORK_REFRESH_EVENT, refreshRuns);
      window.removeEventListener(CODEX_TASK_QUEUE_EVENT, refreshRuns);
      window.removeEventListener('focus', refreshRuns);
    };
  }, [refreshRuns]);

  useEffect(() => {
    if (active) refreshRuns();
  }, [active, refreshRuns]);

  const counts = useMemo(
    () => ({
      total: runs.length,
      running: runs.filter((run) => run.status === 'running').length,
      failed: runs.filter((run) => run.status === 'failed').length,
      completed: runs.filter((run) => run.status === 'completed').length,
    }),
    [runs],
  );

  return (
    <div className="work-workspace">
      <div className="card work-summary-card">
        <div className="study-head">
          <h2>Work</h2>
          <span className="chip chip-ready">Agent runs</span>
        </div>
        <div className="work-summary-grid">
          <div className="work-stat">
            <span>total</span>
            <strong>{counts.total}</strong>
          </div>
          <div className="work-stat">
            <span>running</span>
            <strong>{counts.running}</strong>
          </div>
          <div className="work-stat">
            <span>completed</span>
            <strong>{counts.completed}</strong>
          </div>
          <div className="work-stat">
            <span>failed</span>
            <strong>{counts.failed}</strong>
          </div>
          <div className="work-stat">
            <span>updated</span>
            <strong>{formatWorkDate(lastRefresh)}</strong>
          </div>
        </div>
      </div>

      <div className="card work-runs-card">
        <div className="research-card-head">
          <h3>Runs</h3>
          <button type="button" onClick={refreshRuns}>
            Refresh
          </button>
        </div>
        <div className="research-table-wrap">
          <table className="runs-table research-runs-table">
            <thead>
              <tr>
                <th>run</th>
                <th>status</th>
                <th>duration</th>
                <th>seed</th>
                <th>start date</th>
                <th>end date</th>
                <th>action</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.sourceId}>
                  <td className="mono research-run-id">
                    <button
                      type="button"
                      className="work-run-link mono"
                      onClick={() => onOpenRun?.(run)}
                      title={`Open ${run.agent} task`}
                    >
                      {run.run}
                    </button>
                  </td>
                  <td className="work-run-actions">
                    <span className={`chip chip-run-${run.status}`}>{run.status}</span>
                  </td>
                  <td className="mono">{run.duration}</td>
                  <td className="mono">{String(run.seed).padStart(4, '0')}</td>
                  <td className="mono">{run.startDate}</td>
                  <td className="mono">{run.endDate}</td>
                  <td>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => onOpenRun?.(run)}
                      disabled={!onOpenRun}
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      className="ghost danger"
                      onClick={() => {
                        deleteWorkRun(run.sourceId);
                        refreshRuns();
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {runs.length === 0 ? (
          <div className="placeholder research-empty">
            <p>No agent runs yet.</p>
            <p className="hint">Runs will appear here after agent tasks finish.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
