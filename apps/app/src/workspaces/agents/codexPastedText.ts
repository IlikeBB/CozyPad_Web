export const CODEX_PASTED_TEXT_THRESHOLD_CHARS = 12_000;
export const CODEX_PASTED_TEXT_MAX_ATTACHMENTS = 4;
export const CODEX_PASTED_TEXT_MAX_BYTES = 1_000_000;

export type CodexPastedTextAttachment = {
  id: string;
  name: string;
  type: 'text/plain';
  size: number;
  text: string;
};

export function shouldConvertPastedText(text: string): boolean {
  return text.length >= CODEX_PASTED_TEXT_THRESHOLD_CHARS;
}

function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace('.', '');
}

export function createPastedTextAttachment(
  text: string,
  options: { now?: Date; id?: string } = {},
): CodexPastedTextAttachment {
  const now = options.now || new Date();
  return {
    id: options.id || `pasted-text:${crypto.randomUUID()}`,
    name: `pasted-text-${compactTimestamp(now)}.txt`,
    type: 'text/plain',
    size: new TextEncoder().encode(text).byteLength,
    text,
  };
}

export function pastedTextFallbackPrompt(attachments: CodexPastedTextAttachment[]): string {
  return attachments.length === 1
    ? 'Please read and respond to the attached pasted-text file.'
    : 'Please read and respond to the attached pasted-text files.';
}

export function appendPastedTextFiles(
  prompt: string,
  attachments: CodexPastedTextAttachment[],
): string {
  const cleanPrompt = prompt.trim() || pastedTextFallbackPrompt(attachments);
  if (!attachments.length) return cleanPrompt;
  const files = attachments.map((attachment) => [
    `--- BEGIN ATTACHED TEXT FILE: ${attachment.name} ---`,
    attachment.text,
    `--- END ATTACHED TEXT FILE: ${attachment.name} ---`,
  ].join('\n'));
  return `${cleanPrompt}\n\n${files.join('\n\n')}`;
}

export function pastedTextTranscript(
  prompt: string,
  attachments: CodexPastedTextAttachment[],
): string {
  const cleanPrompt = prompt.trim() || pastedTextFallbackPrompt(attachments);
  if (!attachments.length) return cleanPrompt;
  const files = attachments.map((attachment) =>
    `- ${attachment.name} (${attachment.size.toLocaleString()} bytes)`,
  );
  return `${cleanPrompt}\n\n[Attached text files]\n${files.join('\n')}`;
}

export function pastedTextInputItems(
  attachments: CodexPastedTextAttachment[],
): Array<{ type: 'text'; text: string; text_elements: never[] }> {
  return attachments.map((attachment) => ({
    type: 'text',
    text: [
      `Attached text file: ${attachment.name}`,
      '',
      attachment.text,
    ].join('\n'),
    text_elements: [],
  }));
}
