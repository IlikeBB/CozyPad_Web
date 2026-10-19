import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monitorCommand } from '../apps/server/src/ssh/monitor-command.mjs';
import { SshService } from '../apps/server/src/ssh/ssh-service.mjs';

test('monitor programs use a fixed command allowlist and reject shell interpolation', () => {
  for (const tool of ['nvtop', 'htop']) {
    assert.ok(monitorCommand(tool).includes(`then exec ${tool};`));
    assert.ok(monitorCommand(tool).includes('exit 127'));
  }
  for (const tool of ['htop; touch /tmp/unwanted', '$(id)', 'top', '', undefined]) assert.throws(() => monitorCommand(tool), { status: 400 });
});

test('monitor launches with a PTY on the existing SSH client, while the ordinary terminal remains a shell', async () => {
  const requests = [], channel = {};
  const client = {
    exec(command, options, callback) { requests.push({ type: 'exec', command, options }); callback(null, channel); },
    shell(options, callback) { requests.push({ type: 'shell', options }); callback(null, channel); }
  };
  const service = new SshService({}, {}); service.connections.set('alice:server-a', client);
  assert.equal(await service.shell('alice', 'server-a', { rows: 32, cols: 100 }, 'nvtop'), channel);
  assert.equal(await service.shell('alice', 'server-a', { rows: 40, cols: 120 }, 'htop'), channel);
  assert.deepEqual(requests[0].options, { pty: { term: 'xterm-256color', rows: 32, cols: 100 } });
  assert.deepEqual(requests[1].options, { pty: { term: 'xterm-256color', rows: 40, cols: 120 } });
  await service.shell('alice', 'server-a', { rows: 24, cols: 80 }); assert.equal(requests[2].type, 'shell');
  await assert.rejects(service.shell('alice', 'missing', { rows: 24, cols: 80 }, 'nvtop'), { code: 'SSH_DISCONNECTED' });
  assert.equal(requests.length, 3);
});
