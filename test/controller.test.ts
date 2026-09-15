import { expect, test } from 'vitest';
import { createAssistantMessage, createToolResultMessage, type ToolCallId, type LlmAttemptId } from '@deepseek-ai/dsh-llm';
import { Session, type SessionId } from '@deepseek-ai/dsh-session';
import { TuiController } from '../src/controller.js';

const attemptId = 'attempt-test' as LlmAttemptId;

// Assertions retain their original text/order contract as entries gain semantic styling.
function textView(controller: TuiController) {
  const snapshot = controller.snapshot();
  return { ...snapshot, committed: snapshot.committed.map(entry => entry.text) };
}

test('the footer projects the selected model and effort without inventing a provider default', () => {
  const controller = new TuiController();
  controller.identity('deepseek', 'deepseek-flash', '/workspace/project', 'high');
  expect(controller.snapshot()).toMatchObject({ model: '(deepseek) deepseek-flash', effort: 'high', cwd: '/workspace/project' });
  controller.identity('test', 'flash', '/workspace/project');
  expect(controller.snapshot()).toMatchObject({ model: '(test) flash', effort: 'default' });
});

test('the footer totals only finalized reported usage and a new session starts without invented counts', () => {
  const controller = new TuiController();
  const session = Session.create('session-usage' as SessionId);
  expect(controller.snapshot().stats).toBe('');
  for (let step = 0; step < 2; step++) {
    const usage = { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 500, cacheWriteTokens: 75 };
    controller.stream({ type: 'chunk', attemptId, revision: step + 1, index: step, time: 0, chunk: { type: 'usage', usage } });
    controller.session(session.append('assistant/message', { turn: 0, step, stream: [], usage,
      message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'Done.' }] }),
    }, { surfaceOp: 'append' }));
  }
  expect(controller.snapshot().stats).toBe('↑2k ↓40 R1k W150');
  const fresh = new TuiController(undefined, undefined, undefined, controller.snapshot().committed);
  expect(fresh.snapshot().stats).toBe('');
});

test('two streamed fragments settle as one complete answer and return to ordinary input', () => {
  const controller = new TuiController();
  const session = Session.create('session-test' as SessionId);
  controller.session(session.append('turn/start', { turn: 0 }));
  controller.stream({ type: 'start', attemptId, revision: 1, turn: 0, step: 0 });
  controller.stream({ type: 'chunk', attemptId, revision: 2, index: 0, time: 0,
    chunk: { type: 'text-delta', index: 0, text: 'Hello' } });
  controller.stream({ type: 'chunk', attemptId, revision: 3, index: 1, time: 1,
    chunk: { type: 'text-delta', index: 0, text: ' world' } });
  expect(textView(controller)).toMatchObject({ committed: [], active: 'Hello world', mode: 'running' });
  controller.session(session.append('assistant/message', {
    turn: 0, step: 0, stream: [],
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' },
      content: [{ type: 'text', text: 'Hello world!' }] }),
  }, { surfaceOp: 'append' }));
  controller.session(session.append('turn/end', { turn: 0, reason: { kind: 'completed' } }));
  expect(textView(controller)).toMatchObject({ committed: ['Hello world!'], active: '', mode: 'idle' });
  expect(textView(controller).committed).toEqual(['Hello world!']);
});

test('parallel tools keep call order while their final summaries use tool presentation', () => {
  const controller = new TuiController(name => ({
    presentCall: () => ({ card: 'terminal', title: name === 'first' ? 'npm test' : 'git status' }),
    presentResult: () => ({ card: 'terminal', exitCode: 0 }),
  }));
  const session = Session.create('session-tools' as SessionId);
  controller.session(session.append('turn/start', { turn: 0 }));
  for (const name of ['first', 'second']) controller.session(session.append('tool/call', {
    turn: 0, step: 0, name, callId: name as ToolCallId, arguments: '{}',
  }));
  expect(textView(controller).active).toContain('… $ npm test');
  controller.session(session.append('tool/result', { turn: 0, step: 0,
    message: createToolResultMessage({ callId: 'second' as ToolCallId, content: [], isError: false }),
  }, { surfaceOp: 'append' }));
  expect(textView(controller).committed).toEqual([]);
  controller.session(session.append('tool/result', { turn: 0, step: 0,
    message: createToolResultMessage({ callId: 'first' as ToolCallId, content: [], isError: false }),
  }, { surfaceOp: 'append' }));
  expect(textView(controller).committed).toEqual(['✓ $ npm test · exit 0', '✓ $ git status · exit 0']);
});

