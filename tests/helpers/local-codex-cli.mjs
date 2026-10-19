import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex-cli 0.161.0'); process.exit(0); }
if (process.argv.includes('login')) { console.log('Mock Codex login is ready.'); process.exit(0); }
let threadId, turnId, toolSequence = 0, peerTaskId, waiting;
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const notify = (method, params) => send({ method, params: { threadId, turnId, ...params } });
const finish = text => { notify('item/completed', { item: { id: 'answer', type: 'agentMessage', text } }); notify('turn/completed', { turn: { id: turnId, status: 'completed' } }); };
const call = (tool, args) => { waiting = ++toolSequence; send({ id: `tool-${waiting}`, method: 'item/tool/call', params: { threadId, turnId, callId: `call-${waiting}`, tool, arguments: args } }); };
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ id: request.id, result: {} });
  else if (['thread/start', 'thread/resume'].includes(request.method)) { threadId = request.params.threadId || `local-${process.pid}`; send({ id: request.id, result: { thread: { id: threadId } } }); }
  else if (request.method === 'turn/start') {
    turnId = `${threadId}:turn-1`; send({ id: request.id, result: { turn: { id: turnId } } }); notify('turn/started', { turn: { id: turnId } });
    const prompt = request.params.input[0].text;
    if (prompt === '[large-stream]') {
      const block = '本機大型輸出 ' + 'x'.repeat(32768);
      for (let index = 0; index < 160; index++) notify('item/commandExecution/outputDelta', { itemId: 'large-command', delta: block });
      notify('item/completed', { item: { id: 'large-command', type: 'commandExecution', command: 'fixture-local-log', aggregatedOutput: block.repeat(160) } });
      finish('本機大型串流已完成。');
    } else if (prompt.includes('[cooperate]')) call('cozypad_delegate', { prompt: prompt.includes('[cancel]') ? '[question]' : 'peer-work' });
    else if (!prompt.includes('[hang]')) finish(`Local fixture: ${prompt}`);
  } else if (request.method === 'turn/interrupt') { send({ id: request.id, result: {} }); notify('turn/completed', { turn: { id: turnId, status: 'interrupted' } }); }
  else if (request.method === 'model/list') send({ id: request.id, result: { data: [{ model: 'local-fixture', displayName: 'Local Fixture', isDefault: true, supportedReasoningEfforts: [] }], nextCursor: null } });
  else if (request.method === 'thread/delete') send({ id: request.id, result: {} });
  else if (request.id === `tool-${waiting}`) {
    const result = JSON.parse(request.result.contentItems[0].text);
    if (!peerTaskId) { peerTaskId = result.taskId; call('cozypad_peer_status', { taskId: peerTaskId }); }
    else if (result.status === 'running') call('cozypad_peer_status', { taskId: peerTaskId });
    else finish(`Peer result: ${result.summary}`);
  }
});
