import yauzl from 'yauzl';

// Inspect all entries before decompression; never extract uploaded paths to disk.
export async function openOfficeArchive(data, required) {
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(data, { lazyEntries: true, validateEntrySizes: true, autoClose: false }, (error, zip) => error ? reject(error) : resolve(zip)));
  try {
    const entries = await new Promise((resolve, reject) => {
      const entries = new Map(); let size = 0;
      zip.once('error', reject);
      zip.on('entry', entry => {
        size += entry.uncompressedSize;
        if (size > 67108864 || entries.size >= 2000 || entry.generalPurposeBitFlag & 1) { reject(new Error('Office 解壓縮內容過大、檔案過多或已加密。')); return; }
        if (entries.has(entry.fileName)) { reject(new Error('Office 文件包含重複的檔案項目。')); return; }
        entries.set(entry.fileName, entry); zip.readEntry();
      });
      zip.once('end', () => resolve(entries)); zip.readEntry();
    });
    if (!entries.has(required)) throw new Error('檔案不是有效的 Office 文件。');
    return {
      entries,
      stream(name, maxBytes = 67108864) {
        const entry = entries.get(name);
        if (!entry) throw new Error('Office 文件缺少必要內容。');
        if (entry.uncompressedSize > maxBytes) throw new Error('Office XML 內容過大。');
        return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
      },
      close: () => zip.close()
    };
  } catch (error) { zip.close(); throw error; }
}

export async function readOfficeArchive(data, required, select = () => false) {
  const archive = await openOfficeArchive(data, required);
  try {
    const files = new Map();
    for (const name of archive.entries.keys()) {
      if (!select(name)) continue;
      const stream = await archive.stream(name, 8388608), chunks = [];
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > 8388608) { stream.destroy(); throw new Error('Office XML 內容過大。'); }
        chunks.push(chunk);
      }
      files.set(name, Buffer.concat(chunks));
    }
    return files;
  } finally { archive.close(); }
}
