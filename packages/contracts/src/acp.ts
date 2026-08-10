import { z } from 'zod';
import { AgentKindSchema } from './chat';

export const AcpContentBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('image'),
    mimeType: z.string().min(1),
    data: z.string().min(1),
    filename: z.string().optional(),
  }),
]);
export type AcpContentBlock = z.infer<typeof AcpContentBlockSchema>;

export const AcpSessionContextSchema = z.object({
  sessionId: z.string().min(1),
  agentKind: AgentKindSchema,
  cwd: z.string().min(1),
  model: z.string().optional(),
  effort: z.string().optional(),
});
export type AcpSessionContext = z.infer<typeof AcpSessionContextSchema>;

export const AcpPromptSchema = z.object({
  sessionId: z.string().min(1),
  prompt: z.array(AcpContentBlockSchema).min(1),
});
export type AcpPrompt = z.infer<typeof AcpPromptSchema>;

export const AcpSessionUpdateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('agent_message_chunk'),
    sessionId: z.string().min(1),
    messageId: z.string().min(1),
    content: z.array(AcpContentBlockSchema),
  }),
  z.object({
    kind: z.literal('tool_call'),
    sessionId: z.string().min(1),
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    summary: z.string(),
    status: z.enum(['running', 'completed', 'error']),
    output: z.string().optional(),
    durationMs: z.number().optional(),
  }),
  z.object({
    kind: z.literal('plan'),
    sessionId: z.string().min(1),
    entries: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('usage_update'),
    sessionId: z.string().min(1),
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
  }),
  z.object({
    kind: z.literal('turn_completed'),
    sessionId: z.string().min(1),
    stopReason: z.enum(['end_turn', 'cancelled', 'error']).default('end_turn'),
  }),
  z.object({
    kind: z.literal('error'),
    sessionId: z.string().min(1),
    message: z.string().min(1),
  }),
]);
export type AcpSessionUpdate = z.infer<typeof AcpSessionUpdateSchema>;
