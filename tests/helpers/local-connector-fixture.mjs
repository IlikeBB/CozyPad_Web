import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ConnectorCodex } from '../../tools/local-connector/codex-processes.mjs';
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const { WebSocket } = require('ws');
export async function localConnectorFixture(url, identity, filesystem, auth) {
  const socket = new WebSocket(url), requests = [], send = value => { if (socket.readyState === 1) socket.send(JSON.stringify(value)); };
  const codex = new ConnectorCodex(filesystem, send, { executable: { executable: process.execPath, prefix: [fileURLToPath(new URL('local-codex-cli.mjs', import.meta.url))] } });
  const ready = new Promise((resolve, reject) => {
    socket.once('error', reject); socket.once('close', () => reject(new Error('Fixture handshake rejected')));
    socket.on('open', () => send({ type: 'hello', ...identity, ...auth, metadata: { name: 'Local Fixture', platform: process.platform, roots: filesystem.roots.map(root => filesystem.virtual(root)) } }));
    socket.on('message', async raw => {
      const request = JSON.parse(raw.toString());
      if (request.type === 'ready') { resolve(request); return; }
      requests.push(request);
      try {
        let value;
        if (request.method === 'codex.open') value = await codex.open(request.params);
        else if (request.method === 'codex.write') value = await codex.write(request.params);
        else if (request.method === 'codex.close') value = codex.stop(request.params.channel);
        else value = await filesystem.call(request.method.slice(3), request.params);
        if (request.type === 'request') send({ type: 'response', id: request.id, value });
      } catch (error) {
        if (request.type === 'request') send({ type: 'response', id: request.id, error: { message: error.message, code: error.code, status: error.status } });
        else { codex.stop(request.params.channel); send({ type: 'event', channel: request.params.channel, event: 'exit', error: error.message }); }
      }
    });
  });
  try {
    const credentials = await ready;
    return { socket, requests, credentials, codex, async close() { socket.close(); await codex.close(); await filesystem.close(); } };
  } catch (error) { socket.terminate(); await codex.close(); throw error; }
}
