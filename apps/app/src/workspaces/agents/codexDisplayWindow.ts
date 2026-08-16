export const CODEX_DISPLAY_ITEM_BATCH = 80;
export const CODEX_DISPLAY_TEXT_PREVIEW_CHARS = 12_000;

export function codexDisplayWindow<T>(items: T[], limit: number): {
  visibleItems: T[];
  hiddenItemCount: number;
} {
  const safeLimit = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : CODEX_DISPLAY_ITEM_BATCH));
  const visibleItems = items.slice(Math.max(0, items.length - safeLimit));
  return {
    visibleItems,
    hiddenItemCount: Math.max(0, items.length - visibleItems.length),
  };
}

export function codexDisplayText(text: string, showFullText: boolean): string {
  if (showFullText || text.length <= CODEX_DISPLAY_TEXT_PREVIEW_CHARS) return text;
  return `${text.slice(0, CODEX_DISPLAY_TEXT_PREVIEW_CHARS).trimEnd()}\n\n…`;
}
