import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const downloadFolderName = "資料 ' ; $(literal) + #";
export const downloadFileName = '單檔 + #.bin';
export const nestedText = '巢狀內容完整保留\n';
const shellWord = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
export const expectedArchiveCommand = directory => `unset TAR_OPTIONS; exec tar -czf - -C ${shellWord(path.posix.dirname(directory))} -- ${shellWord(path.posix.basename(directory))}`;

export async function seedFolderDownloads(fixture, root) {
  const temporary = path.resolve(await mkdtemp(path.join(os.tmpdir(), 'cozypad-download-fixture-')));
  if (!temporary.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(temporary).startsWith('cozypad-download-fixture-')) throw new Error('Unsafe fixture directory');
  const directory = `${root}/${downloadFolderName}`;
  let archive;
  try {
    const local = path.join(temporary, downloadFolderName);
    await mkdir(path.join(local, 'nested', 'empty'), { recursive: true });
    await writeFile(path.join(local, 'nested', '筆記.txt'), nestedText, 'utf8');
    await writeFile(path.join(local, '.hidden'), 'HIDDEN_FILE_RETAINED', 'utf8');
    await writeFile(path.join(local, 'nested', 'binary.bin'), randomBytes(5 * 1048576 + 17));
    archive = execFileSync('tar', ['-czf', '-', '-C', temporary, '--', downloadFolderName], { maxBuffer: 8 * 1048576 });
  } finally { await rm(temporary, { recursive: true, force: true }); }
  for (const value of [root, directory, `${directory}/nested`, `${directory}/nested/empty`]) fixture.directories.set(value, 0o700);
  fixture.fileMap.set(`${directory}/nested/筆記.txt`, Buffer.from(nestedText, 'utf8'));
  fixture.fileMap.set(`${root}/${downloadFileName}`, Buffer.alloc(11 * 1048576 + 5, 42));
  fixture.fileMap.set(`${root}/empty.txt`, Buffer.alloc(0));
  fixture.folderArchives.set(expectedArchiveCommand(directory), archive);
  return { directory, archive };
}
