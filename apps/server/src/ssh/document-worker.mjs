import { parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { attachmentLimits } from '../../../../packages/contracts/src/attachments.mjs';
import { extractPresentation } from './presentation-text.mjs';
import { extractWord } from './word-text.mjs';

try {
  const data = Buffer.from(workerData.data.buffer, workerData.data.byteOffset, workerData.data.byteLength), extension = workerData.extension;
  let text;
  if (extension === 'pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const base = import.meta.resolve('pdfjs-dist/package.json');
    const localData = directory => fileURLToPath(new URL(`./${directory}/`, base)).replaceAll('\\', '/');
    const pdf = await getDocument({ data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: false, disableFontFace: true,
      standardFontDataUrl: localData('standard_fonts'), cMapUrl: localData('cmaps'), cMapPacked: true, wasmUrl: localData('wasm') }).promise;
    try {
      if (pdf.numPages > 100) throw new Error('PDF 超過 100 頁上限。');
      const pages = [];
      let length = 0;
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number), content = await page.getTextContent();
        const value = content.items.map(item => item.str ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('');
        length += value.length;
        if (length > attachmentLimits.extractedTextChars) throw new Error('文件文字超過 1,000,000 字元解析上限。');
        pages.push(value); page.cleanup();
      }
      text = pages.join('\n');
      if (!text.trim()) throw new Error('PDF 沒有可讀文字，請改用頁面圖片或含文字的 PDF。');
    } finally { await pdf.loadingTask.destroy(); }
  } else if (extension === 'docx') {
    text = await extractWord(data);
  } else if (extension === 'pptx') {
    text = await extractPresentation(data);
  } else {
    const encoding = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le' : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-8';
    text = new TextDecoder(encoding, { fatal: true }).decode(data);
    if (text.includes('\0')) throw new Error('文字附件包含二進位內容。');
  }
  if (text.length > attachmentLimits.extractedTextChars) throw new Error('文件文字超過 1,000,000 字元解析上限。');
  parentPort.postMessage({ text });
} catch (error) { parentPort.postMessage({ error: error.message || '無法讀取文件。' }); }
