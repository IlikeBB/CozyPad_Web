const LEGACY_STORAGE_KEY = /^cozypad3([.:])/;

function v4StorageKeyForLegacyKey(key: string): string {
  return key.replace(LEGACY_STORAGE_KEY, 'cozypad4$1');
}

export function migrateLegacyStorageKeysToV4(): void {
  if (typeof window === 'undefined') return;

  try {
    const pairs: Array<[string, string]> = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const legacyKey = window.localStorage.key(index);
      if (!legacyKey || !LEGACY_STORAGE_KEY.test(legacyKey)) continue;
      pairs.push([legacyKey, v4StorageKeyForLegacyKey(legacyKey)]);
    }

    pairs.forEach(([legacyKey, v4Key]) => {
      if (window.localStorage.getItem(v4Key) !== null) return;
      const legacyValue = window.localStorage.getItem(legacyKey);
      if (legacyValue !== null) {
        window.localStorage.setItem(v4Key, legacyValue);
      }
    });
  } catch {
    // Local storage can be unavailable in private or restricted browser modes.
  }
}
