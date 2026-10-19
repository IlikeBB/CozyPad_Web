export const generatedDocument = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0xff, 0x80, 0x01]);
export const unusualName = '結果 + # ?.docx';
const encodePath = value => value.split('/').map(encodeURIComponent).join('/');
export const downloadReply = [
  '[下載 PDF](/home/tester/report.pdf)',
  `[下載 Word](${encodePath(`downloads/${unusualName}`)})`,
  '[下載 PPTX](sandbox:/mnt/data/slides.pptx)',
  '[file URL](file:///home/tester/readme.txt)',
  '[程式碼引用](/home/tester/readme.txt:1:2)',
  '[舊工作目錄](/home/tester/older/readme.txt#L1)',
  '[找不到的檔案](/home/tester/missing.docx)',
  '[目錄不是檔案](/home/tester)',
  '[外部網站](https://example.com/docs)',
  '[不安全連結](javascript:alert%281%29)'
].join('\n\n');
export function seedDownloadFiles(fixture) {
  fixture.fileMap.set('/home/tester/report.pdf', Buffer.from('%PDF-1.7\nfixture output\n'));
  fixture.fileMap.set(`/home/tester/my project/downloads/${unusualName}`, generatedDocument);
  fixture.fileMap.set('/mnt/data/slides.pptx', generatedDocument);
  fixture.fileMap.set('/home/tester/older/readme.txt', Buffer.from('older working directory\n'));
  fixture.directories.set('/home/tester/my project', 0o700);
  fixture.directories.set('/home/tester/my project/downloads', 0o700);
}
