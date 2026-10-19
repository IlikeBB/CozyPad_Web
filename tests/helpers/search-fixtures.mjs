export const searchRoot = '/home/tester/search-project';
export function seedSearchFiles(fixture) {
  for (const subdirectory of ['', '/src', '/node_modules', '/.git']) fixture.directories.set(`${searchRoot}${subdirectory}`, 0o755);
  for (const [name, data] of [
    ['/README.md', Buffer.from('needle main\nOther\n')],
    ['/src/main.py', Buffer.from('needle first\nsecond needle\nNEEDLE uppercase\n')],
    ['/src/notes.md', Buffer.from('中文 needle\n')],
    ['/.env', Buffer.from('secret needle')],
    ['/node_modules/dependency.py', Buffer.from('private dependency needle')],
    ['/.git/config', Buffer.from('private config needle')],
    ['/large.md', Buffer.alloc(1048577, 65)],
    ['/binary.md', Buffer.from([0, 110, 101, 101, 100, 108, 101])],
    ['/legacy.md', Buffer.from([255, 110, 101, 101, 100, 108, 101])],
    ['/link.md', Buffer.from('symlink needle')]
  ]) fixture.fileMap.set(`${searchRoot}${name}`, data);
  fixture.symlinks.add(`${searchRoot}/link.md`);
}
