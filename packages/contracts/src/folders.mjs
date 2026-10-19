export function folderNameError(name) {
  if (typeof name !== 'string' || !name.trim() || ['.', '..'].includes(name) || /[\\/\x00-\x1f\x7f]/.test(name)) return '資料夾名稱不可空白，也不可包含斜線、反斜線或控制字元。';
  if (new TextEncoder().encode(name).length > 255) return '資料夾名稱超過 255 bytes 上限。';
  return '';
}
