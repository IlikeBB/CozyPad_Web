import test from 'node:test';
import assert from 'node:assert/strict';
import { groupProcessEvents } from '../apps/app/src/workspaces/process-groups.ts';

const command = (id, text, extra = {}) => ({ id, type: 'command', time: id, text, ...extra });
const event = (id, type, text = type) => ({ id, type, text, time: id });

test('similar shell-wrapped tools form stable groups without changing raw events', () => {
  const first = command(8, "/bin/bash -lc 'pdftotext -f 33 -l 33 -layout /home/tester/report.pdf -'\npage 33", { messageId: 'first', order: 1 });
  const events = [command(3, "/bin/bash -lc 'pdftotext -f 9 -l 9 -layout /home/tester/report.pdf -'\npage 9", { order: 3 }), first];
  const before = structuredClone(events), [group] = groupProcessEvents(events);
  assert.equal(group.label, 'pdftotext'); assert.equal(group.key, 'first'); assert.deepEqual(group.events.map(event => event.id), [8, 3]); assert.deepEqual(events, before);
  const updated = groupProcessEvents([...events, command(10, '/usr/local/bin/pdftotext -f 40 report.pdf -')]);
  assert.equal(updated[0].key, group.key); assert.equal(updated[0].events.length, 2);
  // Different executable paths and different tools are not assumed equivalent.
  assert.equal(updated[1].label, 'pdftotext'); assert.equal(updated.length, 2);
});

test('groups preserve boundaries for errors, approvals, messages, statuses and different operations', () => {
  const events = [command(1, 'pdftotext a.pdf -'), command(2, 'pdftotext b.pdf -'), command(3, 'pdftoppm a.pdf -png'), event(4, 'error'), command(5, 'pdftotext c.pdf -'), event(6, 'approval'), command(7, 'pdftotext d.pdf -'), event(8, 'assistant'), command(9, 'pdftotext e.pdf -'), event(10, 'status'), command(11, 'pdftotext f.pdf -'), event(12, 'user'), command(13, 'pdftotext g.pdf -')];
  const groups = groupProcessEvents(events);
  assert.equal(groups[0].events.length, 2);
  assert.deepEqual(groups.filter(group => group.kind === 'event').map(group => group.event.type), ['error', 'approval', 'assistant', 'user']);
  assert.ok(groups.slice(1).filter(group => group.kind === 'process').every(group => group.events.length === 1));
});

test('directory setup, nested shells, script names and CLI subcommands group conservatively', () => {
  assert.equal(groupProcessEvents([command(1, "bash -lc 'cd /tmp && pdftotext a.pdf -'"), command(2, "bash -lc 'cd /tmp && pdftotext b.pdf -'")])[0].events.length, 2);
  assert.equal(groupProcessEvents([command(1, 'python extract.py a.pdf'), command(2, 'python extract.py b.pdf')])[0].label, 'python extract.py');
  for (const pair of [['python extract.py a', 'python train.py a'], ['python -c "print(1)"', 'python -c "print(2)"'], ['git diff a', 'git status'], ['cat a && rm a', 'cat b && rm b'], ['bash script.sh a', 'bash script.sh b']]) assert.equal(groupProcessEvents(pair.map((text, index) => command(index + 1, text))).length, 2);
  const process = groupProcessEvents([event(1, 'process', 'server: read · completed'), event(2, 'process', 'server: read · completed'), event(3, 'process', 'server: write · completed')]);
  assert.equal(process[0].events.length, 2); assert.equal(process.length, 2);
});
