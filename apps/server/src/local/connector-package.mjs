import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { connectorFiles, connectorProtocol, connectorRelease } from '../../../../packages/contracts/src/connector-protocol.mjs';

export async function connectorIdentity(root) {
  const hashes = {};
  for (const file of connectorFiles) hashes[file] = crypto.createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
  return { protocol: connectorProtocol, release: connectorRelease, payloadHash: crypto.createHash('sha256').update(JSON.stringify(hashes)).digest('hex'), hashes };
}
