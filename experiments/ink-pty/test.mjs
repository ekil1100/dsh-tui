import assert from 'node:assert/strict';
import test from 'node:test';
import {startProbe, assertHistory} from './harness.mjs';

test('negative control: an overflowing frame erases real scrollback', async t => {
  const probe = await startProbe(t, {name: 'overflow', cols: 40, rows: 5, layout: 'overflow'});
  await probe.frame({items: ['DONE00'], frame: 1});
  probe.snapshot('overflow');
  assert.ok(probe.modes.eraseScrollback > 0, 'The detector must catch CSI 3 J');
  assert.equal(probe.logicalLines().includes('OLD_00'), false);
});

test('bounded frames preserve history during streaming and static commits', async t => {
  const probe = await startProbe(t, {name: 'bounded', cols: 40, rows: 5});
  const items = ['DONE00', 'DONE01'];
  for (let frame = 1; frame <= 10; frame++) {
    await probe.frame({items: frame >= 5 ? items : items.slice(0, 1), frame});
    probe.snapshot(`frame-${frame}`);
    assertHistory(probe, frame >= 5 ? items : items.slice(0, 1));
  }
  await probe.stop();
  await probe.assertShell();
});

test('bounded frames preserve history after a 24-to-12-row resize with useCursor', async t => {
  const probe = await startProbe(t, {name: 'height-resize'});
  await probe.frame({items: ['DONE00'], frame: 1});
  probe.snapshot('before-resize');
  assertHistory(probe, ['DONE00']);
  for (const height of [12]) {
    await probe.resize(80, height);
    probe.snapshot(`resize-${height}`);
    assertHistory(probe, ['DONE00']);
    await probe.frame({frame: height});
    probe.snapshot(`frame-${height}`);
    assertHistory(probe, ['DONE00']);
  }
  await probe.stop();
  await probe.assertShell();
});

test('bounded frames preserve history when the terminal shrinks below four rows', async t => {
  const probe = await startProbe(t, {name: 'short-resize'});
  await probe.frame({items: ['DONE00'], frame: 1});
  probe.snapshot('before-resize');
  await probe.resize(80, 3);
  await probe.frame({frame: 2});
  probe.snapshot('after-resize');
  assertHistory(probe, ['DONE00']);
});

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`the shell is usable after ${signal}`, async t => {
    const probe = await startProbe(t, {name: signal.toLowerCase()});
    await probe.stop(signal);
    probe.snapshot('after-signal');
    await probe.assertShell(code);
  });
}

for (const [name, key, code] of [['ctrl-c', '\x03', 130], ['ctrl-d', '\x04', 0]]) {
  test(`the shell is usable after keyboard ${name}`, async t => {
    const probe = await startProbe(t, {name});
    await probe.input(key);
    probe.snapshot('after-key');
    await probe.assertShell(code);
  });
}

test('a React render error does not clear terminal history', async t => {
  const probe = await startProbe(t, {name: 'render-error-history'});
  await probe.stop('render-error');
  probe.snapshot('after-error');
  assertHistory(probe);
});

test('the shell is usable after a React render error', async t => {
  const probe = await startProbe(t, {name: 'render-error'});
  await probe.stop('render-error');
  probe.snapshot('after-error');
  await probe.assertShell(1);
});

test('partially edited Unicode input survives asynchronous frames and bracketed paste', async t => {
  const probe = await startProbe(t, {name: 'input'});
  await probe.input('中文😀ab');
  assert.match(probe.screen(), /> 中文😀ab/);
  await probe.input('\x1b[D');
  await probe.frame({items: ['DONE00'], frame: 1});
  probe.snapshot('mid-edit-after-frame');
  assert.match(probe.screen(), /> 中文😀ab/);
  assert.equal(probe.terminal.buffer.normal.cursorX, 9);
  assert.ok(probe.cursorVisible);
  await probe.input('\x1b[200~X\r\nY\x1b[201~');
  probe.snapshot('pasted-without-submit');
  assert.match(probe.screen(), /> 中文😀aX Yb/);
  assert.equal(probe.logicalLines().some(line => line.startsWith('INPUT:')), false);
  await probe.input('\r');
  assert.ok(probe.logicalLines().includes('INPUT:中文😀aX Yb'));
  assertHistory(probe, ['DONE00', 'INPUT:']);
  await probe.stop();
  await probe.assertShell();
});

test('diagnostic comparison: height resize without useCursor', async t => {
  const probe = await startProbe(t, {name: 'height-no-cursor', cursor: false});
  await probe.frame({items: ['DONE00'], frame: 1});
  probe.snapshot('before-resize');
  await probe.resize(80, 12);
  await probe.frame({frame: 2});
  probe.snapshot('after-resize-and-frame');
  assertHistory(probe, ['DONE00']);
  await probe.stop();
  await probe.assertShell();
});

test('bounded frames preserve history when repeatedly narrowing the terminal', async t => {
  const probe = await startProbe(t, {name: 'width-resize'});
  const items = ['DONE00', 'LONG_COMMIT_' + 'abcdefghij'.repeat(16) + '_END'];
  await probe.frame({items, frame: 1});
  assertHistory(probe, ['DONE00', 'LONG_COMMIT_', '_END']);
  for (const [index, width] of [60, 40, 20, 8, 80, 30, 10, 80].entries()) {
    await probe.resize(width, 24);
    probe.snapshot(`resize-${width}`);
    assertHistory(probe, ['DONE00', 'LONG_COMMIT_', '_END']);
    await probe.frame({frame: index + 2});
    probe.snapshot(`frame-${index + 2}`);
    assertHistory(probe, ['DONE00', 'LONG_COMMIT_', '_END']);
  }
  await probe.stop();
  await probe.assertShell();
});
