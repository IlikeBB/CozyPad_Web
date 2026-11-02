import path from 'node:path';
import { once } from 'node:events';
import { quoteShell } from './ssh-service.mjs';

const problem = (message, status = 400) => Object.assign(new Error(message), { status });
const invoke = (channel, method, ...args) => new Promise((resolve, reject) => channel[method](...args, (error, value) => error ? reject(error) : resolve(value)));

// Stream binary stdout directly. The text exec helper intentionally has a
// different contract and must never decode or accumulate archive bytes.
export async function serveFolderArchive(request, response, files, owner, id, requested, { timeoutMs = 120000 } = {}) {
  if (typeof requested !== 'string' || !requested) throw problem('請選擇要下載的資料夾。');
  let sftp, channel, stopped, timer, exitCode, signal, channelError;
  let rejectAbort;
  const aborted = new Promise((resolve, reject) => { rejectAbort = reject; });
  aborted.catch(() => {});
  const wait = promise => Promise.race([promise, aborted]);
  const stop = error => {
    if (stopped) return;
    stopped = error; rejectAbort(error); sftp?.end(); channel?.close();
  };
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stop(problem('資料夾下載逾時，請重試。', 504)), timeoutMs); timer.unref();
  };
  const cancel = () => { if (!response.writableFinished) stop(new Error('資料夾下載已取消。')); };
  response.once('close', cancel); touch();
  try {
    sftp = await wait(files.ssh.sftp(owner, id).then(value => { if (stopped) value.end(); return value; }));
    const directory = await wait(files.location(sftp, requested)); touch();
    if (directory === '/') throw problem('請選擇個別資料夾下載，不能打包整個根目錄。');
    const attributes = await wait(invoke(sftp, 'lstat', directory)); touch();
    if (!attributes.isDirectory() || attributes.isSymbolicLink()) throw problem('請選擇一般資料夾，不支援符號連結。');
    if (await wait(invoke(sftp, 'realpath', directory)) !== directory) throw problem('資料夾路徑已變更，請重新整理後再試。', 409);
    sftp.end(); sftp = null;
    const client = await wait(files.ssh.connectedClient(owner, id));
    const name = path.posix.basename(directory);
    // Default tar behavior archives child links themselves without following
    // them. Clear inherited options and quote both operands; no remote temp file.
    const command = `unset TAR_OPTIONS; exec tar -czf - -C ${quoteShell(path.posix.dirname(directory))} -- ${quoteShell(name)}`;
    let closed;
    channel = await wait(new Promise((resolve, reject) => client.exec(command, (error, value) => {
      if (error) { reject(error); return; }
      if (stopped) { value.on('error', () => {}); value.close(); resolve(value); return; }
      value.on('error', error => { channelError = error; });
      value.once('exit', (code, exitSignal) => { exitCode = code; signal = exitSignal; });
      closed = new Promise(done => value.once('close', () => done()));
      // Drain diagnostics without sending private paths to the HTTP response.
      value.stderr.on('data', touch);
      resolve(value);
    })));
    channel.end(); touch();
    let bytes = 0;
    for await (const chunk of channel) {
      if (stopped) throw stopped;
      touch();
      if (!bytes) response.writeHead(200, {
        'content-type': 'application/gzip', 'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name + '.tar.gz').replace(/['()*]/g, value => '%' + value.charCodeAt(0).toString(16).toUpperCase())}`,
        'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox",
        'cross-origin-resource-policy': 'same-origin', 'x-accel-buffering': 'no'
      });
      bytes += chunk.length;
      if (!response.write(chunk)) await wait(once(response, 'drain'));
    }
    await wait(closed);
    if (stopped) throw stopped;
    if (channelError) throw channelError;
    if (exitCode === 127) throw problem('遠端主機未安裝 tar，無法下載資料夾。', 502);
    if (exitCode !== 0 || signal || !bytes) throw problem('資料夾打包失敗，請確認讀取權限或內容是否變動。', 502);
    response.end();
  } catch (error) {
    if (response.destroyed) return;
    if (response.headersSent) { response.destroy(); return; }
    if (error.code === 2 || error.code === 'ENOENT') throw problem('找不到此資料夾。', 404);
    if (error.code === 3 || error.code === 'EACCES') throw problem('沒有權限讀取此資料夾。', 403);
    throw error;
  } finally {
    response.removeListener('close', cancel); clearTimeout(timer);
    sftp?.end(); channel?.close();
  }
}