test('a failing presenter cannot break a tool failure or inject terminal controls', () => {
  const controller = new TuiController(() => ({
    presentCall() { throw new Error('bad presenter'); },
    presentResult() { throw new Error('bad result presenter'); },
  }));
  const session = Session.create('session-failure' as SessionId);
  controller.session(session.append('tool/call', {
    turn: 0, step: 0, name: 'external_tool', callId: 'bad' as ToolCallId, arguments: '{}',
  }));
  controller.session(session.append('tool/result', { turn: 0, step: 0,
    message: createToolResultMessage({ callId: 'bad' as ToolCallId, isError: true,
      content: [{ type: 'text', text: '\x1b[3JFailed\x07\nsecond line' }] }),
  }, { surfaceOp: 'append' }));
  expect(textView(controller).committed).toEqual(['✗ external_tool · Failed']);
});

test('cancellation preserves a partial reply and settles unfinished tools instead of blocking history', () => {
  const controller = new TuiController();
  const session = Session.create('session-cancel' as SessionId);
  controller.session(session.append('turn/start', { turn: 0 }));
  controller.stream({ type: 'start', attemptId, revision: 1, turn: 0, step: 0 });
  controller.stream({ type: 'chunk', attemptId, revision: 2, index: 0, time: 0,
    chunk: { type: 'text-delta', index: 0, text: 'Partial reply' } });
  controller.session(session.append('tool/call', {
    turn: 0, step: 0, name: 'slow', callId: 'slow' as ToolCallId, arguments: '{}',
  }));
  controller.session(session.append('turn/end', { turn: 0, reason: { kind: 'aborted', reason: { kind: 'user' } } }));
  expect(textView(controller)).toMatchObject({
    mode: 'idle', active: '',
    committed: ['✗ slow · cancelled', 'Partial reply\n[incomplete]', 'Stopped.'],
  });
});

test('an approval replaces ordinary input and empty Enter rejects by default', async () => {
  const controller = new TuiController();
  const decision = controller.approval({ toolName: 'bash', reason: 'outside workspace' });
  const view = textView(controller);
  expect(view.mode).toBe('interaction');
  expect(view.committed.join('\n')).toContain('Allow bash once?');
  controller.answer(view.interaction!.id, '');
  await expect(decision).resolves.toBe('rejected');
  expect(textView(controller)).toMatchObject({ mode: 'idle', interaction: null });
});

test('one question request collects numbered, multi-select, and free-text answers in order', async () => {
  const controller = new TuiController();
  const answer = controller.questions({ questions: [
    { id: 'one', question: 'Choose one', options: [{ label: 'A' }, { label: 'B' }] },
    { id: 'many', question: 'Choose several', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] },
    { id: 'text', question: 'Explain', detail: 'Plan detail' },
    { id: 'skip', question: 'Optional' },
  ] });
  for (const input of ['2', '1,2', 'custom answer', '']) {
    controller.answer(textView(controller).interaction!.id, input);
  }
  await expect(answer).resolves.toEqual({ answers: [
    { id: 'one', selected: ['B'] },
    { id: 'many', selected: ['X', 'Y'] },
    { id: 'text', selected: [], custom: 'custom answer' },
    { id: 'skip', selected: [] },
  ] });
  expect(textView(controller).committed.join('\n')).toContain('Plan detail');
});

test('interleaved text blocks retain block order without showing reasoning or terminal escapes', () => {
  const controller = new TuiController();
  controller.stream({ type: 'start', attemptId, revision: 1, turn: 0, step: 0 });
  for (const [index, chunk] of [
    { type: 'reasoning-delta', index: 0, text: 'SECRET' },
    { type: 'text-delta', index: 1, text: 'Hello' },
    { type: 'text-delta', index: 2, text: 'world' },
    { type: 'text-delta', index: 1, text: '\x1b[3J \x07' },
  ].entries()) controller.stream({ type: 'chunk', attemptId, revision: index + 2, index, time: 0, chunk } as Parameters<TuiController['stream']>[0]);
  expect(textView(controller).active).toBe('Hello world');
});

test('duplicate session events fail instead of replaying transcript entries', () => {
  const controller = new TuiController();
  const session = Session.create('session-order' as SessionId);
  const start = session.append('turn/start', { turn: 0 });
  controller.session(start);
  expect(() => controller.session(start)).toThrow('Expected session event 1, received 0');
});

test('aborted FIFO items cannot send a stale approval to the next question', async () => {
  const controller = new TuiController();
  const abort = new AbortController();
  const approval = controller.approval({ toolName: 'first', signal: abort.signal });
  const oldId = textView(controller).interaction!.id;
  const question = controller.questions({ questions: [{ id: 'q', question: 'Second?' }] });
  abort.abort();
  await expect(approval).resolves.toBe('cancelled');
  const currentId = textView(controller).interaction!.id;
  controller.answer(oldId, 'y');
  expect(textView(controller).interaction!.id).toBe(currentId);
  controller.answer(currentId, 'answer');
  await expect(question).resolves.toEqual({ answers: [{ id: 'q', selected: [], custom: 'answer' }] });
  const pending = controller.approval({ toolName: 'closing' });
  controller.closeInteractions();
  await expect(pending).resolves.toBe('cancelled');
});
