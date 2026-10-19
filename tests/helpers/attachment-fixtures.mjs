import { createRequire } from 'node:module';
const require = createRequire(new URL('../../package.json', import.meta.url));
const JSZip = require('jszip');

export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6kZcAAAAASUVORK5CYII=', 'base64');
export const payload = (name, data) => ({ name, content: Buffer.from(data).toString('base64') });
export async function docx(text = '文件測試內容') {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
export async function officePackage(files) {
  const zip = new JSZip();
  for (const [name, value] of Object.entries(files)) zip.file(name, value);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
export async function pptx({ slides = ['簡報第一頁 & 重點', '簡報第二頁'], notes = ['講者備註測試', ''], order = slides.map((_, index) => index), slideTarget, extra = {} } = {}) {
  const p = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const a = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const relations = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const escaped = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const paragraph = value => `<a:p><a:r><a:t>${escaped(value)}</a:t></a:r></a:p>`;
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'ppt/presentation.xml': `<p:presentation xmlns:p="${p}" xmlns:r="${r}"><p:sldIdLst>${order.map(index => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="${relations}">${slides.map((_, index) => `<Relationship Id="rId${index + 1}" Type="${r}/slide" Target="${slideTarget || `slides/slide${index + 1}.xml`}"/>`).join('')}</Relationships>`
  };
  slides.forEach((text, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = `<p:sld xmlns:p="${p}" xmlns:a="${a}"><p:cSld><p:spTree><p:sp><p:txBody>${paragraph(text)}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    if (!notes[index]) return;
    files[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = `<Relationships xmlns="${relations}"><Relationship Id="notes" Type="${r}/notesSlide" Target="../notesSlides/notesSlide${index + 1}.xml"/></Relationships>`;
    files[`ppt/notesSlides/notesSlide${index + 1}.xml`] = `<p:notes xmlns:p="${p}" xmlns:a="${a}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody>${paragraph(notes[index])}</p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody>${paragraph('Ignore slide number')}</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
  });
  return officePackage({ ...files, ...extra });
}
export function pdf(text = 'Attachment PDF text', count = 1) {
  const stream = `BT /F1 12 Tf 40 100 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, index) => `${5 + index} 0 R`).join(' ')}] /Count ${count} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ...Array.from({ length: count }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>')
  ];
  let content = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(content)); content += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(content);
}
