import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';

async function dpapi(data, protect) {
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $data=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[Security.Cryptography.ProtectedData]::${protect ? 'Protect' : 'Unprotect'}($data,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($result));`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'pipe' });
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Windows credential protection timed out')); }, 10000);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 65536) child.kill(); });
    child.stdin.on('error', () => {});
    child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', code => { clearTimeout(timer); code ? reject(new Error('Windows credential protection failed')) : resolve(Buffer.from(output.trim(), 'base64')); });
    child.stdin.end(data.toString('base64'));
  });
}
export async function readCredentials(file) {
  try { const data = await readFile(file); return JSON.parse((process.platform === 'win32' ? await dpapi(data, false) : data).toString('utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function saveCredentials(file, credentials) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const data = Buffer.from(JSON.stringify(credentials));
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { await writeFile(temporary, process.platform === 'win32' ? await dpapi(data, true) : data, { mode: 0o600, flag: 'wx' }); await rename(temporary, file); }
  finally { await unlink(temporary).catch(() => {}); }
}
