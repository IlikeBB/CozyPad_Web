import { describe, expect, it } from 'vitest';
import {
  CODEX_PASTED_TEXT_THRESHOLD_CHARS,
  appendPastedTextFiles,
  createPastedTextAttachment,
  pastedTextInputItems,
  pastedTextTranscript,
  shouldConvertPastedText,
} from '../src/workspaces/agents/codexPastedText';

describe('Codex pasted text attachments', () => {
  it('converts only clipboard text at or above the UI threshold', () => {
    expect(shouldConvertPastedText('x'.repeat(CODEX_PASTED_TEXT_THRESHOLD_CHARS - 1))).toBe(false);
    expect(shouldConvertPastedText('x'.repeat(CODEX_PASTED_TEXT_THRESHOLD_CHARS))).toBe(true);
  });

  it('creates a deterministic text attachment with UTF-8 byte size', () => {
    const attachment = createPastedTextAttachment('測試 text', {
      id: 'paste-1',
      now: new Date('2026-08-15T12:34:56.000Z'),
    });

    expect(attachment).toMatchObject({
      id: 'paste-1',
      name: 'pasted-text-20260815T123456000Z.txt',
      type: 'text/plain',
      size: 11,
      text: '測試 text',
    });
  });

  it('keeps full pasted content out of the visible transcript', () => {
    const attachment = createPastedTextAttachment('secret long content', { id: 'paste-1' });
    const transcript = pastedTextTranscript('Review this', [attachment]);

    expect(transcript).toContain(attachment.name);
    expect(transcript).not.toContain('secret long content');
    expect(appendPastedTextFiles('Review this', [attachment])).toContain('secret long content');
  });

  it('creates separate app-server text inputs for pasted files', () => {
    const attachment = createPastedTextAttachment('full pasted content', { id: 'paste-1' });
    expect(pastedTextInputItems([attachment])).toEqual([{
      type: 'text',
      text: `Attached text file: ${attachment.name}\n\nfull pasted content`,
      text_elements: [],
    }]);
  });
});
