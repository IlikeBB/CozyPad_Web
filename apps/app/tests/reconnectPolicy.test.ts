import { describe, expect, it } from 'vitest';
import { reconnectDelayMs, shouldEnterReconnectFlow } from '../src/reconnectPolicy';

describe('reconnectDelayMs', () => {
  it('backs off and then remains capped', () => {
    expect([0, 1, 2, 3, 4, 20].map(reconnectDelayMs)).toEqual([
      2_000,
      5_000,
      10_000,
      30_000,
      30_000,
      30_000,
    ]);
  });

  it('never treats a failed manual Connect as an automatic reconnect', () => {
    expect(shouldEnterReconnectFlow({
      attemptOrigin: 'manual',
      manualDisconnect: false,
      wasConnected: true,
    })).toBe(false);
  });

  it('enters reconnect flow only after an established connection drops', () => {
    expect(shouldEnterReconnectFlow({
      attemptOrigin: null,
      manualDisconnect: false,
      wasConnected: true,
    })).toBe(true);
    expect(shouldEnterReconnectFlow({
      attemptOrigin: null,
      manualDisconnect: true,
      wasConnected: true,
    })).toBe(false);
    expect(shouldEnterReconnectFlow({
      attemptOrigin: null,
      manualDisconnect: false,
      wasConnected: false,
    })).toBe(false);
  });
});
