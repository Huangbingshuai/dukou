#!/usr/bin/env python3
"""Repair legacy mirror presentation rows without replacing a live rollout inode.

Defaults to dry-run. Only closed mirror-turn-* ranges are changed. Every line
keeps its original byte length, newline and position so native append handles,
history cursors, images and subsequent messages retain their offsets. Backups
are mandatory. Native Codex re-folding is tested in an isolated CODEX_HOME first.
"""
import argparse
import collections
import json
import os
import pathlib
import re
import sqlite3
import subprocess
import tempfile
import threading
import queue
import datetime

NOISE = re.compile(r'^(?:（执行了 \d+ 个操作|（工具调用：|调用工具：|Script (?:completed|failed)\s+Wall time|Companion Page snapshot part \d+ of \d+:)')


def runtime_context(value):
    value = value.strip()
    return ((value.startswith('# AGENTS.md instructions') and '<environment_context>' in value)
            or value.startswith('<environment_context>'))


def text(item):
    return ''.join(b.get('text', '') for b in item.get('content', []) if isinstance(b, dict))


def transform(data):
    lines = data.splitlines(keepends=True)
    parsed = [json.loads(line) for line in lines]
    closed = {r['payload']['turn_id'] for r in parsed if r.get('type') == 'event_msg'
              and r.get('payload', {}).get('type') == 'task_complete'
              and str(r['payload'].get('turn_id', '')).startswith('mirror-turn-')}
    final_items = {}
    for row in parsed:
        p = row.get('payload', {}); item = p.get('item', {})
        if (row.get('type') == 'event_msg' and p.get('type') == 'item_completed'
                and p.get('turn_id') in closed and item.get('type') == 'AgentMessage'
                and text(item).strip() and not NOISE.match(text(item).strip())):
            final_items[p['turn_id']] = item['id']
    patches, current = [], None
    for i, row in enumerate(parsed):
        p = row.get('payload', {})
        if row.get('type') == 'event_msg' and p.get('type') == 'task_started':
            current = p.get('turn_id')
        if current not in closed:
            continue
        changed = False
        if row.get('type') == 'event_msg' and p.get('type') == 'item_completed':
            item = p.get('item', {})
            if ((item.get('type') == 'AgentMessage' and NOISE.match(text(item).strip()))
                    or (item.get('type') == 'UserMessage' and runtime_context(text(item)))):
                p['item'] = dict(type='Reasoning', id=item['id'], summary_text=[], raw_content=[])
                changed = True
            elif item.get('type') == 'AgentMessage' and item.get('id') == final_items.get(p.get('turn_id')) and item.get('phase') != 'final_answer':
                item['phase'] = 'final_answer'
                # The enclosing timestamp still provides the exact completion
                # time; this redundant field funds a same-length live patch.
                p.pop('completed_at_ms', None)
                changed = True
        elif row.get('type') == 'response_item' and p.get('type') == 'message':
            if ((p.get('role') == 'assistant' and NOISE.match(text(p).strip()))
                    or (p.get('role') == 'user' and runtime_context(text(p)))):
                row['payload'] = dict(type='reasoning', summary=[], content=[])
                changed = True
        elif row.get('type') == 'event_msg' and p.get('type') == 'task_complete':
            if NOISE.match((p.get('last_agent_message') or '').strip()):
                p['last_agent_message'] = None
                changed = True
        if changed:
            encoded = json.dumps(row, ensure_ascii=False, separators=(',', ':')).encode()
            assert len(encoded) < len(lines[i]), 'replacement exceeds fixed byte budget'
            replacement = encoded + b' ' * (len(lines[i]) - len(encoded) - 1) + b'\n'
            patches.append((sum(map(len, lines[:i])), lines[i], replacement))
            lines[i] = replacement
    repaired = b''.join(lines)
    assert len(repaired) == len(data)
    assert repaired.count(b'\n') == data.count(b'\n')
    return repaired, patches, closed


def substantive(data):
    result = collections.Counter()
    for line in data.splitlines():
        r = json.loads(line); p = r.get('payload', {})
        if r.get('type') == 'response_item' and p.get('type') == 'message':
            noise = (p.get('role') == 'assistant' and NOISE.match(text(p).strip())) or (p.get('role') == 'user' and runtime_context(text(p)))
            if not noise:
                result[json.dumps(p, sort_keys=True, ensure_ascii=False)] += 1
    return result


