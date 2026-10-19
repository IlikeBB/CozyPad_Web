import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { downloadReply } from './download-fixtures.mjs';
import { choiceReply, cropChoiceReply, gpuChoiceReply, initializationChoiceReply, nativeQuestion, professionChoiceReply, professionNativeQuestion, randomChoicePrompt, randomChoiceReply } from './question-fixtures.mjs';
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const { Server, utils } = require('ssh2');
const { STATUS_CODE: STATUS, OPEN_MODE: MODE } = utils.sftp;

export async function sshFixture({ modelError = false, codexVersion = 'codex-cli 0.161.0', delegationBlocked = false, cwd = '/home/tester/my project' } = {}) {
  const makeKey = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1' }).toString();
  const hostKey = makeKey(), privateKey = makeKey(), parsedKey = utils.parseKey(privateKey);
  const fingerprint = `SHA256:${crypto.createHash('sha256').update(utils.parseKey(hostKey).getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
  const clients = new Set();
  const commands = [], modelRequests = [], chatRequests = [], cleanupRequests = [], threads = new Map(), rollouts = new Map();
  const deletion = { error: null, disconnect: false, malformed: false };
  const stats = { connections: 0, authenticated: 0, rejected: 0 };
  const sftpRequests = [];
  const fileMap = new Map([['/home/tester/readme.txt', Buffer.from('CozyPad test file\n')]]);
  const directories = new Map([['/', 0o755], ['/home', 0o755], ['/home/tester', 0o700]]), symlinks = new Set();
  const server = new Server({ hostKeys: [hostKey] }, client => {
    stats.connections++;
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', context => {
      const valid = context.method === 'publickey' && context.username === 'tester' && context.key.data.equals(parsedKey.getPublicSSH()) &&
        (!context.signature || parsedKey.verify(context.blob, context.signature, context.hashAlgo) === true);
      if (valid) context.accept(); else { stats.rejected++; context.reject(); }
    });
    client.on('ready', () => { stats.authenticated++; client.on('session', accept => {
      const session = accept();
      session.on('pty', accept => accept());
      session.on('window-change', accept => accept?.());
      session.on('shell', accept => {
        const stream = accept(); stream.write('SSH fixture ready\r\n$ ');
        stream.on('data', data => stream.write(`${data.toString().trim()}\r\nfixture:/home/tester\r\n$ `));
      });
      session.on('exec', (accept, reject, info) => {
        const stream = accept();
        commands.push(info.command);
        const monitorTool = info.command.startsWith('if command -v nvtop ') ? 'nvtop' : info.command.startsWith('if command -v htop ') ? 'htop' : '';
        if (monitorTool) {
          const lines = monitorTool === 'nvtop' ? [
            '\x1b[1;32mNVTOP fixture — live GPU monitoring\x1b[0m',
            'GPU 0  NVIDIA A100 80GB        Temp 48C   Power 180W / 300W',
            'GPU [|||||||||||||||||||||          68%] MEM [|||||||             18.2G/80G]',
            '', 'PID     USER      GPU    TYPE     GPU MEM    COMMAND',
            '4821    tester    0      Compute  18.2G      python train.py',
            '', 'F1 Help  F2 Setup  F6 Sort  q Quit'
          ] : [
            '\x1b[1;32mHTOP fixture — live process monitoring\x1b[0m',
            'CPU 1 [||||||||||||         41%]  CPU 2 [||||||||           28%]',
            'Mem [||||||||||       32G/128G]  Swp [                     0G/8G]',
            'Tasks: 156, 302 thr; 2 running   Load average: 2.01 1.73 1.48',
            '', 'PID     USER      CPU%    MEM%    TIME+      Command',
            '4821    tester    41.3    25.0    12:35.26   python train.py',
            '', 'F1 Help  F2 Setup  F3 Search  F6 SortBy  F10 Quit'
          ];
          stream.write(`\x1b[2J\x1b[H${lines.join('\r\n')}\r\n`);
          stream.on('data', data => { if (data.toString() === 'q') { stream.exit(0); stream.end(); } });
          return;
        }
        if (info.command.includes('codex app-server')) {
          let pending = '', initialized = false, acknowledged = false, cleanup = false;
          let timer, threadId, turnId, waitingApproval, waitingQuestion, waitingTool, heldTurn;
          const chat = info.command.includes('__COZYPAD_CWD__');
          const send = value => stream.write(`${JSON.stringify(value)}\n`);
          const notify = (method, params) => send({ method, params: { threadId, turnId, ...params } });
          if (chat) stream.write(`__COZYPAD_CWD__${cwd}\n__COZYPAD_CODEX_VERSION__${codexVersion}\n`);
          stream.on('data', data => {
            pending += data.toString();
            const lines = pending.split('\n'); pending = lines.pop();
            for (const line of lines) {
              const request = JSON.parse(line);
              if (request.method === 'initialize') cleanup = request.params.clientInfo.name === 'cozypad_tt_cleanup';
              (cleanup ? cleanupRequests : chat ? chatRequests : modelRequests).push(request);
              if (request.method === 'initialize') { initialized = true; send({ id: request.id, result: { userAgent: 'fixture' } }); }
              else if (request.method === 'initialized' && initialized) acknowledged = true;
              else if (request.method === 'thread/start' || request.method === 'thread/resume') {
                if (!acknowledged) { send({ id: request.id, error: { message: 'Not initialized' } }); continue; }
                if (!['read-only', 'workspace-write', 'danger-full-access'].includes(request.params.sandbox) || !['untrusted', 'on-request', 'never'].includes(request.params.approvalPolicy)) {
                  send({ id: request.id, error: { code: -32602, message: 'Invalid sandbox or approval policy' } }); continue;
                }
                if (request.params.config?.['agents.enabled'] === true && delegationBlocked) {
                  send({ id: request.id, error: { message: 'fixture delegation disabled by administrator' } }); continue;
                }
                threadId = request.params.threadId || `test-thread-${String(threads.size + 1).padStart(2, '0')}`;
                if (!threads.has(threadId)) {
                  const rolloutPath = `/home/tester/.codex/sessions/${threadId}.jsonl`;
                  threads.set(threadId, { turns: 0, rolloutPath }); rollouts.set(rolloutPath, Buffer.from('fixture conversation log\n'));
                }
                Object.assign(threads.get(threadId), { sandbox: request.params.sandbox, approvalPolicy: request.params.approvalPolicy, delegated: request.params.config?.['agents.enabled'] === true, questionsEnabled: request.params.config?.['features.default_mode_request_user_input'] === true });
                send({ id: request.id, result: { thread: { id: threadId } } });
              } else if (request.method === 'thread/delete') {
                if (!acknowledged) { send({ id: request.id, error: { message: 'Not initialized' } }); continue; }
                if (deletion.error) { send({ id: request.id, error: deletion.error }); continue; }
                if (deletion.disconnect) { stream.exit(1); stream.end(); continue; }
                if (deletion.malformed) { send({ id: request.id, result: null }); continue; }
                const ids = new Set([request.params.threadId]);
                for (let size = -1; size !== ids.size;) {
                  size = ids.size;
                  for (const [id, thread] of threads) if (ids.has(thread.parentThreadId)) ids.add(id);
                }
                for (const id of ids) { rollouts.delete(threads.get(id)?.rolloutPath); threads.delete(id); }
                const response = `${JSON.stringify({ id: request.id, result: {} })}\n`;
                stream.write(response.slice(0, 11)); stream.write(response.slice(11));
                for (const id of ids) send({ method: 'thread/deleted', params: { threadId: id } });
              } else if (request.method === 'turn/start') {
                const thread = threads.get(request.params.threadId);
                const prompt = request.params.input[0].text;
                turnId = `${threadId}:turn-${++thread.turns}`;
                send({ id: request.id, result: { turn: { id: turnId, status: 'inProgress' } } });
                notify('turn/started', { turn: { id: turnId, status: 'inProgress' } });
                if (prompt.includes('[disconnect]')) { stream.exit(1); stream.end(); continue; }
                if (prompt === '[large-stream]') {
                  const commandId = `large-command-${thread.turns}`, block = '大型輸出中文 ' + 'x'.repeat(32768);
                  notify('item/started', { item: { id: commandId, type: 'commandExecution', command: 'fixture-large-log' } });
                  for (let index = 0; index < 160; index++) notify('item/commandExecution/outputDelta', { itemId: commandId, delta: block });
                  notify('item/completed', { item: { id: commandId, type: 'commandExecution', command: 'fixture-large-log', aggregatedOutput: block.repeat(160) } });
                  notify('item/completed', { item: { id: 'large-answer', type: 'agentMessage', text: '大型串流已完成，後續回覆仍可收到。' } });
                  notify('turn/completed', { turn: { id: turnId, status: 'completed' } });
                  continue;
                }
                const answer = prompt === randomChoicePrompt ? randomChoiceReply : prompt === '[choice-initialization]' ? initializationChoiceReply : prompt === '[choice-list]' ? choiceReply : prompt === '[choice-continued]' ? gpuChoiceReply : prompt === '[plain-list]' ? '已完成以下項目：\n\n- 整理主檔\n- 檢查回填表' : prompt === '[download-links]' ? downloadReply : `SSH 測試完成：${prompt}`, itemId = `answer-${thread.turns}`;
                const events = prompt.includes('[fail]') ? [
                  ['error', { error: { message: 'fixture turn failed' } }], ['turn/completed', { turn: { id: turnId, status: 'failed', error: { message: 'fixture turn failed' } } }]
                ] : [
                  ['item/started', { item: { id: `command-${thread.turns}`, type: 'commandExecution', command: 'pwd' } }],
                  ['item/commandExecution/outputDelta', { itemId: `command-${thread.turns}`, delta: '/home/tester' }],
                  ['item/completed', { item: { id: `command-${thread.turns}`, type: 'commandExecution', command: 'pwd', aggregatedOutput: '/home/tester' } }],
                  ['item/started', { item: { id: itemId, type: 'agentMessage', text: '' } }],
                  ...(['[download-links]', '[choice-list]', '[choice-continued]', '[choice-initialization]', '[plain-list]', randomChoicePrompt].includes(prompt) ? [answer.slice(0, 60), answer.slice(60)] : ['SSH ', '測試', '完成：', prompt]).map(delta => ['item/agentMessage/delta', { itemId, delta }]),
                  ['item/completed', { item: { id: itemId, type: 'agentMessage', text: answer } }],
                  ['thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 150, cachedInputTokens: 20, outputTokens: 35 } } }],
                  ['turn/completed', { turn: { id: turnId, status: 'completed' } }]
                ];
                if (prompt === '[choice-continued]') {
                  events.splice(-2, 0,
                    ['item/completed', { item: { id: `continued-${thread.turns}`, type: 'agentMessage', text: '我先檢查模型載入與 GPU 設定。' } }],
                    ...Array.from({ length: 24 }, () => ['item/commandExecution/outputDelta', { itemId: `command-${thread.turns}`, delta: '.' }])
                  );
                }
                const childId = `${threadId}:child-${thread.turns}`;
                const delegated = thread.delegated && (prompt.includes('[delegation]') || prompt.includes('[child-approval]'));
                const collab = (id, tool, status, agentStatus, message = '') => ({ id, type: 'collabAgentToolCall', tool, status, senderThreadId: threadId, receiverThreadIds: [childId], model: 'fixture-fast', prompt: '檢查大型文件的指定段落', agentsStates: { [childId]: { status: agentStatus, message } } });
                if (delegated) {
                  const rolloutPath = `/home/tester/.codex/sessions/${childId}.jsonl`;
                  threads.set(childId, { parentThreadId: threadId, rolloutPath }); rollouts.set(rolloutPath, Buffer.from('fixture child log\n'));
                  events.unshift(
                    ['item/started', { item: collab(`spawn-${thread.turns}`, 'spawnAgent', 'inProgress', 'running') }],
                    ['item/completed', { item: collab(`spawn-${thread.turns}`, 'spawnAgent', 'completed', 'running') }],
                    ['item/started', { item: collab(`wait-${thread.turns}`, 'wait', 'inProgress', 'running') }],
                    ['item/completed', { item: collab(`wait-${thread.turns}`, 'wait', 'completed', 'completed', '指定段落已檢查；只回傳摘要與產出位置。') }]
                  );
                }
                if (prompt.includes('[group-tools]')) {
                  const commands = [...[33, 9, 8, 34].map(page => `/bin/bash -lc 'pdftotext -f ${page} -l ${page} -layout /home/tester/report.pdf -'`), "/bin/bash -lc 'pdftoppm -f 8 -l 10 -png /home/tester/report.pdf /tmp/page'"];
                  events.splice(0, 3, ...commands.flatMap((command, index) => {
                    const id = `group-command-${thread.turns}-${index}`, output = `fixture page output ${index + 1}`;
                    return [
                      ['item/started', { item: { id, type: 'commandExecution', command } }],
                      ['item/commandExecution/outputDelta', { itemId: id, delta: output }],
                      ['item/completed', { item: { id, type: 'commandExecution', command, aggregatedOutput: output } }]
                    ];
                  }));
                }
                let index = 0;
                const start = () => { timer = setInterval(() => {
                  if (stream.destroyed || index >= events.length) { clearInterval(timer); return; }
                  const [method, params] = events[index++]; notify(method, params);
                }, 150); };
                if (prompt.includes('[steer-hold]') || prompt.includes('[choice-crop-hold]')) {
                  heldTurn = { start, finish: () => { clearInterval(timer); notify('turn/completed', { turn: { id: turnId, status: 'completed' } }); } };
                  notify('item/completed', { item: { id: `working-${thread.turns}`, type: 'agentMessage', text: prompt.includes('[choice-crop-hold]') ? cropChoiceReply : '正在編寫，等待補充設計方向。' } });
                } else if (prompt.includes('[cooperate]')) {
                  waitingTool = { id: `relay:${turnId}`, start };
                  const call = { id: waitingTool.id, method: 'item/tool/call', params: { threadId, turnId, callId: `delegate-${turnId}`, tool: 'cozypad_delegate', arguments: { prompt: 'peer-work' } } };
                  send(call); send(call);
                } else if (['[question]', '[question-multiple]', '[question-profession]'].includes(prompt)) {
                  if (prompt === '[question-profession]' && request.params.input && threads.get(threadId).questionsEnabled !== true) { start(); continue; }
                  waitingQuestion = { id: `question:${turnId}`, start };
                  if (prompt === '[question-profession]') notify('item/completed', { item: { id: `question-preview-${thread.turns}`, type: 'agentMessage', text: professionChoiceReply } });
                  send({ id: waitingQuestion.id, method: 'item/tool/requestUserInput', params: { threadId, turnId, itemId: 'question-item', isBlocking: true, autoResolutionMs: 5, questions: [prompt === '[question-profession]' ? professionNativeQuestion : nativeQuestion, ...(prompt === '[question-multiple]' ? [{ id: 'style', header: '語言', question: '要使用哪種語言？', options: [{ label: '繁體中文', description: '保留原文的語言。' }, { label: '英文', description: '改成英文。' }] }] : [])] } });
                } else if ((prompt.includes('[approval]') || prompt.includes('[file-approval]') || (delegated && prompt.includes('[child-approval]'))) && thread.approvalPolicy !== 'never') {
                  const child = delegated && prompt.includes('[child-approval]');
                  const file = prompt.includes('[file-approval]') || child;
                  waitingApproval = { id: `approval:${turnId}`, start };
                  if (child) {
                    notify('item/completed', { item: collab(`spawn-${thread.turns}`, 'spawnAgent', 'completed', 'running') });
                    send({ id: `foreign:${turnId}`, method: 'item/commandExecution/requestApproval', params: { threadId: 'unrelated-thread', turnId: 'foreign-turn', itemId: 'foreign', command: 'must-not-run' } });
                  }
                  if (file) notify('item/started', { ...(child ? { threadId: childId, turnId: 'child-turn' } : {}), item: { id: 'file-approval', type: 'fileChange', changes: [{ path: '/tmp/fixture.txt', diff: '+test change' }] } });
                  send({ id: waitingApproval.id, method: file ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval', params: {
                    threadId: child ? childId : threadId, turnId: child ? 'child-turn' : turnId, itemId: file ? 'file-approval' : 'command-approval', reason: 'Fixture needs approval',
                    ...(file ? { grantRoot: '/tmp' } : { command: 'fixture-command', cwd: '/home/tester', availableDecisions: ['accept', 'decline'] })
                  } });
                } else start();
              } else if (!request.method && request.id === waitingTool?.id) {
                const relay = waitingTool;
                if (!relay.taskId) {
                  const result = JSON.parse(request.result.contentItems[0].text); relay.taskId = result.taskId; relay.id = `status:${turnId}`;
                  send({ id: relay.id, method: 'item/tool/call', params: { threadId, turnId, callId: `status-${turnId}`, tool: 'cozypad_peer_status', arguments: { taskId: result.taskId } } });
                } else { waitingTool = null; relay.start(); }
              } else if (!request.method && request.id === waitingQuestion?.id) {
                const question = waitingQuestion; waitingQuestion = null;
                notify('serverRequest/resolved', { requestId: request.id });
                if (Object.values(request.result?.answers || {}).some(answer => answer.answers?.length === 1)) question.start();
                else { stream.exit(1); stream.end(); }
              } else if (!request.method && request.id === waitingApproval?.id) {
                const pendingApproval = waitingApproval; waitingApproval = null;
                notify('serverRequest/resolved', { requestId: request.id });
                if (['accept', 'decline'].includes(request.result?.decision)) pendingApproval.start();
                else { stream.exit(1); stream.end(); }
              } else if (request.method === 'turn/steer') {
                const text = request.params.input[0].text;
                if (request.params.expectedTurnId !== turnId || request.params.threadId !== threadId) { send({ id: request.id, error: { message: 'Active turn mismatch' } }); continue; }
                if (text.includes('[reject]')) { send({ id: request.id, error: { message: 'fixture steering rejected' } }); continue; }
                if (text.includes('[finish-race]')) { heldTurn?.finish(); continue; }
                send({ id: request.id, result: { turnId } });
                notify('item/completed', { item: { id: `guided-${request.id}`, type: 'agentMessage', text: `已採用引導：${text}` } });
                if (text.includes('[finish]')) heldTurn?.finish();
              } else if (request.method === 'turn/interrupt') {
                clearInterval(timer); waitingApproval = null; waitingQuestion = null; send({ id: request.id, result: {} });
                notify('turn/completed', { turn: { id: turnId, status: 'interrupted' } });
              } else if (request.method === 'model/list') {
                if (!acknowledged || modelError) { send({ id: request.id, error: { message: modelError ? 'fixture catalog unavailable' : 'Not initialized' } }); continue; }
                const first = !request.params.cursor;
                const data = first ? [{ model: 'fixture-codex', displayName: 'Fixture Codex', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }]
                  : [{ model: 'fixture-fast', displayName: 'Fixture Fast', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }, { model: 'fixture-hidden', hidden: true }, { model: 'bad;model' }];
                const response = `${JSON.stringify({ id: request.id, result: { data, nextCursor: first ? 'page-2' : null } })}\n`;
                stream.write(response.slice(0, 23)); stream.write(response.slice(23));
              }
            }
          });
          stream.on('end', () => { clearInterval(timer); stream.exit(0); stream.end(); });
          stream.on('close', () => clearInterval(timer));
          return;
        }
        stream.resume();
        stream.on('end', () => {
          if (info.command === 'fixture-bulk-output') {
            for (let index = 0; index < 160; index++) stream.write('中文輸出 ' + 'x'.repeat(32768));
            stream.write('\n末尾標記\n');
          } else stream.write('=== Host ===\nfixture-linux\n=== Memory ===\n1024 MB\n=== Disk ===\n10 GB\n');
          stream.exit(0); stream.end();
        });
      });
      session.on('sftp', accept => {
        const sftp = accept(), handles = new Map();
        let sequence = 0;
        const handle = value => { const key = String(++sequence); handles.set(key, value); return Buffer.from(key); };
        const attrs = (directory, length = 0) => ({ mode: directory ? 0o40755 : 0o100644, uid: 1000, gid: 1000, size: length, atime: 1720000000, mtime: 1720000000 });
        sftp.on('REALPATH', (id, file) => sftp.name(id, [{ filename: file === '.' ? '/home/tester' : file, longname: file, attrs: attrs(true) }]));
        sftp.on('OPENDIR', (id, directory) => { sftpRequests.push({ method: 'opendir', path: directory }); sftp.handle(id, handle({ directory, offset: 0 })); });
        sftp.on('READDIR', (id, encoded) => {
          const value = handles.get(encoded.toString());
          if (!value) { sftp.status(id, STATUS.EOF); return; }
          sftpRequests.push({ method: 'readdir', path: value.directory });
          const directChild = file => file.startsWith(`${value.directory}/`) && !file.slice(value.directory.length + 1).includes('/');
          const items = [...fileMap.entries()].filter(([file]) => directChild(file)).map(([file, data]) => ({ filename: file.split('/').at(-1), longname: file, attrs: attrs(false, data.length) }));
          for (const [file, mode] of directories) if (directChild(file)) items.push({ filename: file.split('/').at(-1), longname: file, attrs: { ...attrs(true), mode: 0o40000 | mode } });
          const batch = items.slice(value.offset, value.offset + 64); value.offset += batch.length;
          if (batch.length) sftp.name(id, batch); else sftp.status(id, STATUS.EOF);
        });
        const stat = (id, file) => { if (symlinks.has(file)) sftp.attrs(id, { ...attrs(false), mode: 0o120777 }); else if (fileMap.has(file)) sftp.attrs(id, attrs(false, fileMap.get(file).length)); else if (directories.has(file)) sftp.attrs(id, { ...attrs(true), mode: 0o40000 | directories.get(file) }); else sftp.status(id, STATUS.NO_SUCH_FILE); };
        sftp.on('STAT', stat); sftp.on('LSTAT', stat);
        sftp.on('FSTAT', (id, encoded) => stat(id, handles.get(encoded.toString())?.file));
        sftp.on('OPEN', (id, file, flags) => {
          sftpRequests.push({ method: 'open', path: file });
          if (fileMap.has(file) && flags & MODE.EXCL && flags & MODE.CREAT) { sftp.status(id, STATUS.FAILURE); return; }
          if (!fileMap.has(file) && !(flags & MODE.CREAT)) { sftp.status(id, STATUS.NO_SUCH_FILE); return; }
          if (!fileMap.has(file) || flags & MODE.TRUNC) fileMap.set(file, Buffer.alloc(0));
          sftp.handle(id, handle({ file }));
        });
        sftp.on('READ', (id, encoded, offset, length) => {
          const content = fileMap.get(handles.get(encoded.toString())?.file);
          if (!content || offset >= content.length) sftp.status(id, STATUS.EOF); else sftp.data(id, content.subarray(offset, offset + length));
        });
        sftp.on('WRITE', (id, encoded, offset, data) => {
          const file = handles.get(encoded.toString())?.file;
          const original = fileMap.get(file) || Buffer.alloc(0);
          const updated = Buffer.alloc(Math.max(original.length, offset + data.length)); original.copy(updated); data.copy(updated, offset); fileMap.set(file, updated); sftp.status(id, STATUS.OK);
        });
        sftp.on('CLOSE', (id, encoded) => { handles.delete(encoded.toString()); sftp.status(id, STATUS.OK); });
        sftp.on('MKDIR', (id, directory, attributes) => {
          if (directories.has(directory) || fileMap.has(directory)) { sftp.status(id, STATUS.FAILURE); return; }
          const parent = directory.slice(0, directory.lastIndexOf('/'));
          if (!directories.has(parent)) { sftp.status(id, STATUS.NO_SUCH_FILE); return; }
          directories.set(directory, attributes.mode); sftp.status(id, STATUS.OK);
        });
        sftp.on('REMOVE', (id, file) => {
          const removed = fileMap.delete(file) || symlinks.has(file); symlinks.delete(file);
          sftp.status(id, removed ? STATUS.OK : STATUS.NO_SUCH_FILE);
        });
        sftp.on('RMDIR', (id, directory) => {
          if (!directories.has(directory)) { sftp.status(id, STATUS.NO_SUCH_FILE); return; }
          if ([...fileMap.keys(), ...directories.keys()].some(file => file.startsWith(`${directory}/`))) { sftp.status(id, STATUS.FAILURE); return; }
          directories.delete(directory); sftp.status(id, STATUS.OK);
        });
        sftp.on('RENAME', (id, source, target) => {
          if (!directories.has(source)) { sftp.status(id, STATUS.NO_SUCH_FILE); return; }
          if (directories.has(target) || fileMap.has(target) || symlinks.has(target) || !directories.has(target.slice(0, target.lastIndexOf('/')) || '/')) { sftp.status(id, STATUS.FAILURE); return; }
          for (const map of [directories, fileMap]) for (const [file, value] of [...map]) if (file === source || file.startsWith(`${source}/`)) {
            map.delete(file); map.set(`${target}${file.slice(source.length)}`, value);
          }
          for (const file of [...symlinks]) if (file === source || file.startsWith(`${source}/`)) { symlinks.delete(file); symlinks.add(`${target}${file.slice(source.length)}`); }
          sftp.status(id, STATUS.OK);
        });
      });
    }); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { privateKey, fingerprint, port: server.address().port, fileMap, directories, symlinks, commands, modelRequests, chatRequests, cleanupRequests, threads, rollouts, deletion, stats, sftpRequests,
    close: () => new Promise(resolve => { for (const client of clients) client.end(); server.close(resolve); }) };
}
