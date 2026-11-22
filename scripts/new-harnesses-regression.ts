import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { KimiReader } from '../src/adapters/kimi.ts';
import { ZcodeReader } from '../src/adapters/zcode.ts';
import { HARNESSES } from '../src/registry.ts';
import { appendZcode, writeZcode } from '../src/writers/zcode.ts';

let checks = 0;
function check(label: string, ok: boolean): void {
  checks++;
  if (!ok) throw new Error(`FAIL ${label}`);
  console.log(`PASS ${label}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dukou-new-harnesses-'));
const previousKimiHome = process.env.KIMI_CODE_HOME;
const previousZcodeHome = process.env.ZCODE_HOME;
try {
  const kimiHome = path.join(root, 'kimi');
  fs.mkdirSync(path.join(kimiHome, 'server', 'instances'), { recursive: true });
  fs.writeFileSync(path.join(kimiHome, 'server.token'), 'test-token');
  const pageCalls: string[] = [];
  const server = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer test-token') {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/api/v1/meta') {
      res.setHeader('content-type', 'application/json').end(JSON.stringify({ code: 0, data: { server_version: 'test' } }));
      return;
    }
    if (url.pathname === '/api/v1/sessions') {
      pageCalls.push(url.search);
      const data = url.searchParams.has('before_id')
        ? { items: [{ id: 'k2', title: 'Kimi two', workspace_id: 'w', metadata: { cwd: '/tmp/project' }, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', archived: true }], has_more: false }
        : { items: [{ id: 'k1', title: 'Kimi one', workspace_id: 'w', metadata: { cwd: '/tmp/project' }, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', archived: false }], has_more: true };
      res.setHeader('content-type', 'application/json').end(JSON.stringify({ code: 0, data }));
      return;
    }
    if (url.pathname === '/api/v1/sessions/k1/messages') {
      const data = url.searchParams.has('before_id')
        ? { items: [{ id: 'm1', role: 'user', created_at: '2026-01-01T00:00:00Z', content: [{ type: 'text', text: 'question' }, { type: 'image', source: { kind: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] }], has_more: false }
        : { items: [{ id: 'm2', role: 'assistant', created_at: '2026-01-01T00:00:01Z', content: [{ type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'a' } }, { type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'text', text: 'read ok' }] }] }], has_more: true };
      res.setHeader('content-type', 'application/json').end(JSON.stringify({ code: 0, data }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  fs.writeFileSync(path.join(kimiHome, 'server', 'instances', 'test.json'), JSON.stringify({ pid: process.pid, host: '127.0.0.1', port, started_at: new Date().toISOString() }));
  process.env.KIMI_CODE_HOME = kimiHome;
  const kimi = new KimiReader();
  const kimiRows = await kimi.list();
  check('Kimi reader follows every session cursor page', kimiRows.length === 2 && kimiRows[1].archived && pageCalls.length === 2);
  const kimiConversation = await kimi.read('k1');
  check('Kimi reader returns complete paginated text/image/tool history', kimiConversation.messages.length === 2 && kimiConversation.messages[0].role === 'user' && kimiConversation.messages[0].blocks.some((b) => b.type === 'image' && b.data === 'aGVsbG8=') && kimiConversation.messages[1].blocks.some((b) => b.type === 'toolCall') && kimiConversation.messages[1].blocks.some((b) => b.type === 'toolResult' && b.output === 'read ok'));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

  const zhome = path.join(root, 'zcode');
  fs.mkdirSync(path.join(zhome, 'cli', 'db'), { recursive: true });
  process.env.ZCODE_HOME = zhome;
  const db = new DatabaseSync(path.join(zhome, 'cli', 'db', 'db.sqlite'));
  db.exec(`create table session(id text primary key, project_id text, workspace_id text, parent_id text, slug text, directory text, path text, title text, version text, share_url text, summary_additions integer, summary_deletions integer, summary_files integer, summary_diffs text, revert text, permission text, time_created integer, time_updated integer, time_compacting integer, time_archived integer, task_type text, title_source text, title_message_id text, time_title_updated integer, trace_id text, time_deleted integer, last_outcome text);
    create table message(id text primary key, session_id text, time_created integer, time_updated integer, data text, sequence integer);
    create table part(id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text, sequence integer);`);
  db.prepare('insert into session (id,project_id,slug,directory,title,version,time_created,time_updated) values (?,?,?,?,?,?,?,?)').run('z1','p','slug','/tmp/project','Z conversation','0.17.1',100,200);
  db.prepare('insert into message (id,session_id,time_created,time_updated,data,sequence) values (?,?,?,?,?,?)').run('u1','z1',100,100,JSON.stringify({ role: 'user' }),1);
  db.prepare('insert into part (id,message_id,session_id,time_created,time_updated,data,sequence) values (?,?,?,?,?,?,?)').run('p1','u1','z1',100,100,JSON.stringify({ type: 'text', text: 'hello' }),1);
  db.prepare('insert into part (id,message_id,session_id,time_created,time_updated,data,sequence) values (?,?,?,?,?,?,?)').run('p2','u1','z1',101,101,JSON.stringify({ type: 'image', mime: 'image/png', data: 'aGVsbG8=' }),2);
  db.prepare('insert into message (id,session_id,time_created,time_updated,data,sequence) values (?,?,?,?,?,?)').run('a1','z1',200,200,JSON.stringify({ role: 'assistant' }),2);
  db.prepare('insert into part (id,message_id,session_id,time_created,time_updated,data,sequence) values (?,?,?,?,?,?,?)').run('p3','a1','z1',200,200,JSON.stringify({ type: 'tool', callID: 'call-1', tool: 'read', state: { status: 'completed', input: { path: 'a' }, output: 'contents' } }),1);
  db.prepare('insert into part (id,message_id,session_id,time_created,time_updated,data,sequence) values (?,?,?,?,?,?,?)').run('p4','a1','z1',202,202,JSON.stringify({ type: 'text', text: 'done' }),2);
  db.close();
  fs.mkdirSync(path.join(zhome, 'v2'), { recursive: true });
  const taskIndex = new DatabaseSync(path.join(zhome, 'v2', 'tasks-index.sqlite'));
  taskIndex.exec(`create table tasks (workspace_key text not null, workspace_path text not null, task_id text not null, title text not null default '', task_status text, provider text, mode text not null default 'build', created_at integer not null, updated_at integer not null, archived integer not null default 0, deleted integer not null default 0, meta_json text not null default '{}', searchable_text text not null default '', cli_title text, cli_created_at integer, cli_updated_at integer, project_id text, root_path text, primary key(workspace_key, task_id));
    create table projects (project_id text primary key, host_id text, name text, position integer, pinned integer, deleted integer, created_at integer, updated_at integer);
    create table project_roots (project_id text, root_path text, position integer, is_primary integer, primary key(project_id, root_path));
    insert into projects(project_id,host_id,name,position,pinned,deleted,created_at,updated_at) values ('zproj-test','local','project',0,0,0,1,1);
    insert into project_roots(project_id,root_path,position,is_primary) values ('zproj-test','/tmp/project',0,1);`);
  taskIndex.close();
  const zcodeRows = await new ZcodeReader().list();
  const zcodeConversation = await new ZcodeReader().read('z1');
  const zcodeBlocks = zcodeConversation.messages.flatMap((message) => message.blocks);
  check('ZCode reader lists and reads complete SQLite text/image/tool parts', zcodeRows.length === 1 && zcodeConversation.messages.length === 5 && zcodeBlocks.some((b) => b.type === 'image' && b.data === 'aGVsbG8=') && zcodeBlocks.some((b) => b.type === 'toolCall' && b.callId === 'call-1') && zcodeBlocks.some((b) => b.type === 'toolResult' && b.callId === 'call-1') && zcodeConversation.messages.some((m) => m.role === 'tool' && m.blocks[0]?.type === 'toolResult'));
  const outgoing = {
    origin: 'codex' as const, sourceId: 'source', projectName: 'project', cwd: '/tmp/project', title: 'Imported with images',
    createdAt: 1000, updatedAt: 4000, archived: false, path: '/tmp/source',
    messages: [
      { id: 'q1', role: 'user' as const, time: 1000, blocks: [{ type: 'text' as const, text: 'What is in this image?' }, { type: 'image' as const, mime: 'image/png', ref: '', data: 'aGVsbG8=' }] },
      { id: 'a1', role: 'assistant' as const, time: 2000, blocks: [{ type: 'toolCall' as const, callId: 'call-1', name: 'read', input: '{"path":"a"}' }, { type: 'toolResult' as const, callId: 'call-1', output: 'read ok', images: [{ type: 'image' as const, mime: 'image/png', ref: '', data: 'aGVsbG8=' }] }, { type: 'text' as const, text: 'The answer is complete.' }] },
    ],
  };
  const written = writeZcode(outgoing, { home: zhome, backupDir: path.join(root, 'backups') });
  const roundTrip = await new ZcodeReader().read(written.sessionId);
  const ordered = roundTrip.messages.map((message) => {
    const block = message.blocks[0];
    return `${message.role}:${block?.type === 'text' ? block.text : block?.type === 'image' ? `${block.mime}:${block.data}` : block?.type === 'toolCall' ? `call:${block.callId}` : block?.type === 'toolResult' ? `result:${block.callId}:${block.output}:${block.images?.[0]?.data ?? ''}` : ''}`;
  });
  check('ZCode writer round-trips the full ordered text/tool/image history', ordered.join('|') === 'user:What is in this image?|user:image/png:aGVsbG8=|assistant:call:call-1|tool:result:call-1:read ok:aGVsbG8=|assistant:The answer is complete.');
  const artifactDir = path.join(zhome, 'cli', 'artifacts', written.sessionId);
  const artifacts = fs.readdirSync(artifactDir).filter((name) => name.includes('tool-result-'));
  check('ZCode writer stores image data URLs in its native artifact directory', artifacts.length === 2 && artifacts.every((name) => fs.readFileSync(path.join(artifactDir, name), 'utf8') === 'data:image/png;base64,aGVsbG8='));
  const indexDb = new DatabaseSync(path.join(zhome, 'v2', 'tasks-index.sqlite'), { readOnly: true });
  const task = indexDb.prepare('select title, provider, searchable_text, project_id, root_path from tasks where task_id = ?').get(written.sessionId) as { title: string; provider: string; searchable_text: string; project_id: string; root_path: string } | undefined;
  indexDb.close();
  check('ZCode desktop task index exposes the imported session in its workspace', task?.title === outgoing.title && task.provider === 'glm' && task.searchable_text.includes('What is in this image?') && task.project_id === 'zproj-test' && task.root_path === '/tmp/project');
  const nativeRows = new DatabaseSync(path.join(zhome, 'cli', 'db', 'db.sqlite'), { readOnly: true });
  const nativeTool = nativeRows.prepare("select json_extract(m.data, '$.providerID') provider_id, json_extract(p.data, '$.state.output') output, json_extract(p.data, '$.state.title') title, json_array_length(json_extract(p.data, '$.state.attachments')) attachments from part p join message m on m.id=p.message_id where p.session_id=? and json_extract(p.data, '$.type')='tool' limit 1").get(written.sessionId) as { provider_id: string; output: string; title: string; attachments: number } | undefined;
  nativeRows.close();
  check('ZCode writes native message metadata and string tool output with image attachments', nativeTool?.provider_id === 'glm' && nativeTool.output === 'read ok' && nativeTool.title === 'read' && nativeTool.attachments === 1);
  const delta = { ...outgoing, messages: [{ id: 'a2', role: 'assistant' as const, time: 5000, blocks: [{ type: 'text' as const, text: 'One more ordered reply.' }] }], updatedAt: 5000 };
  const appended = appendZcode(delta, written.sessionId, { home: zhome, backupDir: path.join(root, 'backups') });
  const afterAppend = await new ZcodeReader().read(written.sessionId);
  check('ZCode writer appends new messages after the complete original history', appended.rows === 1 && afterAppend.messages.at(-1)?.blocks[0]?.type === 'text' && afterAppend.messages.at(-1)?.blocks[0]?.text === 'One more ordered reply.');
  const badHome = path.join(root, 'bad-zcode');
  fs.mkdirSync(path.join(badHome, 'cli', 'db'), { recursive: true });
  process.env.ZCODE_HOME = badHome;
  const badDb = new DatabaseSync(path.join(badHome, 'cli', 'db', 'db.sqlite'));
  badDb.exec('create table session(id text primary key)');
  badDb.close();
  let refused = false;
  try { await new ZcodeReader().list(); } catch (error) { refused = String(error).includes('Unsupported ZCode database schema'); }
  check('ZCode reader refuses unknown schema instead of guessing', refused);
  check('registry enables the verified ZCode writer and keeps Kimi read-only without an official import API', HARNESSES.some((h) => h.id === 'kimi' && !h.canWrite) && HARNESSES.some((h) => h.id === 'zcode' && h.canWrite));
  console.log(`${checks} new-harness checks passed`);
} finally {
  if (previousKimiHome === undefined) delete process.env.KIMI_CODE_HOME;
  else process.env.KIMI_CODE_HOME = previousKimiHome;
  if (previousZcodeHome === undefined) delete process.env.ZCODE_HOME;
  else process.env.ZCODE_HOME = previousZcodeHome;
  fs.rmSync(root, { recursive: true, force: true });
}
