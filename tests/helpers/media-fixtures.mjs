import { readFileSync } from 'node:fs';

export const mediaRoot = '/home/tester/media files';
export const mediaImageName = '圖片 + # 測試.SVG';
export const mediaVideoName = '影片 + # 測試.webm';
export const mediaMp4Name = '影片播放測試.mp4';
export const mediaPngName = '圖片預覽測試.png';
export const mediaSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#172a22"/><circle cx="320" cy="160" r="88" fill="#75dfa9"/><text x="320" y="300" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#e3eae5">CozyPad Media Preview</text></svg>', 'utf8');
export const mediaVideo = readFileSync(new URL('./media-sample.webm', import.meta.url));
export const mediaMp4 = readFileSync(new URL('./media-sample.mp4', import.meta.url));
export function seedMediaFiles(fixture) {
  fixture.directories.set(mediaRoot, 0o700);
  fixture.fileMap.set(`${mediaRoot}/${mediaImageName}`, mediaSvg);
  fixture.fileMap.set(`${mediaRoot}/${mediaVideoName}`, mediaVideo);
  fixture.fileMap.set(`${mediaRoot}/${mediaMp4Name}`, mediaMp4);
  fixture.fileMap.set(`${mediaRoot}/${mediaPngName}`, readFileSync(new URL('../../apps/app/public/favicon.png', import.meta.url)));
  fixture.directories.set(`${mediaRoot}/directory.png`, 0o700);
  fixture.fileMap.set(`${mediaRoot}/損壞的影片.mp4`, Buffer.from('This is deliberately not a video.'));
  fixture.fileMap.set(`${mediaRoot}/損壞的圖片.png`, Buffer.from('This is deliberately not a PNG.'));
  fixture.fileMap.set(`${mediaRoot}/plain.txt`, Buffer.from('MEDIA_TEXT_EDITOR_REGRESSION\n', 'utf8'));
  fixture.fileMap.set(`${mediaRoot}/README.md`, Buffer.from('# 媒體預覽說明\n\n**文字與 Markdown 仍可開啟。**\n', 'utf8'));
}
