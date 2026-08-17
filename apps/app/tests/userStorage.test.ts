import { beforeEach, describe, expect, it } from 'vitest';
import {
  activateUserStorage,
  deactivateUserStorage,
  getActiveUserStorageId,
  scopedStorageKey,
  userStorage,
} from '../src/platform/userStorage';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
}

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { localStorage: new MemoryStorage() },
});

describe('userStorage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    deactivateUserStorage();
  });

  it('isolates the same feature between users', () => {
    activateUserStorage('admin', 'admin');
    userStorage.setItem('cozypad3.remoteCodex.model.v1', 'gpt-admin');

    activateUserStorage('EFan', 'user');
    expect(userStorage.getItem('cozypad3.remoteCodex.model.v1')).toBeNull();
    userStorage.setItem('cozypad3.remoteCodex.model.v1', 'gpt-user');

    activateUserStorage('admin', 'admin');
    expect(userStorage.getItem('cozypad3.remoteCodex.model.v1')).toBe('gpt-admin');
  });

  it('migrates legacy global data only to admin and skips review permission', () => {
    window.localStorage.setItem('cozypad3.remoteCodex.model.v1', 'legacy-model');
    window.localStorage.setItem('cozypad3.remoteCodex.reviewPermission.v1', 'full-access');

    activateUserStorage('EFan', 'user');
    expect(userStorage.getItem('cozypad3.remoteCodex.model.v1')).toBeNull();

    activateUserStorage('admin', 'admin');
    expect(userStorage.getItem('cozypad3.remoteCodex.model.v1')).toBe('legacy-model');
    expect(userStorage.getItem('cozypad3.remoteCodex.reviewPermission.v1')).toBeNull();
  });

  it('does not overwrite an existing scoped value during migration', () => {
    window.localStorage.setItem('cozypad3.remoteCodex.model.v1', 'legacy-model');
    window.localStorage.setItem(
      scopedStorageKey('cozypad3.remoteCodex.model.v1', 'admin'),
      'new-model',
    );
    activateUserStorage('admin', 'admin');
    expect(userStorage.getItem('cozypad3.remoteCodex.model.v1')).toBe('new-model');
  });

  it('normalizes user ids and disables access after logout', () => {
    activateUserStorage('  E Fan  ', 'user');
    expect(getActiveUserStorageId()).toBe('e-fan');
    userStorage.setItem('feature.v1', 'value');
    deactivateUserStorage();
    expect(userStorage.getItem('feature.v1')).toBeNull();
  });

  it('does not crash when browser storage is restricted or over quota', () => {
    const originalStorage = window.localStorage;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        get length() { throw new Error('restricted'); },
        clear() { throw new Error('restricted'); },
        getItem() { throw new Error('restricted'); },
        key() { throw new Error('restricted'); },
        removeItem() { throw new Error('restricted'); },
        setItem() { throw new Error('quota'); },
      },
    });
    expect(() => activateUserStorage('EFan', 'user')).not.toThrow();
    expect(() => userStorage.setItem('feature.v1', 'value')).not.toThrow();
    expect(userStorage.getItem('feature.v1')).toBeNull();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: originalStorage,
    });
  });
});
