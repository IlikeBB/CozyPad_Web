const USER_STORAGE_PREFIX = 'cozypad4.user';
const LEGACY_KEY_PATTERN = /^cozypad(?:3|4)[.:]/;
const ADMIN_MIGRATION_MARKER = 'migration.legacy-global.v1';

let activeUserId = '';

function normalizeUserId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
}

function featureName(key: string): string {
  return key
    .replace(/^cozypad(?:3|4)[.:]/, '')
    .replace(/[^a-zA-Z0-9._:-]+/g, '-');
}

function storageAvailable(): boolean {
  return typeof window !== 'undefined' && window.localStorage !== undefined;
}

export function scopedStorageKey(key: string, userId = activeUserId): string {
  const normalizedUser = normalizeUserId(userId);
  if (!normalizedUser) return '';
  return `${USER_STORAGE_PREFIX}.${normalizedUser}.${featureName(key)}`;
}

function migrationMarkerKey(userId: string): string {
  return scopedStorageKey(ADMIN_MIGRATION_MARKER, userId);
}

function shouldSkipLegacyMigration(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.startsWith(`${USER_STORAGE_PREFIX}.`) ||
    lower.includes('reviewpermission') ||
    lower.includes('session') ||
    lower.includes('token') ||
    lower.includes('password') ||
    lower.includes('credential')
  );
}

export function migrateLegacyStorageForUser(userId: string, role: string): void {
  if (!storageAvailable()) return;
  const normalizedUser = normalizeUserId(userId);
  if (!normalizedUser || role !== 'admin') return;
  const marker = migrationMarkerKey(normalizedUser);
  try {
    if (window.localStorage.getItem(marker) === 'complete') return;
    const legacyKeys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key && LEGACY_KEY_PATTERN.test(key) && !shouldSkipLegacyMigration(key)) {
        legacyKeys.push(key);
      }
    }
    for (const legacyKey of legacyKeys) {
      const nextKey = scopedStorageKey(legacyKey, normalizedUser);
      if (!nextKey || window.localStorage.getItem(nextKey) !== null) continue;
      const value = window.localStorage.getItem(legacyKey);
      if (value !== null) window.localStorage.setItem(nextKey, value);
    }
    window.localStorage.setItem(marker, 'complete');
  } catch {
    // Storage is best-effort. Authentication must not fail if migration cannot run.
  }
}

export function activateUserStorage(userId: string, role = 'user'): void {
  activeUserId = normalizeUserId(userId);
  migrateLegacyStorageForUser(activeUserId, role);
}

export function deactivateUserStorage(): void {
  activeUserId = '';
}

export function getActiveUserStorageId(): string {
  return activeUserId;
}

export const userStorage = {
  getItem(key: string): string | null {
    if (!storageAvailable()) return null;
    const scopedKey = scopedStorageKey(key);
    if (!scopedKey) return null;
    try {
      return window.localStorage.getItem(scopedKey);
    } catch {
      return null;
    }
  },

  setItem(key: string, value: string): void {
    if (!storageAvailable()) return;
    const scopedKey = scopedStorageKey(key);
    if (!scopedKey) return;
    try {
      window.localStorage.setItem(scopedKey, value);
    } catch {
      // Quota and restricted-mode failures must not crash the application.
    }
  },

  removeItem(key: string): void {
    if (!storageAvailable()) return;
    const scopedKey = scopedStorageKey(key);
    if (!scopedKey) return;
    try {
      window.localStorage.removeItem(scopedKey);
    } catch {
      // Storage is best-effort.
    }
  },
};
