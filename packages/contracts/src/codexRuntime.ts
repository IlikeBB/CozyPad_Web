import { z } from 'zod';

/**
 * Lossless relay envelope for Codex app-server notifications.
 *
 * `method` and `payload` deliberately preserve the upstream notification so a
 * newer Codex CLI can be recorded and replayed even before CozyPad learns how
 * to render its new item type.
 */
export const CodexRuntimeEventSchema = z.object({
  eventId: z.string().min(1),
  sequence: z.number().int().min(0),
  localSessionId: z.string().min(1),
  connectionProfileId: z.string().min(1),
  // Account/model/runtime notifications are not scoped to a thread.
  threadId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  itemId: z.string().min(1).optional(),
  method: z.string().min(1),
  timestamp: z.string().min(1),
  rawEventVersion: z.string().min(1),
  payload: z.unknown(),
});
export type CodexRuntimeEvent = z.infer<typeof CodexRuntimeEventSchema>;

export const CodexRuntimeStatusSchema = z.enum([
  'starting',
  'ready',
  'reconnecting',
  'unavailable',
  'stopped',
  'error',
]);
export type CodexRuntimeStatus = z.infer<typeof CodexRuntimeStatusSchema>;

export const CodexRuntimeIdentitySchema = z.object({
  owner: z.string().min(1),
  connectionProfileId: z.string().min(1),
  remoteHostFingerprint: z.string().min(1),
  codexHomeNamespace: z.string().min(1),
});
export type CodexRuntimeIdentity = z.infer<typeof CodexRuntimeIdentitySchema>;

export function codexRuntimeKey(identity: CodexRuntimeIdentity): string {
  return [
    identity.owner,
    identity.connectionProfileId,
    identity.remoteHostFingerprint,
    identity.codexHomeNamespace,
  ].join('\0');
}
