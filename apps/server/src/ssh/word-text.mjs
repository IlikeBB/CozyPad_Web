import sax from 'sax';
import { attachmentLimits } from '../../../../packages/contracts/src/attachments.mjs';
import { openOfficeArchive } from './office-archive.mjs';

const wordNamespaces = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);
const isWord = node => wordNamespaces.has(node?.uri);
const noteId = node => Object.values(node.attributes).find(attribute => isWord(attribute) && attribute.local === 'id')?.value;

export async function extractWord(data) {
  const archive = await openOfficeArchive(data, 'word/document.xml');
  const parts = [], notes = { footnote: new Set(), endnote: new Set() };
  let length = 0;
  const append = text => {
    length += text.length;
    if (length > attachmentLimits.extractedTextChars) throw new Error('文件文字超過 1,000,000 字元解析上限。');
    if (text) parts.push(text);
  };
  const parsePart = async (name, root, selected) => {
    const stream = await archive.stream(name), parser = sax.parser(true, { xmlns: true, strictEntities: true });
    const stack = [];
    let decoder, active = !selected;
    const suppressed = () => stack.some(node => isWord(node) && ['del', 'moveFrom'].includes(node.local));
    parser.onerror = () => { throw new Error('Word XML 格式不正確。'); };
    parser.ondoctype = () => { throw new Error('Word XML 不允許 DTD 或自訂實體。'); };
    parser.onopentag = node => {
      stack.push(node);
      if (stack.length > 128) throw new Error('Word XML 巢狀層級過深。');
      if (stack.length === 1 && (!isWord(node) || node.local !== root)) throw new Error('檔案不是有效的 Word 文件。');
      if (!isWord(node)) return;
      if (selected && ['footnote', 'endnote'].includes(node.local)) {
        const id = noteId(node); active = selected.has(id);
        if (active) append(`\n${node.local === 'footnote' ? '註腳' : '尾註'} ${id}：\n`);
      }
      if (!active || suppressed()) return;
      if (node.local === 'tab') append('\t');
      if (['br', 'cr'].includes(node.local)) append('\n');
      for (const kind of ['footnote', 'endnote']) if (node.local === `${kind}Reference`) {
        const id = noteId(node);
        if (id && !notes[kind].has(id)) { notes[kind].add(id); append(`[${kind === 'footnote' ? '註腳' : '尾註'} ${id}]`); }
      }
    };
    parser.onclosetag = () => {
      const node = stack.at(-1);
      if (active && !suppressed() && isWord(node)) {
        if (node.local === 'p') append('\n\n');
        if (node.local === 'tc') append('\t');
        if (node.local === 'tr') append('\n');
      }
      if (selected && isWord(node) && ['footnote', 'endnote'].includes(node.local)) active = false;
      stack.pop();
    };
    const text = value => { const node = stack.at(-1); if (active && !suppressed() && isWord(node) && node.local === 't') append(value); };
    parser.ontext = text; parser.oncdata = text;
    try {
      // SAX retains only the current XML stack; images and unused package parts stay compressed.
      for await (const chunk of stream) {
        decoder ||= new TextDecoder(chunk[0] === 0xff && chunk[1] === 0xfe ? 'utf-16le' : chunk[0] === 0xfe && chunk[1] === 0xff ? 'utf-16be' : 'utf-8', { fatal: true });
        parser.write(decoder.decode(chunk, { stream: true }));
      }
      parser.write(decoder?.decode() || '').close();
    } finally { stream.destroy(); }
  };
  try {
    await parsePart('word/document.xml', 'document');
    for (const kind of ['footnote', 'endnote']) if (notes[kind].size) await parsePart(`word/${kind}s.xml`, `${kind}s`, notes[kind]);
    const text = parts.join('');
    if (!text.trim()) throw new Error('Word 沒有可讀文字，請改用文件圖片或含文字的 PDF。');
    return text;
  } finally { archive.close(); }
}
