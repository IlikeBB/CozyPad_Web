export const searchLimits = Object.freeze({ maxDepth: 4, maxEntries: 5000, maxFiles: 2000, maxResults: 50, maxBytes: 1048576, maxTotalBytes: 16777216, timeoutMs: 15000 });

export const searchLimitLabels = Object.freeze({
  max_depth: '達到目錄深度上限', max_entries: '達到目錄項目上限', max_files: '達到候選檔案上限', max_results: '達到結果上限',
  max_total_bytes: '達到總讀取量上限', timeout: '達到搜尋時間上限', links_skipped: '已跳過符號連結',
  outside_root_skipped: '已跳過範圍外路徑', private_names_skipped: '已跳過敏感檔案', excluded_directories: '已跳過依賴、快取或輸出目錄',
  large_files_skipped: '已跳過大型檔案', binary_files_skipped: '已跳過二進位檔案', non_utf8_files_skipped: '已跳過非 UTF-8 檔案',
  entry_read_error: '部分項目無法讀取', directory_read_error: '部分目錄無法讀取'
});

export function searchOptions(input) {
  const problem = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) problem('搜尋條件不正確。');
  if (typeof input.root !== 'string' || !input.root.trim() || input.root.length > 4096 || /[\x00-\x1f\x7f]/.test(input.root)) problem('請指定搜尋目錄。');
  if (typeof input.glob !== 'string' || !input.glob.trim() || input.glob.length > 128 || /[\/\\\x00-\x1f\x7f]/.test(input.glob)) problem('請指定檔名模式，不可包含目錄路徑。');
  if (input.text !== undefined && (typeof input.text !== 'string' || !input.text.length || input.text.length > 256 || /[\x00\r\n]/.test(input.text))) problem('請輸入單行搜尋文字，最多 256 個字元。');
  if (input.text !== undefined && ['*', '**', '*.*'].includes(input.glob.trim())) problem('搜尋內容時，請限定檔名或副檔名。');
  const options = { root: input.root, glob: input.glob, ...(input.text !== undefined ? { text: input.text } : {}) };
  for (const [key, maximum] of Object.entries(searchLimits)) {
    const value = input[key] ?? maximum;
    if (!Number.isSafeInteger(value) || value < (key === 'maxDepth' ? 0 : 1) || value > maximum) problem(`搜尋預算 ${key} 超出允許範圍。`);
    options[key] = value;
  }
  return options;
}
