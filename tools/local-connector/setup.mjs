import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ConnectorFilesystem } from './filesystem.mjs';
import { codexExecutable } from './codex-processes.mjs';

export const pairingCode = value => typeof value === 'string' && /^[A-Za-z0-9_-]{32}$/.test(value.trim());
export const normalizeProject = value => String(value || '').trim().replace(/^"(.*)"$/, '$1');
export async function chooseProject(ask, report, picker = folderPicker) {
  let pastedCode;
  for (;;) {
    const answer = normalizeProject(await ask('步驟 1：請輸入專案資料夾的完整路徑（不是配對碼；Enter 開啟資料夾選擇）：'));
    if (pairingCode(answer)) { pastedCode = answer; report('這是配對碼，已暫存。請先選擇專案資料夾。'); continue; }
    const directory = answer || await picker();
    if (!directory || !path.isAbsolute(directory)) { report('請提供存在的專案資料夾完整路徑。'); continue; }
    try { const filesystem = await ConnectorFilesystem.create([directory]); return { filesystem, pastedCode }; }
    catch { report('此資料夾不存在或不允許授權。請重新選擇專案資料夾，不要選整個磁碟或使用者目錄。'); }
  }
}
async function folderPicker() {
  if (process.platform !== 'win32') return '';
  const script = "Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); $picker=New-Object Windows.Forms.FolderBrowserDialog; $picker.Description='Select a project folder for CozyPadTT'; try { if($picker.ShowDialog() -eq 'OK'){ [Console]::Write($picker.SelectedPath) } } finally {$picker.Dispose()}";
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
    let output = ''; child.stdout.on('data', data => { output += data; });
    child.once('error', reject); child.once('close', code => code ? reject(new Error('資料夾選擇失敗。')) : resolve(output.trim()));
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'validate-root': { type: 'string' }, 'codex-command': { type: 'boolean' } } });
    if (values['validate-root']) { const filesystem = await ConnectorFilesystem.create([values['validate-root']]); await filesystem.close(); }
    else if (values['codex-command']) {
      const command = codexExecutable(), result = spawnSync(command.executable, [...command.prefix, '--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      if (result.status !== 0 || !/^codex-cli \d+\.\d+\.\d+/.test(result.stdout.trim())) throw new Error('Codex unavailable');
      console.log(JSON.stringify(command));
    }
    else throw new Error('Unsupported setup operation');
  } catch { process.exitCode = 1; }
}
