export class ProtocolLines {
  constructor(maxBytes = 16 * 1024 * 1024) { this.maxBytes = maxBytes; this.parts = []; this.bytes = 0; }
  add(text) {
    this.bytes += Buffer.byteLength(text, 'utf8');
    if (this.bytes > this.maxBytes) {
      this.clear();
      throw Object.assign(new Error(`單筆 Codex 訊息超過 ${this.maxBytes / 1048576} MB，請縮小單次指令輸出範圍。`), { status: 413 });
    }
    if (text) this.parts.push(text);
  }
  write(text, onLine) {
    let start = 0, end;
    while ((end = text.indexOf('\n', start)) !== -1) {
      this.add(text.slice(start, end));
      const line = this.parts.join(''); this.clear();
      if (onLine(line) === false) return;
      start = end + 1;
    }
    this.add(text.slice(start));
  }
  clear() { this.parts = []; this.bytes = 0; }
}
