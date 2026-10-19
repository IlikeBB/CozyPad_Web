export const attachmentLimits: Readonly<{ count: number; bytes: number; textChars: number; extractedTextChars: number }>;
export const attachmentTypes: Readonly<Record<string, { kind: 'image' | 'document'; mimeType: string }>>;
export const attachmentAccept: string;
export function attachmentType(name: string): { kind: 'image' | 'document'; mimeType: string; extension: string } | null;
export function attachmentNameError(name: unknown): string;
