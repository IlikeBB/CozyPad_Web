import { mediaSvg } from './media-fixtures.mjs';

export const moveFileName = '拖曳 + # 測試.txt';
export function seedFileMoves(fixture, root) {
  for (const directory of [root, `${root}/archive`, `${root}/other`]) fixture.directories.set(directory, 0o700);
  fixture.fileMap.set(`${root}/${moveFileName}`, Buffer.from('FILE_MOVE_CONTENT\n', 'utf8'));
  fixture.fileMap.set(`${root}/duplicate.txt`, Buffer.from('SOURCE_RETAINED'));
  fixture.fileMap.set(`${root}/archive/duplicate.txt`, Buffer.from('TARGET_RETAINED'));
  fixture.fileMap.set(`${root}/preview.svg`, mediaSvg);
}
