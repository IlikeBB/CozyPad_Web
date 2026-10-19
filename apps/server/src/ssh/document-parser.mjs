import { Worker } from 'node:worker_threads';

// Serialize parsers so uploaded documents cannot spawn unbounded worker processes.
let queue = Promise.resolve();
export function extractDocument(data, extension, signal) {
  const operation = queue.catch(() => {}).then(() => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('附件處理已取消。')); return; }
    const worker = new Worker(new URL('./document-worker.mjs', import.meta.url), {
      workerData: { data, extension }, resourceLimits: { maxOldGenerationSizeMb: 128 }
    });
    let settled = false;
    const finish = (error, text) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error?.code === 'ERR_WORKER_OUT_OF_MEMORY') error = new Error('文件解析超過記憶體限制，請縮小文件或轉成含文字的 PDF 後重試。');
      // Do not start the next parser until this worker and its heap are fully released.
      void worker.terminate().catch(() => {}).then(() => {
        if (error) reject(Object.assign(error, { status: 415 })); else resolve(text);
      });
    };
    const abort = () => finish(new Error('附件處理已取消。'));
    const timer = setTimeout(() => finish(new Error('文件處理逾時，請縮小文件後再試。')), 15000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', result => finish(result.error ? new Error(result.error) : null, result.text));
    worker.once('error', error => finish(error));
    worker.once('exit', () => { if (!settled) finish(new Error('文件處理提前中斷。')); });
  }));
  queue = operation;
  return operation;
}
