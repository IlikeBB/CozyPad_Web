import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { connectorArchive } from './connector-archive.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { manifest, data } = await connectorArchive(root);
await mkdir(path.join(root, '.run-logs'), { recursive: true });
await writeFile(path.join(root, '.run-logs/cozypad-local-connector.zip'), data);
await writeFile(path.join(root, '.run-logs/connector-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(`Connector package built: protocol ${manifest.protocol}, ${Object.keys(manifest.hashes).length} files`);
