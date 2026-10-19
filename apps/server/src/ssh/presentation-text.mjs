import path from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { attachmentLimits } from '../../../../packages/contracts/src/attachments.mjs';
import { readOfficeArchive } from './office-archive.mjs';

const namespaces = {
  presentation: ['http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main'],
  drawing: ['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main'],
  relationship: ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships']
};
const elements = (node, kind, name) => Array.from(node.getElementsByTagNameNS('*', name)).filter(element => namespaces[kind].includes(element.namespaceURI));
function xml(data) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('簡報 XML 不允許 DTD 或自訂實體。');
  return new DOMParser({ onError: () => { throw new Error('簡報 XML 格式不正確。'); } }).parseFromString(text, 'application/xml');
}
function target(part, relationship) {
  if (relationship.getAttribute('TargetMode') === 'External') throw new Error('簡報頁面或備註不能來自外部連結。');
  const value = decodeURIComponent(relationship.getAttribute('Target'));
  if (!value || /[\\\x00-\x1f?#]/.test(value)) throw new Error('簡報內部路徑不正確。');
  const name = path.posix.normalize(value.startsWith('/') ? value.slice(1) : path.posix.join(path.posix.dirname(part), value));
  if (!name.startsWith('ppt/')) throw new Error('簡報內部路徑超出允許範圍。');
  return name;
}
function relationships(files, part) {
  const name = path.posix.join(path.posix.dirname(part), '_rels', `${path.posix.basename(part)}.rels`);
  if (!files.has(name)) return new Map();
  const result = new Map();
  for (const element of Array.from(xml(files.get(name)).getElementsByTagNameNS('http://schemas.openxmlformats.org/package/2006/relationships', 'Relationship'))) {
    const id = element.getAttribute('Id');
    if (!id || result.has(id)) throw new Error('簡報關聯 ID 不正確。');
    result.set(id, element);
  }
  return result;
}
function slideText(document) {
  return elements(document, 'drawing', 'p').map(paragraph => {
    let text = '';
    for (const element of Array.from(paragraph.getElementsByTagNameNS('*', '*'))) {
      if (!namespaces.drawing.includes(element.namespaceURI)) continue;
      if (element.localName === 't') text += element.textContent;
      if (element.localName === 'br') text += '\n';
    }
    return text;
  }).filter(text => text.trim()).join('\n');
}
export async function extractPresentation(data) {
  const files = await readOfficeArchive(data, 'ppt/presentation.xml', name => name.startsWith('ppt/') && /\.(xml|rels)$/.test(name));
  const presentation = xml(files.get('ppt/presentation.xml'));
  const slides = elements(presentation, 'presentation', 'sldId');
  if (!slides.length) throw new Error('簡報沒有投影片。');
  if (slides.length > 100) throw new Error('簡報超過 100 頁上限。');
  const links = relationships(files, 'ppt/presentation.xml'), pages = [];
  let length = 0, readable = false;
  for (const [index, slide] of slides.entries()) {
    const id = namespaces.relationship.map(namespace => slide.getAttributeNS(namespace, 'id')).find(Boolean);
    const link = links.get(id);
    if (!link?.getAttribute('Type').endsWith('/slide')) throw new Error('簡報缺少投影片關聯。');
    const name = target('ppt/presentation.xml', link);
    if (!files.has(name)) throw new Error('簡報缺少投影片檔案。');
    const content = slideText(xml(files.get(name))), notes = [];
    for (const noteLink of relationships(files, name).values()) {
      if (!noteLink.getAttribute('Type').endsWith('/notesSlide')) continue;
      const noteName = target(name, noteLink);
      if (!files.has(noteName)) throw new Error('簡報缺少講者備註檔案。');
      const document = xml(files.get(noteName));
      for (const shape of elements(document, 'presentation', 'sp')) {
        if (!elements(shape, 'presentation', 'ph').some(placeholder => placeholder.getAttribute('type') === 'body')) continue;
        notes.push(slideText(shape));
      }
    }
    readable ||= !!content.trim() || notes.some(note => note.trim());
    const page = `第 ${index + 1} 頁\n${content}${notes.some(note => note.trim()) ? `\n講者備註：\n${notes.join('\n')}` : ''}`;
    length += page.length + 1;
    if (length > attachmentLimits.extractedTextChars) throw new Error('文件文字超過 1,000,000 字元解析上限。');
    pages.push(page);
  }
  if (!readable) throw new Error('簡報沒有可讀文字，請改用投影片圖片或含文字的 PDF。');
  return pages.join('\n');
}
