import { useEffect, useState } from 'react';
import type { ConnectionProfile } from '@cozypad/contracts';
import { CodexAppServerPanel } from './CodexAppServerPanel';
import { LegacyCodexPanel } from './LegacyCodexPanel';
import { getCodexAppServerStatus } from './codexAppServerClient';
import type { LegacySshServer } from './legacySshApi';

export function CodexPanel({
  selectedProfile,
  connected,
  legacyServer,
  focusTaskId,
  focusRequestNonce,
  onOpenFilesPath,
}: {
  selectedProfile: ConnectionProfile | null;
  connected: boolean;
  legacyServer: LegacySshServer | null;
  focusTaskId: string;
  focusRequestNonce: number;
  onOpenFilesPath?: (target: { serverId: string; path: string }) => void;
}) {
  const serverId = legacyServer?.id || selectedProfile?.id || '';
  const [useAppServer, setUseAppServer] = useState(true);
  const [forcedLegacy, setForcedLegacy] = useState(false);

  useEffect(() => {
    setForcedLegacy(false);
    setUseAppServer(true);
    if (!serverId) return;
    let active = true;
    void getCodexAppServerStatus(serverId)
      .then((status) => {
        if (!active) return;
        setUseAppServer(status.enabled && status.mode !== 'legacy');
      })
      .catch(() => {
        // Keep the structured Codex UI visible while disconnected or while the
        // backend status endpoint is temporarily unavailable.
        if (active) setUseAppServer(true);
      });
    return () => {
      active = false;
    };
  }, [serverId]);

  if (useAppServer && !forcedLegacy) {
    return (
      <CodexAppServerPanel
        selectedProfile={selectedProfile}
        connected={connected}
        legacyServer={legacyServer}
        onOpenFilesPath={onOpenFilesPath}
        onUseLegacy={() => setForcedLegacy(true)}
      />
    );
  }

  return (
    <LegacyCodexPanel
      selectedProfile={selectedProfile}
      connected={connected}
      legacyServer={legacyServer}
      focusTaskId={focusTaskId}
      focusRequestNonce={focusRequestNonce}
      onOpenFilesPath={onOpenFilesPath}
    />
  );
}
