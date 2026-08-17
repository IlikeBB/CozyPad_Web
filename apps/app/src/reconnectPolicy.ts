export const RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 30_000] as const;

export type ConnectionAttemptOrigin = 'manual' | 'reconnect' | null;

export function shouldEnterReconnectFlow({
  attemptOrigin,
  manualDisconnect,
  wasConnected,
}: {
  attemptOrigin: ConnectionAttemptOrigin;
  manualDisconnect: boolean;
  wasConnected: boolean;
}): boolean {
  return !manualDisconnect && wasConnected && attemptOrigin !== 'manual';
}

/** Returns a capped delay. App.tsx owns the retry limit. */
export function reconnectDelayMs(zeroBasedAttempt: number): number {
  const index = Math.max(0, Math.min(zeroBasedAttempt, RECONNECT_DELAYS_MS.length - 1));
  return RECONNECT_DELAYS_MS[index]!;
}
