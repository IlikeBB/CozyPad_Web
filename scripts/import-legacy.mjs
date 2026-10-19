import { readFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JsonStore, userId } from '../apps/server/src/storage/json-store.mjs';
import { KeyVault } from '../apps/server/src/storage/key-vault.mjs';
import { ProfileRepository } from '../apps/server/src/ssh/profile-repository.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = path.resolve(process.argv[2] || '../CozyPad_Project/CozyPad_Web');
const target = path.join(root, 'data');
const store = new JsonStore(target);
if (Object.keys(await store.read('auth-users.json', {})).length) throw new Error('Target already has users. Refusing to overwrite existing data.');
const users = JSON.parse(await readFile(path.join(source, 'data/auth-users.json'), 'utf8'));
const vault = new KeyVault(target);
await vault.initialize();
const profiles = new ProfileRepository(store, vault);
function knownFingerprints(raw, host, port) {
  const target = port === 22 ? host : `[${host}]:${port}`;
  return raw.split(/\r?\n/).flatMap(line => {
    const [hosts, type, encoded] = line.trim().split(/\s+/);
    if (!encoded || !type?.startsWith('ssh-') && !type?.startsWith('ecdsa-')) return [];
    const matches = hosts.split(',').some(item => {
      if (!item.startsWith('|1|')) return item === target;
      const [, , salt, digest] = item.split('|');
      return salt && digest && crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(target).digest('base64') === digest;
    });
    return matches ? [`SHA256:${crypto.createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('base64').replace(/=+$/, '')}`] : [];
  });
}
let imported = 0;
const warnings = [];
for (const user of Object.values(users)) {
  const owner = userId(user.username);
  const sourceDirectory = path.join(source, 'data/users', owner);
  let records;
  try { records = JSON.parse(await readFile(path.join(sourceDirectory, 'ssh-servers.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; records = []; }
  for (const record of records) {
    if (record.localOnly || !record.identityFile) { warnings.push(`${owner}/${record.name}: no SSH key`); continue; }
    const keyName = path.basename(record.identityFile.replace(/\\/g, '/'));
    let privateKey;
    try { privateKey = await readFile(path.join(sourceDirectory, 'keys', keyName), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; warnings.push(`${owner}/${record.name}: key missing`); continue; }
    let knownHosts = '';
    try { knownHosts = await readFile(path.join(sourceDirectory, 'known_hosts'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await profiles.save(owner, { name: record.name || record.alias || record.host, host: record.host, port: record.port || 22,
      username: record.user || record.username, defaultPath: record.defaultPath || '~', privateKey, keyName },
      { fingerprints: knownFingerprints(knownHosts, record.host, Number(record.port || 22)), migration: true });
    const destination = path.join(target, 'users', owner);
    await mkdir(path.join(destination, 'public-keys'), { recursive: true, mode: 0o700 });
    try { await copyFile(path.join(sourceDirectory, 'keys', `${keyName}.pub`), path.join(destination, 'public-keys', `${keyName}.pub`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    imported++;
  }
  const destination = path.join(target, 'users', owner);
  await mkdir(destination, { recursive: true, mode: 0o700 });
}
await store.write('auth-users.json', users);
console.log(`Imported ${Object.keys(users).length} users and ${imported} SSH profiles into ${target}.`);
for (const warning of warnings) console.warn(warning);
console.log('Passwords and authenticator registrations preserved. Sessions and trusted browsers were not imported.');
