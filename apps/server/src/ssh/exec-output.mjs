const outputLimit = 4 * 1024 * 1024;

export class ExecOutput {
  constructor(options = {}, overflowMessage = '遠端輸出超過 4 MB。') {
    this.collect = options.collectOutput !== false;
    if (!this.collect && typeof options.onData !== 'function') throw Object.assign(new Error('串流輸出需要接收處理函式。'), { status: 400 });
    this.onData = options.onData;
    this.overflowMessage = overflowMessage;
    this.stdout = ''; this.stderr = ''; this.bytes = 0;
  }
  receive(text, type, bytes = Buffer.byteLength(text, 'utf8')) {
    if (this.collect) {
      this.bytes += bytes;
      if (this.bytes > outputLimit) throw Object.assign(new Error(this.overflowMessage), { status: 413 });
      if (type === 'stdout') this.stdout += text; else this.stderr += text;
    }
    if (text) this.onData?.(text, type);
  }
  result(code) { return { stdout: this.stdout, stderr: this.stderr, code }; }
}
