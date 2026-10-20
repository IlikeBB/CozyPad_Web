import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mediaType } from '../../../../packages/contracts/src/media-types.mjs';

const invoke = (channel, method, ...args) => new Promise((resolve, reject) => channel[method](...args, (error, value) => error ? reject(error) : resolve(value)));

export function mediaRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || !size || !match[1] && !match[2]) return null;
  const first = match[1] ? Number(match[1]) : null, last = match[2] ? Number(match[2]) : null;
  if ([first, last].some(value => value !== null && !Number.isSafeInteger(value))) return null;
  const start = first === null ? Math.max(0, size - last) : first;
  const end = first === null || last === null ? size - 1 : Math.min(last, size - 1);
  return start >= size || start > end ? null : { start, end, partial: true };
}

// Keep the file handle and SFTP channel scoped to one HTTP response. The parent SSH
// connection belongs to the user and must survive seeking, cancellation and errors.
export async function serveMedia(request, response, files, owner, id, requested, download = false) {
  let channel, handle, source, ended = false, stopped, timer;
  const endChannel = () => { if (channel && !ended) { ended = true; channel.end(); } };
  const stop = error => { stopped ||= error; source?.destroy(error); endChannel(); };
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stop(Object.assign(new Error('讀取媒體逾時，請重新載入。'), { status: 504 })), 30000);
    timer.unref();
  };
  const check = () => { if (stopped) throw stopped; };
  const cancel = () => { if (!response.writableFinished) stop(new Error('媒體預覽已關閉。')); };
  response.once('close', cancel);
  touch();
  try {
    channel = await files.ssh.sftp(owner, id); check();
    const file = await files.location(channel, requested); check(); touch();
    const format = mediaType(file);
    if (!format) throw Object.assign(new Error('此格式不支援圖片或影片預覽，請使用下載。'), { status: 415 });
    const metadata = await invoke(channel, 'stat', file); check(); touch();
    if (!metadata.isFile()) throw Object.assign(new Error('此路徑不是一般媒體檔案。'), { status: 400 });
    handle = await invoke(channel, 'open', file, 'r'); check();
    const attrs = await invoke(channel, 'fstat', handle); check(); touch();
    if (!attrs.isFile()) throw Object.assign(new Error('此路徑不是一般媒體檔案。'), { status: 400 });
    if (!Number.isSafeInteger(attrs.size) || attrs.size < 0) throw Object.assign(new Error('無法取得媒體檔案大小。'), { status: 413 });
    // A HEAD request describes the complete resource. Without a representation
    // validator, If-Range falls back to a complete response rather than mixing versions.
    const range = mediaRange(request.method === 'HEAD' || request.headers['if-range'] ? null : request.headers.range, attrs.size);
    const headers = {
      'content-type': format.mimeType, 'accept-ranges': 'bytes', 'cache-control': 'private, no-store',
      'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(path.posix.basename(file))}`,
      'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin',
      'content-security-policy': "default-src 'none'; sandbox", 'x-accel-buffering': 'no'
    };
    if (!range) { response.writeHead(416, { ...headers, 'content-range': `bytes */${attrs.size}`, 'content-length': 0 }); response.end(); return; }
    const length = Math.max(0, range.end - range.start + 1);
    response.writeHead(range.partial ? 206 : 200, { ...headers, 'content-length': length,
      ...(range.partial ? { 'content-range': `bytes ${range.start}-${range.end}/${attrs.size}` } : {}) });
    if (request.method === 'HEAD' || !length) { response.end(); return; }
    source = Readable.from((async function* () {
      let position = range.start;
      while (position <= range.end) {
        check();
        const buffer = Buffer.alloc(Math.min(65536, range.end - position + 1));
        const count = await new Promise((resolve, reject) => channel.read(handle, buffer, 0, buffer.length, position, (error, bytes) => error ? reject(error) : resolve(bytes)));
        check(); touch();
        if (!Number.isInteger(count) || count <= 0 || count > buffer.length) throw new Error('媒體檔案已變更或讀取中斷，請重新載入。');
        position += count;
        yield buffer.subarray(0, count);
      }
    })(), { objectMode: false, highWaterMark: 65536 });
    await pipeline(source, response);
  } catch (error) {
    if (response.destroyed) return;
    if (response.headersSent) { response.destroy(); return; }
    if (stopped) throw stopped;
    if (error.code === 2 || error.code === 'ENOENT') throw Object.assign(new Error('找不到此媒體檔案。'), { status: 404 });
    if (error.code === 3 || error.code === 'EACCES') throw Object.assign(new Error('沒有權限讀取此媒體檔案。'), { status: 403 });
    throw error;
  } finally {
    response.removeListener('close', cancel);
    source?.destroy();
    if (handle && !ended) await invoke(channel, 'close', handle).catch(() => {});
    endChannel(); clearTimeout(timer);
  }
}
