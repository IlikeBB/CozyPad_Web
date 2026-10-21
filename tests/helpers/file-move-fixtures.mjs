import { mediaSvg } from './media-fixtures.mjs';

export const moveFileName = '拖曳 + # 測試.txt';
export function seedFileMoves(fixture, root) {
  for (const directory of [root, `${root}/archive`, `${root}/other`, `${root}/bundle`, `${root}/bundle/nested`]) fixture.directories.set(directory, 0o700);
  fixture.fileMap.set(`${root}/bundle/nested/note.txt`, Buffer.from('NESTED_CONTENT_PRESERVED\n', 'utf8'));
  fixture.fileMap.set(`${root}/${moveFileName}`, Buffer.from('FILE_MOVE_CONTENT\n', 'utf8'));
  fixture.fileMap.set(`${root}/duplicate.txt`, Buffer.from('SOURCE_RETAINED'));
  fixture.fileMap.set(`${root}/archive/duplicate.txt`, Buffer.from('TARGET_RETAINED'));
  fixture.fileMap.set(`${root}/preview.svg`, mediaSvg);
}
