export const attachmentLimits = Object.freeze({ count: 5, bytes: 31457280, textChars: 60000, extractedTextChars: 1000000 });
export const attachmentTypes = Object.freeze({
  png: { kind: 'image', mimeType: 'image/png' },
  jpg: { kind: 'image', mimeType: 'image/jpeg' },
  jpeg: { kind: 'image', mimeType: 'image/jpeg' },
  webp: { kind: 'image', mimeType: 'image/webp' },
  pdf: { kind: 'document', mimeType: 'application/pdf' },
  docx: { kind: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  pptx: { kind: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  ...Object.fromEntries(['txt', 'md', 'csv', 'json', 'log', 'yaml', 'yml', 'xml', 'py', 'js', 'ts', 'tsx', 'jsx', 'sh', 'css', 'html', 'sql'].map(extension => [extension, { kind: 'document', mimeType: 'text/plain; charset=utf-8' }]))
});
export const attachmentAccept = Object.keys(attachmentTypes).map(extension => `.${extension}`).join(',');
export function attachmentType(name) {
  const extension = name.split('.').at(-1)?.toLowerCase();
  return Object.hasOwn(attachmentTypes, extension) ? { ...attachmentTypes[extension], extension } : null;
}
export function attachmentNameError(name) {
  if (typeof name !== 'string' || !name || name.length > 180 || /[\\/\x00-\x1f\x7f]/.test(name)) return '附件檔名不正確，請使用不超過 180 字且不含路徑的檔名。';
  if (name.toLowerCase().endsWith('.ppt')) return `附件「${name}」是舊版 PPT，請另存為 PPTX 或 PDF 後再上傳。`;
  return attachmentType(name) ? '' : `附件格式不支援：「${name}」。請選擇 PNG、JPEG、WebP、PDF、DOCX、PPTX 或文字檔。`;
}
