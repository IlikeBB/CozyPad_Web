import { readFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { connectorIdentity } from '../apps/server/src/local/connector-package.mjs';

export async function connectorArchive(root) {
  const manifest = await connectorIdentity(root), archive = new JSZip();
  for (const file of Object.keys(manifest.hashes)) archive.file(file, await readFile(path.join(root, file)));
  archive.file('connector-manifest.json', JSON.stringify(manifest, null, 2));
  archive.file('SETUP.txt', 'Legacy CozyPad local connector test payload.\nThe public CozyPadTT service is browser-only and no longer publishes or accepts connector installations or pairing.\nThis payload is retained for isolated compatibility tests, not required for website use.\n');
  return { manifest, data: await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) };
}
