import { describe, expect, it } from 'vitest';
import {
  CODEX_DISPLAY_ITEM_BATCH,
  CODEX_DISPLAY_TEXT_PREVIEW_CHARS,
  codexDisplayText,
  codexDisplayWindow,
} from '../src/workspaces/agents/codexDisplayWindow';

describe('codex display window', () => {
  it('keeps only the newest display batch without removing source items', () => {
    const items = Array.from({ length: 125 }, (_, index) => index);
    const result = codexDisplayWindow(items, CODEX_DISPLAY_ITEM_BATCH);

    expect(result.hiddenItemCount).toBe(45);
    expect(result.visibleItems).toHaveLength(80);
    expect(result.visibleItems[0]).toBe(45);
    expect(items).toHaveLength(125);
  });

  it('returns every item when the task is shorter than the window', () => {
    expect(codexDisplayWindow(['a', 'b'], CODEX_DISPLAY_ITEM_BATCH)).toEqual({
      visibleItems: ['a', 'b'],
      hiddenItemCount: 0,
    });
  });

  it('previews long text while preserving an explicit full-content path', () => {
    const text = 'x'.repeat(CODEX_DISPLAY_TEXT_PREVIEW_CHARS + 250);

    expect(codexDisplayText(text, false)).toHaveLength(CODEX_DISPLAY_TEXT_PREVIEW_CHARS + 3);
    expect(codexDisplayText(text, true)).toBe(text);
  });
});
