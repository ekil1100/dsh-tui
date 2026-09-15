import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startProbe, assertHistory} from '../ink-pty/harness.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const start = (t, options) => startProbe(t, {
  ...options,
  command: [path.join(directory, 'target/debug/eye-declare-pty-probe')],
  artifactDirectory: path.join(directory, 'artifacts'),
  fixtureEnv: {RUST_BACKTRACE: '0'},
});

test('bounded frames preserve history after a 24-to-12-row resize with a hardware cursor', async t => {
  const probe = await start(t, {name: 'height-resize'});
  await probe.frame({items: ['DONE00'], frame: 1});
  probe.snapshot('before-resize');
  assertHistory(probe, ['DONE00']);
  assert.ok(probe.cursorVisible);
  await probe.resize(80, 12);
  probe.snapshot('after-resize');
  assertHistory(probe, ['DONE00']);
  await probe.frame({frame: 12});
  probe.snapshot('after-frame');
  assertHistory(probe, ['DONE00']);
  await probe.stop();
  await probe.assertShell();
});

test('streaming updates and multiple commits remain bounded and unique', async t => {
  const probe = await start(t, {name: 'streaming', cols: 40, rows: 5});
  for (let frame = 1; frame <= 10; frame++) {
    const items = frame < 5 ? ['DONE00'] : ['DONE00', 'DONE01'];
    await probe.frame({frame, items});
    probe.snapshot(`frame-${frame}`);
    assertHistory(probe, items);
    assert.equal(probe.logicalLines().filter(line => line.startsWith('LIVE')).length, 3);
  }
  await probe.stop();
  await probe.assertShell();
});

test('grapheme deletion produces the correct submitted text', async t => {
  const probe = await start(t, {name: 'graphemes'});
  await probe.input('👩‍💻e\u0301Z');
  await probe.input('\x1b[D');
  await probe.input('\x7f');
  await probe.input('\x7f');
  await probe.input('\r');
  probe.snapshot('submitted-after-grapheme-deletion');
  // Unicode 11 does not shape ZWJ emoji; assert the ASCII result, not its transient glyph layout.
  assertHistory(probe, ['INPUT:Z']);
  await probe.stop();
  await probe.assertShell();
});

for (const [name, key, code] of [['ctrl-c', '\x03', 130], ['ctrl-d', '\x04', 0]]) {
  test(`keyboard ${name} restores the shell`, async t => {
    const probe = await start(t, {name});
    await probe.input(key);
    probe.snapshot('after-key');
    await probe.assertShell(code);
  });
}

test('resize remains clean when cursor position reports are unavailable', async t => {
  const probe = await start(t, {name: 'no-cursor-report'});
  await probe.frame({items: ['DONE00'], frame: 1});
  await probe.input('abcdefghijklmnopqrstuvwxyz123456');
  probe.cursorReports(false);
  await probe.resize(20, 24);
  await probe.frame({frame: 2});
  probe.snapshot('after-resize-without-report');
  assertHistory(probe, ['DONE00']);
  assert.equal(probe.logicalLines().filter(line => line.startsWith('LIVE')).length, 3);
  probe.cursorReports(true);
  await probe.stop();
  await probe.assertShell();
});

test('a one-row editor keeps the end of long input and the caret visible', async t => {
  const probe = await start(t, {name: 'long-input', cols: 12, rows: 8});
  await probe.input('0123456789abcdef');
  probe.snapshot('at-end');
  assert.match(probe.screen(), /abcdef$/m);
  assert.ok(probe.cursorVisible);
  assert.equal(probe.screen().split('\n').filter(line => line.startsWith('>')).length, 1);
  for (let i = 0; i < 8; i++) await probe.input('\x1b[D');
  probe.snapshot('moved-left');
  assert.match(probe.screen(), /> 012345678/);
  await probe.input('\r');
  assert.ok(probe.logicalLines().join('').includes('INPUT:0123456789abcdef'));
  assertHistory(probe, ['INPUT:']);
  await probe.stop();
  await probe.assertShell();
});

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`the host can shut down cleanly after ${signal}`, async t => {
    const probe = await start(t, {name: signal.toLowerCase()});
    await probe.frame({items: ['DONE00'], frame: 1});
    await probe.stop(signal);
    probe.snapshot('after-signal');
    assertHistory(probe, ['DONE00']);
    await probe.assertShell(code);
  });
}

test('a render panic preserves history and restores the same shell', async t => {
  const probe = await start(t, {name: 'render-panic'});
  await probe.frame({items: ['DONE00'], frame: 1});
  await probe.stop('render-error');
  probe.snapshot('after-panic');
  assertHistory(probe, ['DONE00']);
  await probe.assertShell(101);
});

test('Unicode input and its cursor survive asynchronous output and safe paste', async t => {
  const probe = await start(t, {name: 'input'});
  await probe.input('中文😀ab');
  assert.match(probe.screen(), /> 中文😀ab/);
  await probe.input('\x1b[D');
  await probe.frame({items: ['DONE00'], frame: 1});
  probe.snapshot('mid-edit');
  assert.match(probe.screen(), /> 中文😀ab/);
  assert.equal(probe.terminal.buffer.normal.cursorX, 9);
  assert.ok(probe.cursorVisible);
  await probe.input('\x1b[200~X\r\nY\x1b[201~');
  probe.snapshot('paste-without-submit');
  assert.match(probe.screen(), /> 中文😀aX Yb/);
  assert.equal(probe.logicalLines().some(line => line.startsWith('INPUT:')), false);
  await probe.input('\r');
  probe.snapshot('submitted');
  assert.ok(probe.logicalLines().includes('INPUT:中文😀aX Yb'));
  assertHistory(probe, ['DONE00', 'INPUT:']);
  await probe.stop();
  await probe.assertShell();
});

test('repeated height shrinking does not accumulate stale live rows in history', async t => {
  const probe = await start(t, {name: 'height-residue'});
  await probe.frame({items: ['DONE00'], frame: 1});
  for (let index = 0; index < 3; index++) {
    await probe.resize(80, 3);
    await probe.frame({frame: index * 2 + 2});
    await probe.resize(80, 24);
    await probe.frame({frame: index * 2 + 3});
    probe.snapshot(`cycle-${index + 1}`);
    assertHistory(probe, ['DONE00']);
  }
  assert.equal(probe.logicalLines().filter(line => line.startsWith('LIVE')).length, 3,
    'Only the three current live rows may remain');
});

test('bounded frames preserve history across repeated width changes', async t => {
  const probe = await start(t, {name: 'width-resize'});
  await probe.frame({items: ['DONE00', 'LONG_COMMIT_' + 'abcdefghij'.repeat(16) + '_END'], frame: 1});
  for (const [index, width] of [60, 40, 20, 8, 80, 30, 10, 80].entries()) {
    await probe.resize(width, 24);
    await probe.frame({frame: index + 2});
    probe.snapshot(`width-${width}`);
    assertHistory(probe, ['DONE00', 'LONG_COMMIT_', '_END']);
    assert.equal(probe.logicalLines().filter(line => line.startsWith('LIVE')).length, 3);
  }
  await probe.stop();
  await probe.assertShell();
});

test('bounded frames preserve history when the terminal shrinks below four rows', async t => {
  const probe = await start(t, {name: 'short-resize'});
  await probe.frame({items: ['DONE00'], frame: 1});
  probe.snapshot('before-resize');
  await probe.resize(80, 3);
  await probe.frame({frame: 2});
  probe.snapshot('after-resize');
  assertHistory(probe, ['DONE00']);
  await probe.resize(80, 24);
  await probe.stop();
  await probe.assertShell();
});