def refold(home, thread_id, binary):
    log = open(home / 'server.log', 'w')
    proc = subprocess.Popen([binary, 'app-server'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=log, text=True, env={**os.environ, 'CODEX_HOME': str(home)})
    replies = queue.Queue()
    def read():
        for line in proc.stdout:
            try: replies.put(json.loads(line))
            except ValueError: pass
    threading.Thread(target=read, daemon=True).start()
    def call(n, method, params):
        proc.stdin.write(json.dumps(dict(id=n, method=method, params=params)) + '\n'); proc.stdin.flush()
        while True:
            r = replies.get(timeout=90)
            if r.get('id') == n:
                if 'error' in r: raise RuntimeError(r['error'])
                return r['result']
    try:
        call(1, 'initialize', dict(clientInfo=dict(name='dukou-repair-validation', version='1.0'), capabilities=dict(experimentalApi=True)))
        call(2, 'thread/resume', dict(threadId=thread_id, skipHistory=True))
        call(3, 'thread/turns/list', dict(threadId=thread_id, limit=1, itemsView='summary'))
    finally:
        proc.terminate(); proc.wait(timeout=15); log.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--thread', action='append', required=True)
    ap.add_argument('--codex', default='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')
    args = ap.parse_args()
    home = pathlib.Path(os.environ.get('CODEX_HOME', pathlib.Path.home() / '.codex'))
    backup = home / 'mirror-backups' / ('history-repair-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(parents=True, mode=0o700)
    state = sqlite3.connect(f'file:{home}/state_5.sqlite?mode=ro', uri=True)
    for tid in args.thread:
        source = state.execute('select rollout_path,originator from threads where id=?', (tid,)).fetchone()
        assert source and source[1] == 'session-mirror', 'not a mirror-created thread'
        path = pathlib.Path(source[0]); before = path.read_bytes()
        after, patches, closed = transform(before)
        assert substantive(before) == substantive(after), 'substantive messages or pictures changed'
        print(tid, 'changed rows:', len(patches), 'preserved bytes:', len(before), flush=True)
        if not patches: continue
        target = backup / tid; target.mkdir()
        (target / path.name).write_bytes(before)
        temp = pathlib.Path(tempfile.mkdtemp(prefix='dukou-history-validation-'))
        db = sqlite3.connect(temp / 'state_5.sqlite'); state.backup(db)
        staged = temp / path.name; staged.write_bytes(after)
        db.execute('update threads set rollout_path=? where id=?', (str(staged), tid)); db.commit(); db.close()
        refold(temp, tid, args.codex)
        candidate = sqlite3.connect(temp / 'thread_history_1.sqlite')
        old = sqlite3.connect(f'file:{home}/thread_history_1.sqlite?mode=ro', uri=True)
        def finals(c):
            return c.execute('select t.turn_id,t.final_agent_item_id,i.item_json from thread_turns t left join thread_items i on t.thread_id=i.thread_id and t.turn_id=i.turn_id and t.final_agent_item_id=i.item_id where t.thread_id=?', (tid,)).fetchall()
        valid = finals(candidate)
        assert valid, 'Codex native projection did not populate'
        assert not any(NOISE.match(json.loads(j).get('text', '').strip()) for t, i, j in valid if t in closed and j), 'native Codex still returns a synthetic final answer'
        assert all(json.loads(j).get('phase') == 'final_answer' for t, i, j in valid if t in closed and j), 'native Codex final phase is missing'
        print('Native Codex re-fold verified;', len(valid), 'turns;', 'preview' if not args.apply else 'applying', flush=True)
        if not args.apply: old.close(); candidate.close(); continue
        # Scoped recoverable backup, not a copy of unrelated private chats.
        dump = {}
        for table in ('thread_items', 'thread_turns', 'thread_history_projection_state'):
            dump[table] = dict(columns=[r[1] for r in old.execute(f'pragma table_info({table})')], rows=old.execute(f'select * from {table} where thread_id=?', (tid,)).fetchall())
        (target / 'projection.json').write_text(json.dumps(dump))
        old.close()
        live = sqlite3.connect(home / 'thread_history_1.sqlite', timeout=30)
        live.execute('begin immediate')
        fd = os.open(path, os.O_RDWR)
        applied = []
        try:
            assert os.fstat(fd).st_ino == path.stat().st_ino
            offset = live.execute('select next_rollout_byte_offset from thread_history_projection_state where thread_id=?', (tid,)).fetchone()
            fully_folded = offset and offset[0] >= max(o + len(a) for o, a, b in patches)
            not_yet_folded = offset and offset[0] <= min(o for o, a, b in patches)
            if not fully_folded and not not_yet_folded:
                # An unopened replica can have an old projection cursor. It is
                # safe to fix its on-disk rows before Codex reads them, but not
                # if another process already holds an active rollout handle.
                holders = subprocess.run(['lsof', '-t', str(path)], capture_output=True, text=True).stdout.split()
                assert not [pid for pid in holders if pid != str(os.getpid())], 'history fold is still reading the repair range'
            for off, original, replacement in patches:
                assert os.pread(fd, len(original), off) == original, 'history changed since snapshot'
            for off, original, replacement in patches:
                assert os.pwrite(fd, replacement, off) == len(replacement)
                applied.append((off, original))
            os.fsync(fd)
            # Replace only closed legacy turns. Current native turns and fold
            # cursor/offset remain untouched; tail appends stay in the same inode.
            for table in ('thread_items', 'thread_turns'):
                columns = [r[1] for r in live.execute(f'pragma table_info({table})')]
                for turn in closed:
                    preserve_images = " and item_type <> 'imageView'" if table == 'thread_items' else ''
                    live.execute(f'delete from {table} where thread_id=? and turn_id=?{preserve_images}', (tid, turn))
                    rows = candidate.execute(f'select {",".join(columns)} from {table} where thread_id=? and turn_id=?', (tid, turn)).fetchall()
                    live.executemany(f'insert into {table} ({",".join(columns)}) values ({",".join("?" for _ in columns)})', rows)
            live.commit()
        except BaseException:
            live.rollback()
            for off, original in reversed(applied): os.pwrite(fd, original, off)
            os.fsync(fd)
            raise
        finally:
            os.close(fd); live.close(); candidate.close()
        assert substantive(path.read_bytes()[:len(before)]) == substantive(before)
        print('APPLIED; backup:', target, flush=True)
    state.close()


if __name__ == '__main__':
    main()
