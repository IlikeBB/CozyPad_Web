import { useEffect, useState } from 'react';
import type { ConnectionProfile } from '@cozypad/contracts';
import { CodexAppServerPanel } from './CodexAppServerPanel';
import { LegacyCodexPanel } from './LegacyCodexPanel';
import { getCodexAppServerStatus } from './codexAppServerClient';
import type { LegacySshServer } from './legacySshApi';

const AUTO_OPT_IN_KEY = 'cozypad.codexAppServer.autoOptIn.v1';

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
  const [useAppServer, setUseAppServer] = useState(false);
  const [forcedLegacy, setForcedLegacy] = useState(false);

  useEffect(() => {
    setForcedLegacy(false);
    setUseAppServer(false);
    if (!serverId) return;
    let active = true;
    void getCodexAppServerStatus(serverId)
      .then((status) => {
        if (!active) return;
        const autoOptIn = window.localStorage.getItem(AUTO_OPT_IN_KEY) === 'true';
        setUseAppServer(
          status.enabled && (status.mode === 'app-server' || (status.mode === 'auto' && autoOptIn)),
        );
      })
      .catch(() => {
        if (active) setUseAppServer(false);
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
