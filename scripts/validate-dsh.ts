#!/usr/bin/env node
/**
 * Validates DSH v4 session logs against the rules the app enforces when it loads a
 * session. Written after a migrated log was rejected with
 * "format v4 tool/result at seq N requires a first-class message with a string id".
 */
import fs from 'node:fs';
import { decompressFrames } from '../src/zstd.ts';

export interface Problem {
  seq: number | null;
  rule: string;
  detail: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export function validateDshLog(file: string): Problem[] {
  const problems: Problem[] = [];
  let events: Array<Record<string, unknown>>;
  try {
    events = decompressFrames(file, fs.readFileSync(file))
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    return [{ seq: null, rule: 'readable', detail: (error as Error).message }];
  }

  let lastSeq = -1;
  let openTurn: number | null = null;
  let openStep: number | null = null;
  const pending = new Map<string, number>();

  for (const event of events) {
    const seq = typeof event.seq === 'number' ? event.seq : null;
    const type = String(event.type ?? '');
    const data = isObject(event.data) ? event.data : {};

    // Real logs start at 0 and may carry one seq-less header event; after that the
    // sequence must strictly increase.
    if (seq !== null) {
      if (seq <= lastSeq) problems.push({ seq, rule: 'seq', detail: `seq must increase (was ${lastSeq})` });
      lastSeq = seq;
    }

    if (type === 'turn/start') {
      if (openTurn !== null) problems.push({ seq, rule: 'turn', detail: 'turn/start inside an open turn' });
      openTurn = Number(data.turn);
      openStep = null;
      continue;
    }
    if (type === 'step/start') {
      if (openTurn === null) problems.push({ seq, rule: 'turn', detail: 'step/start outside a turn' });
      openStep = Number(data.step);
      continue;
    }
    if (type === 'step/end') {
      openStep = null;
      continue;
    }
    if (type === 'turn/end') {
      if (pending.size > 0) {
        problems.push({
          seq,
          rule: 'tool-lifecycle',
          detail: `turn ends with unresolved tool call(s): ${[...pending.keys()].join(', ')}`,
        });
        pending.clear();
      }
      openTurn = null;
      openStep = null;
      continue;
    }

    if (type === 'tool/call') {
      if (openTurn === null) problems.push({ seq, rule: 'turn', detail: 'tool/call outside a turn' });
      const callId = data.callId;
      if (!nonEmptyString(callId)) problems.push({ seq, rule: 'tool/call', detail: 'callId must be a string' });
      else if (pending.has(callId)) problems.push({ seq, rule: 'tool/call', detail: `duplicate open call ${callId}` });
      else pending.set(callId, seq ?? 0);
      continue;
    }

    if (type === 'tool/result') {
      const message = isObject(data.message) ? data.message : null;
      if (!message) {
        problems.push({ seq, rule: 'tool/result', detail: 'missing message' });
        continue;
      }
      if (!nonEmptyString(message.id)) {
        problems.push({ seq, rule: 'tool/result', detail: 'requires a first-class message with a string id' });
      }
      if (message.role !== 'tool') {
        problems.push({ seq, rule: 'tool/result', detail: `requires a tool-role message (got ${String(message.role)})` });
      }
      const toolCallId = message.toolCallId;
      const source = isObject(message.source) ? message.source : {};
      if (!nonEmptyString(toolCallId) || source.callId !== toolCallId) {
        problems.push({ seq, rule: 'tool/result', detail: 'requires toolCallId matching its tool source' });
      } else if (!pending.has(toolCallId)) {
        problems.push({ seq, rule: 'tool/result', detail: `result for unknown call ${toolCallId}` });
      } else {
        pending.delete(toolCallId);
      }
      continue;
    }

    if (type === 'user/message' || type === 'assistant/message') {
      const message = type === 'assistant/message' && isObject(data.message) ? data.message : data;
      if (!nonEmptyString(message.id)) {
        problems.push({ seq, rule: type, detail: 'requires a first-class message with a string id' });
      }
      if (!Array.isArray(message.content)) {
        problems.push({ seq, rule: type, detail: 'content must be an array' });
      }
    }
  }

  if (pending.size > 0) {
    problems.push({ seq: lastSeq, rule: 'tool-lifecycle', detail: `log ends with unresolved call(s): ${[...pending.keys()].join(', ')}` });
  }

  return problems;
}

if (process.argv[1]?.endsWith('validate-dsh.ts')) {
  const files = process.argv.slice(2);
  let bad = 0;
  for (const file of files) {
    const problems = validateDshLog(file);
    if (problems.length === 0) {
      console.log(`OK   ${file}`);
      continue;
    }
    bad += 1;
    console.log(`FAIL ${file}`);
    for (const problem of problems.slice(0, 6)) console.log(`     seq ${problem.seq} ${problem.rule}: ${problem.detail}`);
  }
  process.exit(bad > 0 ? 1 : 0);
}
