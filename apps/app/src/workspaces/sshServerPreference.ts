import type { LegacySshServer } from './agents/legacySshApi';
import { scopedStorageKey, userStorage } from '../platform/userStorage';

const LAST_SELECTED_LEGACY_SERVER_KEY = 'cozypad3.lastSelectedLegacyServerId';
const LAST_SELECTED_LEGACY_SERVER_EVENT = 'cozypad3:last-selected-legacy-server';

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

export function readLastSelectedLegacyServerId(): string {
  if (!hasWindow()) return '';
  try {
    return userStorage.getItem(LAST_SELECTED_LEGACY_SERVER_KEY) || '';
  } catch {
    return '';
  }
}

export function rememberLastSelectedLegacyServerId(serverId: string): void {
  if (!hasWindow()) return;
  const nextServerId = serverId.trim();
  try {
    if (nextServerId) {
      userStorage.setItem(LAST_SELECTED_LEGACY_SERVER_KEY, nextServerId);
    } else {
      userStorage.removeItem(LAST_SELECTED_LEGACY_SERVER_KEY);
    }
  } catch {
    // Ignore private-mode or quota storage failures.
  }
  window.dispatchEvent(
    new CustomEvent(LAST_SELECTED_LEGACY_SERVER_EVENT, {
      detail: { serverId: nextServerId },
    }),
  );
}

export function resolveLastSelectedLegacyServerId(
  servers: LegacySshServer[],
  currentId = '',
): string {
  if (currentId && servers.some((server) => server.id === currentId)) return currentId;
  const rememberedId = readLastSelectedLegacyServerId();
  if (rememberedId && servers.some((server) => server.id === rememberedId)) return rememberedId;
  return '';
}

export function findRememberedLegacyServer(servers: LegacySshServer[]): LegacySshServer | null {
  const rememberedId = readLastSelectedLegacyServerId();
  if (!rememberedId) return null;
  return servers.find((server) => server.id === rememberedId) ?? null;
}

export function subscribeLastSelectedLegacyServerId(
  callback: (serverId: string) => void,
): () => void {
  if (!hasWindow()) return () => undefined;
  const onCustomEvent = (event: Event) => {
    callback((event as CustomEvent<{ serverId?: string }>).detail?.serverId || '');
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === scopedStorageKey(LAST_SELECTED_LEGACY_SERVER_KEY)) {
      callback(event.newValue || '');
    }
  };
  window.addEventListener(LAST_SELECTED_LEGACY_SERVER_EVENT, onCustomEvent);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(LAST_SELECTED_LEGACY_SERVER_EVENT, onCustomEvent);
    window.removeEventListener('storage', onStorage);
  };
}
