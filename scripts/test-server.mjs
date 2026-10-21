import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JsonStore } from '../apps/server/src/storage/json-store.mjs';
import { KeyVault } from '../apps/server/src/storage/key-vault.mjs';
import { ProfileRepository } from '../apps/server/src/ssh/profile-repository.mjs';
import { sshFixture } from '../tests/helpers/ssh-fixture.mjs';
import { seedDownloadFiles } from '../tests/helpers/download-fixtures.mjs';
import { seedSearchFiles, searchRoot } from '../tests/helpers/search-fixtures.mjs';
import { seedMarkdownBrowser, markdownRoot as markdownBrowserRoot } from '../tests/helpers/markdown-browser-fixtures.mjs';
import { seedMediaFiles, mediaRoot } from '../tests/helpers/media-fixtures.mjs';
import { seedFileMoves } from '../tests/helpers/file-move-fixtures.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), 'cozypad-tt-browser-'));
const fixture = await sshFixture(), store = new JsonStore(directory), vault = new KeyVault(directory);
fixture.directories.set('/home/tester/projects', 0o700);
seedDownloadFiles(fixture);
seedSearchFiles(fixture);
seedMarkdownBrowser(fixture);
seedMediaFiles(fixture);
await vault.initialize();
const salt = 'browser-test-salt';
const user = { username: 'tester', role: 'user', salt, passwordHash: crypto.scryptSync('test-password', salt, 64).toString('base64url'),
  twoFactor: { enabled: true, secretBase32: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' } };
await store.write('auth-users.json', { tester: user, other: { ...user, username: 'other' }, downloader: { ...user, username: 'downloader' }, download_other: { ...user, username: 'download_other' }, folders: { ...user, username: 'folders' }, folder_other: { ...user, username: 'folder_other' } });
await store.update('auth-users.json', {}, users => { users.delegator = { ...user, username: 'delegator' }; });
await store.update('auth-users.json', {}, users => { for (const username of ['questioner', 'question_other', 'gpu_questioner', 'random_questioner', 'question_modal', 'question_modal_cancel', 'question_modal_legacy']) users[username] = { ...user, username }; });
await store.update('auth-users.json', {}, users => { users.finder = { ...user, username: 'finder' }; });
await store.update('auth-users.json', {}, users => { for (const username of ['collaborator', 'directory_user', 'directory_fallback', 'directory_slow', 'markdown_reader']) users[username] = { ...user, username }; });
await store.update('auth-users.json', {}, users => { for (const username of ['terminal_idle', 'terminal_recovery', 'terminal_timeout', 'terminal_resume', 'terminal_retries']) users[username] = { ...user, username }; });
await store.update('auth-users.json', {}, users => { for (const username of ['send_state', 'send_feedback']) users[username] = { ...user, username }; });
await store.update('auth-users.json', {}, users => { for (const username of ['monitor_user', 'monitor_missing']) users[username] = { ...user, username }; });
await store.update('auth-users.json', {}, users => { users.terminal_bottom = { ...user, username: 'terminal_bottom' }; });
await store.update('auth-users.json', {}, users => { for (const username of ['explorer_tabs', 'explorer_race', 'explorer_files']) users[username] = { ...user, username }; });
await store.update('auth-users.json', {}, users => {
  for (const username of ['issue_reporter', 'issue_other', 'issue_admin']) users[username] = { ...user, username, role: username === 'issue_admin' ? 'admin' : 'user' };
});
const localRoot = path.join(directory, 'local-project'); await mkdir(path.join(localRoot, 'sub'), { recursive: true });
await writeFile(path.join(localRoot, 'sub', 'note.txt'), 'Local browser fixture content', 'utf8');
const markdownRoot = path.join(directory, 'markdown_bank'); await mkdir(path.join(markdownRoot, 'sub'), { recursive: true });
for (let index = 0; index < 6; index++) await writeFile(path.join(markdownRoot, `筆記-${index}.md`), `# 本機 MD ${index}\nPHYSICAL_MARKDOWN_${index}\n中文內容-${index}`, 'utf8');
await writeFile(path.join(markdownRoot, 'sub', 'nested.md'), '# 子資料夾\nPHYSICAL_NESTED_MARKDOWN', 'utf8');
await store.write(store.userPath('collaborator', 'local-devices.json'), [{ id: 'local-fixture', name: 'Former Local Fixture', roots: [localRoot], platform: process.platform, tokenDigest: 'inert-fixture' }]);
const profiles = new ProfileRepository(store, vault);
for (const username of ['move_files', 'move_agents', 'move_errors', 'move_slow']) {
  const moveRoot = `/home/tester/${username}`; seedFileMoves(fixture, moveRoot);
  await store.update('auth-users.json', {}, users => { users[username] = { ...user, username }; });
  await profiles.save(username, { name: 'File Move Fixture', host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: moveRoot, privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
}
for (const username of ['media_files', 'media_agents', 'media_errors', 'media_owner']) {
  await store.update('auth-users.json', {}, users => { users[username] = { ...user, username }; });
  await profiles.save(username, { name: 'Media Preview Fixture', host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: mediaRoot, privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
}
for (const username of ['md_browser_remote', 'md_browser_local', 'md_browser_edit', 'md_agent_preview']) {
  await store.update('auth-users.json', {}, users => { users[username] = { ...user, username }; });
  await profiles.save(username, { name: 'Markdown Browser Fixture', host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: username === 'md_agent_preview' ? '/home/tester/explorer-project' : markdownBrowserRoot, privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
}
for (const username of ['steering_user', 'steering_reject', 'steering_race', 'steering_retry', 'choice_crop', 'choice_legacy', 'choice_crop_reject', 'choice_initialization', 'stream_output']) {
  await store.update('auth-users.json', {}, users => { users[username] = { ...user, username }; });
  await profiles.save(username, { name: 'Steering Fixture', host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: '/home/tester', privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
}
const profile = await profiles.save('tester', { name: 'Fixture', host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: '~', privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
await profiles.save('downloader', { name: 'Download Fixture', host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: '~', privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
fixture.directories.set('/home/tester/folder-tests', 0o700);
await profiles.save('folders', { name: 'Folder Fixture', host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: '/home/tester/folder-tests', privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
for (const name of ['Delegation Fixture', 'Second Fixture']) await profiles.save('delegator', { name, host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: '~', privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
await profiles.save('questioner', { name: 'Question Fixture', host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: '~', privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
for (const username of ['question_modal', 'question_modal_cancel', 'question_modal_legacy']) await profiles.save(username, { name: 'Question Modal Fixture', host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: '~', privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
await profiles.save('gpu_questioner', { name: 'GPU Question Fixture', host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: '~', privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
await profiles.save('random_questioner', { name: 'Random Choice Fixture', host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: '~', privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
await profiles.save('finder', { name: 'Search Fixture', host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: searchRoot, privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
await profiles.save('collaborator', { name: 'Peer Fixture', host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: '/home/tester', privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
await profiles.save('collaborator', { name: 'Primary Fixture', host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: '/home/tester', privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
await profiles.save('directory_user', { name: 'Directory Fixture', host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: '/home/tester', privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
await profiles.save('directory_user', { name: 'Other Directory Fixture', host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: '/home/tester', privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
await profiles.save('directory_fallback', { name: 'Directory Fixture', host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: '/home/tester', privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
await profiles.save('directory_slow', { name: 'Slow Directory Fixture', host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: '/home/tester', privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
await profiles.save('markdown_reader', { name: 'Markdown Fixture', host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: '/home/tester', privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
for (const username of ['terminal_idle', 'terminal_recovery', 'terminal_timeout', 'terminal_resume', 'terminal_retries']) await profiles.save(username, { name: 'Terminal Fixture', host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: '/home/tester', privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
for (const username of ['monitor_user', 'monitor_missing']) await profiles.save(username, { name: 'Monitor Fixture', host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: '/home/tester', privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
await profiles.save('terminal_bottom', { name: 'Terminal Layout Fixture', host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: '/home/tester', privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
const explorerRoot = '/home/tester/explorer-project';
for (const directory of [explorerRoot, `${explorerRoot}/src`, `${explorerRoot}/notes`, `${explorerRoot}/blocked`]) fixture.directories.set(directory, 0o700);
fixture.fileMap.set(`${explorerRoot}/README.md`, Buffer.from('# 專案說明\n\n這是 SSH 檔案預覽測試。\n', 'utf8'));
fixture.fileMap.set(`${explorerRoot}/src/tool.py`, Buffer.from('def greet():\n    return "中文預覽"\n', 'utf8'));
fixture.fileMap.set(`${explorerRoot}/src/second.py`, Buffer.from('SECOND_PREVIEW_MARKER\n', 'utf8'));
fixture.fileMap.set(`${explorerRoot}/notes/筆記.md`, Buffer.from('# 筆記\n\n目前資料夾內容。\n', 'utf8'));
for (const username of ['explorer_tabs', 'explorer_race', 'explorer_files']) await profiles.save(username, { name: 'Explorer Fixture', host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: explorerRoot, privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
for (const username of ['send_state', 'send_feedback']) {
  const primary = await profiles.save(username, { name: 'Send Primary', host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: '/home/tester', privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
  await profiles.save(username, { name: 'Send Peer', host: '127.0.0.1', port: fixture.port, username: 'tester', defaultPath: '/home/tester', privateKey: fixture.privateKey }, { fingerprints: [fixture.fingerprint] });
  await store.write(store.userPath(username, 'codex-chats.json'), [{ id: crypto.randomUUID(), serverId: primary.id, prompt: '已完成的一般對話', path: '/home/tester', status: 'completed', executionMode: 'general', createdAt: Date.now(), updatedAt: Date.now(), events: [], eventSequence: 0, turnCount: 1 }]);
}
await mkdir(path.join(root, '.run-logs'), { recursive: true });
await writeFile(path.join(root, '.run-logs/browser-fixture.json'), JSON.stringify({ ...fixture, close: undefined, fileMap: undefined, profileId: profile.id, localRoot, markdownRoot }), { encoding: 'utf8', mode: 0o600 });
const child = spawn(process.execPath, ['apps/server/src/index.mjs'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, COZYPAD_DATA_DIR: directory, COZYPAD_HOST: '127.0.0.1', COZYPAD_API_PORT: '5684', COZYPAD_WEB_PORT: '5684', COZYPAD_COOKIE_SECURE: 'false', COZYPAD_PUBLIC_ORIGIN: '' }
});
let closing = false;
async function stop() {
  if (closing) return; closing = true; child.kill(); await fixture.close(); await rm(directory, { recursive: true, force: true });
}
child.on('exit', () => { void stop(); });
process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); });
