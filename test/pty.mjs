import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import stripAnsi from 'strip-ansi';
import { startApp, startDsh } from './support/pty.mjs';

test('the built native addon loads in a fresh Node process', () => {
  const result = spawnSync(process.execPath, ['-e', 'console.log(typeof require("./native/terminal.node").NativeTerminal)'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, `Native load failed: ${result.signal ?? result.error ?? result.stderr}`);
  assert.equal(result.stdout.trim(), 'function');
});

test('bun dev builds and starts the TUI, accepts a turn, and restores the shell', async t => {
  const app = await startDsh(t, 'bun-dev', { command: 'bun dev' });
  await app.waitFor(text => text.includes('dsh · test') || text.includes('APP_EXIT='), 30000);
  assert.match(app.all(), /dsh · test/);
  await app.input('from-bun-dev\r');
  await app.waitFor('Reply: from-bun-dev');
  await app.input('\x04');
  await app.shellCheck();
  assert.equal(app.all().split('Reply: from-bun-dev').length - 1, 1);
});

test('input starts at column zero without a prompt prefix and keeps a typed greater-than sign', async t => {
  const app = await startDsh(t, 'input-no-prefix');
  await app.waitFor(() => app.status().startsWith('─ Idle '), 15000);
  assert.equal(app.editor(), '');
  assert.equal(app.terminal.buffer.normal.cursorX, 0);
  await app.input('中文😀ab\x1b[D');
  assert.equal(app.editor(), '中文😀ab');
  assert.equal(app.terminal.buffer.normal.cursorX, 7);
  await app.input('\x01> ');
  assert.equal(app.editor(), '> 中文😀ab');
  assert.equal(app.terminal.buffer.normal.cursorX, 2);
  await app.input('\r');
  await app.waitFor('Reply: > 中文😀ab');
  await app.input('\x04');
  await app.shellCheck();
  assert.equal(app.all().split('> > 中文😀ab').length - 1, 1);
});

test('the footer resolves adapter defaults at startup and after model changes without saving them', async t => {
  const app = await startDsh(t, 'effort-default', { model: 'reasoner', env: { NO_COLOR: '' } });
  await app.waitFor(() => app.status().startsWith('─ Idle '), 15000);
  assert.match(app.footer(), /\(test\) reasoner · high$/);
  const buffer = app.terminal.buffer.normal;
  assert.equal(buffer.getLine(buffer.baseY + buffer.cursorY - 1).getCell(0).getFgColor(), 0xb294bb);
  await app.input('/model test/flash\r');
  await app.waitFor('Model: test/flash (session only)');
  assert.match(app.footer(), /\(test\) flash · default$/);
  await app.input('\x1b[Z');
  await app.waitFor('No reasoning effort choices are available for test/flash.');
  assert.match(app.footer(), /\(test\) flash · default$/);
  await app.input('/model test/reasoner\r');
  await app.waitFor('Model: test/reasoner (session only)');
  assert.match(app.footer(), /\(test\) reasoner · high$/);
  await app.input('\x1b[Z');
  await app.waitFor(() => app.footer().endsWith('(test) reasoner · max'));
  assert.equal(existsSync(path.join(app.home, 'settings.yaml')), false);
  await app.input('\x04');
  await app.shellCheck();
});

test('Shift+Tab cycles supported efforts, updates requests and borders, and preserves the draft', async t => {
  const app = await startDsh(t, 'effort-cycle', { model: 'reasoner', env: { NO_COLOR: '' } });
  await app.waitFor(() => app.footer().endsWith('(test) reasoner · high'), 15000);
  await app.input('中文😀ab\x1b[D');
  for (const [effort, color] of [
    ['max', 0xff5fff], ['off', 0x505050], ['low', 0x5f87af], ['high', 0xb294bb], ['max', 0xff5fff],
  ]) {
    await app.input('\x1b[Z');
    await app.waitFor(() => app.footer().endsWith(`(test) reasoner · ${effort}`), 2000);
    assert.equal(app.editor(), '中文😀ab');
    const buffer = app.terminal.buffer.normal;
    assert.equal(buffer.cursorX, 7);
    assert.equal(buffer.getLine(buffer.baseY + buffer.cursorY - 1).getCell(0).getFgColor(), color);
    assert.equal(buffer.getLine(buffer.baseY + buffer.cursorY + 1).getCell(0).getFgColor(), color);
  }
  await app.input('\x03which-effort\r');
  await app.waitFor('Effort used: max');
  assert.equal(existsSync(path.join(app.home, 'settings.yaml')), false);
  assert.doesNotMatch(app.all(), /> \/effort/);
  await app.input('/new\r');
  await app.waitFor('New session:');
  assert.match(app.footer(), /\(test\) reasoner · high$/);
  await app.input('which-effort\r');
  await app.waitFor('Effort used: high');
  await app.input('\x04');
  await app.shellCheck();
});

test('effort switches update in place without a command-state flash or appended notices', async t => {
  const app = await startDsh(t, 'effort-in-place', {
    model: 'reasoner', env: { DSH_TEST_MODEL_INFO_DELAY: '150' },
  });
  await app.waitFor(() => app.footer().endsWith('(test) reasoner · high'), 15000);
  await app.input('draft中😀\x1b[D');
  const rawStart = app.raw.length;
  const buffer = app.terminal.buffer.normal;
  const cursor = buffer.baseY + buffer.cursorY;
  await app.input('\x1b[Z');
  await app.waitFor(() => app.footer().endsWith('(test) reasoner · max'));
  assert.deepEqual({
    flashedCancel: /Esc\s+to\s+cancel/.test(stripAnsi(app.raw.slice(rawStart))),
    appendedNotice: app.all().includes('Effort: max (session only; next request)'),
  }, { flashedCancel: false, appendedNotice: false });
  assert.equal(buffer.baseY + buffer.cursorY, cursor);
  assert.equal(app.editor(), 'draft中😀');
  assert.equal(buffer.cursorX, 7);
  await app.input(`\x03which-effort${'\x1b[Z'.repeat(6)}\r`);
  await app.waitFor('Effort used: low');
  assert.match(app.footer(), /\(test\) reasoner · low$/);
  assert.doesNotMatch(stripAnsi(app.raw.slice(rawStart)), /Esc\s+to\s+cancel|Effort:|Command\s+completed/);
  await app.input('/effort\r');
  await app.waitFor(() => app.status().startsWith('─ Idle ') && app.footer().endsWith('(test) reasoner · high'));
  assert.doesNotMatch(app.all(), /Effort:|Command completed/);
  await app.input('\x04');
  await app.shellCheck();
});

test('Shift+Tab during a response affects the next request without overwriting the saved effort', async t => {
  const app = await startDsh(t, 'effort-running', { model: 'reasoner', reasoningEffort: 'low' });
  await app.waitFor(() => app.footer().endsWith('(test) reasoner · low'), 15000);
  const settings = readFileSync(path.join(app.home, 'settings.yaml'), 'utf8');
  await app.input('slow-effort\r');
  await app.waitFor(() => app.status().startsWith('─ Responding '));
  const rawStart = app.raw.length;
  await app.input('\x1b[Z');
  await app.waitFor(() => app.footer().endsWith('(test) reasoner · high'));
  assert.match(app.footer(), /^Esc to stop/);
  assert.doesNotMatch(stripAnsi(app.raw.slice(rawStart)), /Esc\s+to\s+cancel|Effort:/);
  await app.waitFor('Effort used: low');
  await app.waitFor(() => app.status().startsWith('─ Idle '));
  await app.input('which-effort\r');
  await app.waitFor('Effort used: high');
  assert.equal(readFileSync(path.join(app.home, 'settings.yaml'), 'utf8'), settings);
  await app.input('/new\r');
  await app.waitFor('New session:');
  assert.match(app.footer(), /\(test\) reasoner · low$/);
  await app.input('\x04');
  await app.shellCheck();
});

test('Shift+Tab keeps command completion separate and never changes effort inside modal input', async t => {
  const app = await startDsh(t, 'effort-input-modes', { model: 'reasoner' });
  await app.waitFor(() => app.footer().endsWith('(test) reasoner · high'), 15000);
  await app.input('/fi\x1b[Z');
  await app.waitFor(() => app.footer().endsWith('(test) reasoner · max'));
  assert.equal(app.editor(), '/fi');
  assert.match(app.status(), /^─ Commands /);
  await app.input('\t');
  assert.equal(app.editor().trimEnd(), '/fixture');
  assert.doesNotMatch(app.all(), /Command ready/);
  await app.input('\x03/model\r');
  await app.waitFor(() => app.status().startsWith('─ Select model '));
  await app.input('test\x1b[Z');
  assert.equal(app.editor(), 'test');
  assert.match(app.status(), /^─ Select model /);
  assert.match(app.footer(), /\(test\) reasoner · max$/);
  await app.input('\x1b');
  await app.waitFor('Model selection cancelled.');
  await app.input('/fixture wait\r');
  await app.waitFor(() => app.status().startsWith('─ Command '));
  await app.input('draft\x1b[Z');
  assert.equal(app.editor(), 'draft');
  assert.match(app.status(), /^─ Command /);
  assert.match(app.footer(), /\(test\) reasoner · max$/);
  await app.input('\x1b');
  await app.waitFor('Command cancelled.');
  await app.input('\x03approve\r');
  await app.waitFor('Allow fixture_tool once?');
  await app.input('n\x1b[Z');
  assert.equal(app.editor(), 'n');
  assert.match(app.status(), /^─ Input /);
  assert.match(app.footer(), /\(test\) reasoner · max$/);
  await app.input('\r');
  await app.waitFor('Decision: rejected');
  await app.input('/help\r');
  await app.waitFor('Shift+Tab: cycle reasoning effort');
  await app.input('\x04');
  await app.shellCheck();
});

test('Shift+Tab reports models without effort choices without changing the draft or request', async t => {
  const app = await startDsh(t, 'effort-unavailable');
  await app.waitFor(() => app.status().startsWith('─ Idle '), 15000);
  await app.input('draft\x1b[Z');
  await app.waitFor('No reasoning effort choices are available for test/test.');
  assert.equal(app.editor(), 'draft');
  assert.match(app.footer(), /\(test\) test · default$/);
  await app.input('\x03which-effort\r');
  await app.waitFor('Effort used: default');
  await app.input('\x04');
  await app.shellCheck();
});

test('pi-style effort borders enclose the editor above the path and right-aligned model', async t => {
  const app = await startDsh(t, 'footer', { reasoningEffort: 'high', env: { NO_COLOR: '' } });
  await app.waitFor('dsh · test', 15000);
  await app.input('中文😀ab\x1b[D');
  const buffer = app.terminal.buffer.normal;
  const cursor = buffer.baseY + buffer.cursorY;
  assert.match(buffer.getLine(cursor - 1).translateToString(true), /^─ Idle .*─$/);
  assert.equal(buffer.getLine(cursor + 1).translateToString(true), '─'.repeat(80));
  assert.match(buffer.getLine(cursor + 2).translateToString(true), /workspace\/dsh-tui/);
  assert.match(buffer.getLine(cursor + 3).translateToString(true), /\(test\) test · high$/);
  assert.equal(buffer.getLine(cursor + 3).translateToString(true).length, 80);
  assert.equal(buffer.getLine(cursor - 1).getCell(0).getFgColor(), 0xb294bb);
  assert.equal(buffer.getLine(cursor + 1).getCell(0).getFgColor(), 0xb294bb);
  assert.equal(app.editor(), '中文😀ab');
  assert.equal(buffer.getLine(cursor).getCell(0).isFgDefault(), true);
  assert.equal(buffer.cursorX, 7);
  await app.input('\x03\x04');
  await app.shellCheck();
});

test('the workspace line shows the home-relative Unicode path and Git branch across model changes', async t => {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'dsh-tui-workspace-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, '工作😀');
  mkdirSync(cwd);
  assert.equal(spawnSync('git', ['init', '--initial-branch=style-test', cwd]).status, 0);
  const app = await startDsh(t, 'workspace', { cwd, env: { HOME: home } });
  await app.waitFor('dsh · test', 15000);
  const directory = () => {
    const buffer = app.terminal.buffer.normal;
    return buffer.getLine(buffer.baseY + buffer.cursorY + 2).translateToString(true);
  };
  assert.match(directory(), /^~\/工作😀 \(style-test\) +extensions 0 · preset standard$/);
  await app.input('/model test/flash\r');
  await app.waitFor('Model: test/flash (session only)');
  assert.match(directory(), /^~\/工作😀 \(style-test\) +extensions 0 · preset standard$/);
  await app.input('\x04');
  await app.shellCheck();
});

test('narrow footers retain the effort and Unicode draft cursor rather than clipping the model suffix', async t => {
  const app = await startDsh(t, 'footer-narrow', { reasoningEffort: 'max', env: { NO_COLOR: '' } });
  await app.waitFor(() => app.footer().endsWith('(test) test · max'), 15000);
  await app.input('中😀x');
  for (const [cols, expected] of [[12, '… test · max'], [8, '…t · max'], [80, '(test) test · max']]) {
    await app.resize(cols, 12);
    assert.ok(app.footer().endsWith(expected), app.footer());
    assert.equal(app.editor(), '中😀x');
    assert.equal(app.terminal.buffer.normal.cursorX, 5);
    const buffer = app.terminal.buffer.normal;
    assert.equal(buffer.getLine(buffer.baseY + buffer.cursorY + 1).getCell(0).getFgColor(), 0xff5fff);
  }
  await app.input('\x03\x04');
  await app.shellCheck();
});

test('reported token totals occupy the left footer and reset with /new', async t => {
  const app = await startDsh(t, 'footer-usage');
  await app.waitFor('dsh · test', 15000);
  assert.doesNotMatch(app.footer(), /↑|↓|\$|\/help/);
  await app.input('usage\r');
  await app.waitFor('Reply: usage');
  await app.waitFor(() => app.status().startsWith('─ Idle '));
  assert.match(app.footer(), /^↑1k ↓42 R2k +\(test\) test · default$/);
  await app.input('usage\r');
  await app.waitFor(() => app.footer().startsWith('↑2k ↓84 R4k '));
  await app.input('/new\r');
  await app.waitFor('New session:');
  assert.doesNotMatch(app.footer(), /↑|↓|\$/);
  await app.input('\x04');
  await app.shellCheck();
});

test('each pi effort has its own border color and model switches clear stale effort', async t => {
  // Expected RGB values come from pi's built-in dark theme, not the renderer.
  for (const [effort, color] of [
    ['off', 0x505050], ['minimal', 0x6e6e6e], ['low', 0x5f87af], ['medium', 0x81a2be],
    ['high', 0xb294bb], ['xhigh', 0xd183e8], ['max', 0xff5fff],
  ]) await t.test(effort, async t => {
    const app = await startDsh(t, `effort-${effort}`, { reasoningEffort: effort, env: { NO_COLOR: '' } });
    await app.waitFor(() => app.footer().endsWith(`(test) test · ${effort}`), 15000);
    const borderColor = () => {
      const buffer = app.terminal.buffer.normal;
      return buffer.getLine(buffer.baseY + buffer.cursorY - 1).getCell(0).getFgColor();
    };
    assert.equal(borderColor(), color);
    await app.input('/model test/flash\r');
    await app.waitFor(() => app.footer().endsWith('(test) flash · default'));
    assert.equal(borderColor(), 0x8ba4e8);
    await app.input('/fi');
    const buffer = app.terminal.buffer.normal;
    const candidate = buffer.getLine(buffer.baseY + buffer.cursorY + 2);
    assert.match(candidate.translateToString(true), /^> \/fixture/);
    assert.equal(candidate.getCell(0).getFgColor(), 0x8ba4e8);
    await app.input('\x03\x04');
    await app.shellCheck();
  });
});

test('native inline conversation streams, commits once, and restores the same shell', async t => {
  const app = await startApp(t);
  await app.waitFor('dsh · test');
  await app.input('hello\r');
  await app.waitFor('Hello');
  await app.waitFor('Hello world!');
  assert.equal(app.all().split('Hello world!').length - 1, 1);
  await app.input('\x04');
  await app.shellCheck();
});

test('the real dsh bundle creates one session and accepts consecutive turns', async t => {
  const app = await startDsh(t);
  await app.waitFor('dsh · test', 15000);
  await app.input('first\r');
  await app.waitFor('Reply: first');
  await app.input('second\r');
  await app.waitFor('Reply: second');
  await app.waitFor(() => app.editor() === '');
  await app.input('\x04');
  await app.shellCheck();
  assert.equal(app.all().split('Reply: first').length - 1, 1);
  assert.equal(app.all().split('Reply: second').length - 1, 1);
});

test('real tool execution shows progress and one presented completion', async t => {
  const app = await startDsh(t, 'tools');
  await app.waitFor('dsh · test', 15000);
  await app.input('tools\r');
  await app.waitFor('… Read fixture');
  await app.waitFor('✓ Read fixture');
  await app.waitFor('Reply: tools');
  await app.input('\x04');
  await app.shellCheck();
  assert.equal(app.all().split('✓ Read fixture').length - 1, 1);
});

test('Escape cancels a running model and the same session accepts another prompt', async t => {
  const app = await startDsh(t, 'cancel');
  await app.waitFor('dsh · test', 15000);
  await app.input('slow\r');
  await app.waitFor('Reply:');
  await app.input('\x1b');
  await app.waitFor('Stopped.');
  await app.input('recovered\r');
  await app.waitFor('Reply: recovered');
  await app.input('\x04');
  await app.shellCheck();
});

test('Ctrl+C cancels work, clears an idle draft, then exits with 130', async t => {
  const app = await startDsh(t, 'ctrl-c');
  await app.waitFor('dsh · test', 15000);
  await app.input('slow\r');
  await app.waitFor('Reply:');
  await app.input('\x03');
  await app.waitFor('Stopped.');
  await app.input('draft');
  await app.input('\x03');
  await app.waitFor(() => app.editor() === '');
  await app.input('\x03');
  await app.shellCheck(130);
});

test('/new resets model context without deleting or replaying terminal history', async t => {
  const app = await startDsh(t, 'new-session');
  await app.waitFor('dsh · test', 15000);
  await app.input('old-context\r');
  await app.waitFor('Reply: old-context');
  await app.input('/model test/flash\r');
  await app.waitFor('Model: test/flash (session only)');
  await app.input('/new\r');
  await app.waitFor('New session:');
  assert.match(app.footer(), /\(test\) test · default$/);
  assert.match(app.status(), /^─ Idle /);
  await app.input('history-count\r');
  await app.waitFor('User messages: 1');
  await app.input('/help\r');
  await app.waitFor('/new — Start a new session');
  await app.input('fresh\r');
  await app.waitFor('Reply: fresh');
  for (const text of ['> old-context', 'Reply: old-context', 'Reply: fresh']) assert.equal(app.all().split(text).length - 1, 1);
  await app.input('\x04');
  await app.shellCheck();
});

test('thinking and response phases keep reasoning out of the preview and committed history', async t => {
  const app = await startDsh(t, 'reasoning');
  await app.waitFor('dsh · test', 15000);
  await app.input('reasoning\r');
  await app.waitFor(() => app.status().startsWith('─ Thinking '));
  assert.match(app.footer(), /^Esc to stop/);
  assert.doesNotMatch(app.raw, /PRIVATE_REASONING|Never display this block/);
  await app.input('draft中😀\x1b[D');
  await app.waitFor(() => app.status().startsWith('─ Responding '));
  assert.match(app.all(), /Visible answer/);
  assert.equal(app.editor(), 'draft中😀');
  assert.equal(app.terminal.buffer.normal.cursorX, 7);
  await app.waitFor(() => app.status().startsWith('─ Idle '));
  assert.match(app.all(), /Visible answer complete\./);
  assert.doesNotMatch(app.raw, /PRIVATE_REASONING|Never display this block/);
  assert.equal(app.editor(), 'draft中😀');
  assert.equal(app.terminal.buffer.normal.cursorX, 7);
  await app.input('\x03\x04');
  await app.shellCheck();
  assert.equal(app.all().split('Visible answer complete.').length - 1, 1);
});

test('Escape during thinking leaves no reasoning or empty incomplete answer and keeps the draft', async t => {
  const app = await startDsh(t, 'reasoning-cancel');
  await app.waitFor('dsh · test', 15000);
  await app.input('reasoning\r');
  await app.waitFor(() => app.status().startsWith('─ Thinking '));
  await app.input('draft中😀\x1b[D');
  await app.input('\x1b');
  await app.waitFor(() => app.status().startsWith('─ Idle ') && app.all().includes('Stopped.'));
  assert.doesNotMatch(app.raw, /PRIVATE_REASONING|Never display this block|\[incomplete\]/);
  assert.equal(app.editor(), 'draft中😀');
  assert.equal(app.terminal.buffer.normal.cursorX, 7);
  await app.input('\x03recovered\r');
  await app.waitFor(() => app.status().startsWith('─ Idle ') && app.all().includes('Reply: recovered'));
  await app.input('\x04');
  await app.shellCheck();
});

test('streamed Markdown reaches scrollback before completion and seals without a jump or replay', async t => {
  const app = await startDsh(t, 'live-markdown', { env: { NO_COLOR: '' } });
  await app.waitFor(() => app.status().startsWith('─ Idle '), 15000);
  await app.resize(125, 12);
  await app.input('wrapped-preview\r');
  await app.input('draft中😀\x1b[D');
  await app.waitFor('STREAM_PREVIEW_END');
  assert.match(app.status(), /^─ Responding /);
  assert.match(app.all(), /^STREAM_PREVIEW_TITLE$/m, 'The start of the answer must already be readable before completion');
  const buffer = app.terminal.buffer.normal;
  const heading = Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y))
    .find(line => line.translateToString(true) === 'STREAM_PREVIEW_TITLE');
  assert.ok(heading.getCell(0).isBold(), 'Streaming uses the final Markdown styling');
  const cursor = buffer.baseY + buffer.cursorY;
  for (const marker of ['STREAM_PREVIEW_TITLE', 'STREAM_PREVIEW_END']) {
    assert.equal(app.all().split(marker).length - 1, 1);
  }
  assert.equal(app.all().replaceAll('\n', '').split('中文').length - 1, 24);
  assert.equal(app.editor(), 'draft中😀');
  assert.equal(buffer.cursorX, 7);
  await app.waitFor(() => app.status().startsWith('─ Idle '));
  assert.equal(buffer.baseY + buffer.cursorY, cursor, 'Finalization must not append the answer again or move the input');
  for (const marker of ['STREAM_PREVIEW_TITLE', 'STREAM_PREVIEW_END']) {
    assert.equal(app.all().split(marker).length - 1, 1);
  }
  assert.equal(app.editor(), 'draft中😀');
  assert.equal(buffer.cursorX, 7);
  await app.input('\x03\x04');
  await app.shellCheck();
});

test('an asynchronous notice during a multi-screen stream remains visible without losing or replaying the answer', async t => {
  const app = await startDsh(t, 'live-log');
  await app.waitFor(() => app.status().startsWith('─ Idle '), 15000);
  await app.resize(125, 12);
  await app.input('stream-with-log\r');
  await app.waitFor('STREAM_PREVIEW_END');
  await app.input('draft中😀\x1b[D');
  assert.match(app.status(), /^─ Responding /);
  assert.match(app.all(), /LIVE_LOG_NOTICE/, 'An asynchronous notice must be visible while the answer is still streaming');
  await app.waitFor(() => app.status().startsWith('─ Idle '));
  for (const marker of ['STREAM_PREVIEW_TITLE', 'STREAM_PREVIEW_END', 'LIVE_LOG_NOTICE']) {
    assert.equal(app.all().split(marker).length - 1, 1, `${marker} must appear exactly once`);
  }
  assert.equal(app.all().replaceAll('\n', '').split('中文').length - 1, 24);
  assert.equal(app.editor(), 'draft中😀');
  assert.equal(app.terminal.buffer.normal.cursorX, 7);
  await app.input('\x03\x04');
  await app.shellCheck();
});

test('cancelling a multi-screen answer preserves the streamed text once and keeps the next draft', async t => {
  const app = await startDsh(t, 'live-cancel');
  await app.waitFor(() => app.status().startsWith('─ Idle '), 15000);
  await app.resize(125, 12);
  await app.input('wrapped-preview\r');
  await app.waitFor('STREAM_PREVIEW_END');
  await app.input('draft中😀\x1b[D\x1b');
  await app.waitFor(() => app.status().startsWith('─ Idle ') && app.all().includes('Stopped.'));
  for (const marker of ['STREAM_PREVIEW_TITLE', 'STREAM_PREVIEW_END', '[incomplete]', 'Stopped.']) {
    assert.equal(app.all().split(marker).length - 1, 1, `${marker} must appear exactly once`);
  }
  assert.equal(app.all().replaceAll('\n', '').split('中文').length - 1, 24);
  assert.equal(app.editor(), 'draft中😀');
  assert.equal(app.terminal.buffer.normal.cursorX, 7);
  await app.input('\x03recovered\r');
  await app.waitFor(() => app.status().startsWith('─ Idle ') && app.all().includes('Reply: recovered'));
  await app.input('\x04');
  await app.shellCheck();
});

test('125-column streaming wraps wide words without overwriting borders or leaving preview fragments', async t => {
  const app = await startDsh(t, 'stream-wide-edge');
  await app.waitFor(() => app.status().startsWith('─ Idle '), 15000);
  await app.resize(125, 25);
  await app.input('wrapped-preview\r');
  await app.input('draft中😀\x1b[D');
  await app.waitFor('STREAM_PREVIEW_END');
  assert.match(app.status(), /^─ Responding .*─$/);
  assert.equal(app.editor(), 'draft中😀');
  const buffer = app.terminal.buffer.normal;
  const cursor = buffer.baseY + buffer.cursorY;
  assert.equal(buffer.cursorX, 7);
  assert.equal(buffer.getLine(cursor + 1).translateToString(true), '─'.repeat(125));
  assert.match(buffer.getLine(cursor - 2).translateToString(true), /STREAM_PREVIEW_END/);
  assert.match(app.footer(), /^Esc to stop .*\(test\) test · default$/);
  await app.waitFor(() => app.status().startsWith('─ Idle '));
  const history = Array.from({ length: buffer.baseY + buffer.cursorY - 1 }, (_, y) => buffer.getLine(y).translateToString(true)).join('\n');
  assert.equal(history.split('STREAM_PREVIEW_TITLE').length - 1, 1);
  assert.equal(history.split('STREAM_PREVIEW_END').length - 1, 1);
  assert.equal(history.replaceAll('\n', '').split('中文').length - 1, 24);
  assert.doesNotMatch(history, /─ (?:Working|Responding) |Esc to stop/);
  assert.equal(app.editor(), 'draft中😀');
  assert.equal(buffer.cursorX, 7);
  await app.input('\x03\x04');
  await app.shellCheck();
});

test('a long streamed answer commits once without preview fragments or status rows in history', async t => {
  const app = await startDsh(t, 'long-reply');
  await app.waitFor('dsh · test', 15000);
  await app.input('long-reply\r');
  await app.input('draft中😀\x1b[D');
  await app.waitFor(() => app.status().startsWith('─ Idle ') && app.all().includes('LONG_END'));
  const buffer = app.terminal.buffer.normal;
  const cursor = buffer.baseY + buffer.cursorY;
  const history = Array.from({ length: cursor - 1 }, (_, y) => buffer.getLine(y).translateToString(true)).join('\n');
  assert.doesNotMatch(history, /─ (?:Idle|Working|Thinking|Responding) |extensions \d+ · preset|Esc to stop/);
  const markers = ['LONG_TITLE', ...Array.from({ length: 48 }, (_, i) => `LONG_${String(i).padStart(3, '0')}`), 'LONG_END'];
  let previous = -1;
  for (const marker of markers) {
    assert.equal(history.split(marker).length - 1, 1, `${marker} must appear exactly once`);
    assert.ok(history.indexOf(marker) > previous, `${marker} must stay in order`);
    previous = history.indexOf(marker);
  }
  assert.equal(app.editor(), 'draft中😀');
  assert.equal(buffer.cursorX, 7);
  await app.input('\x03\x04');
  await app.shellCheck();
});

test('color mode distinguishes submitted messages, headings, emphasis, and code', async t => {
  const app = await startDsh(t, 'markdown-color', { env: { NO_COLOR: '' } });
  await app.waitFor('dsh · test', 15000);
  await app.input('markdown\r');
  await app.waitFor(() => app.status().startsWith('─ Idle ') && app.all().includes('const answer = 42;'));
  const lines = Array.from({ length: app.terminal.buffer.normal.length }, (_, i) => app.terminal.buffer.normal.getLine(i));
  const cell = (line, column) => lines.find(row => row.translateToString(true) === line)?.getCell(column);
  assert.ok(cell('> markdown', 0)?.isBold());
  assert.equal(cell('> markdown', 0)?.isFgDefault(), false);
  assert.ok(cell('Summary', 0)?.isBold());
  assert.equal(cell('Summary', 0)?.isFgDefault(), false);
  assert.ok(cell('A bold word and inline.', 2)?.isBold());
  assert.equal(cell('  const answer = 42;', 2)?.isFgDefault(), false);
  const buffer = app.terminal.buffer.normal;
  const footer = buffer.getLine(buffer.baseY + buffer.cursorY + 3);
  const modelColumn = footer.translateToString(true).indexOf('(test)');
  assert.notEqual(modelColumn, -1);
  assert.equal(footer.getCell(modelColumn).getFgColor(), 0x808080);
  await app.input('\x04');
  await app.shellCheck();
});

test('Markdown preserves quote and numbered-list semantics and respects NO_COLOR', async t => {
  const app = await startDsh(t, 'markdown-semantics');
  await app.waitFor('dsh · test', 15000);
  await app.input('markdown\r');
  await app.waitFor(() => app.status().startsWith('─ Idle ') && app.all().includes('const answer = 42;'));
  assert.match(app.all(), /│ quoted text/);
  assert.match(app.all(), /7\. seventh\n8\. eighth/);
  const buffer = app.terminal.buffer.normal;
  for (let y = 0; y < buffer.length; y++) {
    for (let x = 0; x < app.terminal.cols; x++) {
      const cell = buffer.getLine(y).getCell(x);
      assert.equal(cell.isFgDefault(), true, `Unexpected color at ${x},${y}: ${cell.getChars()}`);
      assert.equal(cell.isBgDefault(), true);
    }
  }
  await app.input('\x04');
  await app.shellCheck();
});

test('answers render Markdown while submitted text stays literal and code survives resizing', async t => {
  const app = await startDsh(t, 'markdown');
  await app.waitFor('dsh · test', 15000);
  await app.input('literal **stars**\r');
  await app.waitFor('Reply: literal');
  await app.input('markdown\r');
  await app.waitFor('const answer = 42;');
  await app.waitFor(() => app.status().startsWith('─ Idle '));
  assert.match(app.all(), /> literal \*\*stars\*\*/);
  assert.doesNotMatch(app.all(), /## Summary|\*\*bold\*\*|```js/);
  assert.match(app.all(), /A bold word and inline/);
  for (const [cols, rows] of [[30, 12], [80, 24]]) await app.resize(cols, rows);
  assert.equal(app.all().split('const answer = 42;').length - 1, 1);
  await app.input('\x04');
  await app.shellCheck();
});

test('saving from the model picker explicitly changes the startup default for a fresh process', async t => {
  const app = await startDsh(t, 'model-save');
  await app.waitFor('dsh · test', 15000);
  await app.input('/model\r');
  await app.waitFor('Select model');
  await app.input('test/flash');
  await app.input('\x13');
  await app.waitFor('Saved default: test/flash (all profiles)');
  await app.input('\x04');
  await app.shellCheck();
  const fresh = await startApp(t, { name: 'saved-startup',
    command: `${JSON.stringify(process.execPath)} node_modules/@deepseek-ai/dsh/lib/bin.js --profile tui`,
    env: { DSH_HOME: app.home, DSH_TELEMETRY_DISABLED: '1', DSH_TOOLS_MODE: 'native' },
  });
  await fresh.waitFor('dsh · flash', 15000);
  await fresh.input('\x04');
  await fresh.shellCheck();
});

test('preset selection changes the real tool catalog only before the first turn and never saves a default', async t => {
  const app = await startDsh(t, 'preset-select');
  await app.waitFor('dsh · test', 15000);
  const settingsPath = path.join(app.home, 'settings.yaml');
  const settings = () => existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : null;
  const before = settings();
  await app.input('/preset minimal\r');
  await app.waitFor(text => text.includes('Preset: minimal') || text.includes('Unknown or invalid command'));
  assert.match(app.all(), /Preset: minimal/);
  await app.input('tool-catalog\r');
  await app.waitFor('Tools: bash, fixture_tool');
  await app.input('/preset standard\r');
  await app.waitFor('Preset is locked after the first turn. Use /new before changing it.');
  await app.input('/new\r');
  await app.waitFor('New session:');
  await app.input('tool-catalog\r');
  await app.waitFor('ask_user_question');
  assert.equal(settings(), before);
  await app.input('\x04');
  await app.shellCheck();
});

test('extensions show real host and dynamic state and newly registered commands are usable', async t => {
  const app = await startDsh(t, 'extensions');
  await app.waitFor('dsh · test', 15000);
  const context = () => {
    const buffer = app.terminal.buffer.normal;
    return buffer.getLine(buffer.baseY + buffer.cursorY + 2).translateToString(true);
  };
  assert.match(context(), /extensions 0 · preset standard$/);
  await app.input('/extensions\r');
  await app.waitFor(() => app.status().startsWith('─ Extensions '));
  await app.input('host · @deepseek-ai/dsh-tool-bash\r');
  await app.waitFor('State: disabled');
  assert.match(app.all(), /Scope: host/);
  await app.input('/fixture extension\r');
  await app.waitFor('Fixture extension running');
  await app.waitFor(() => /extensions 1 · preset standard$/.test(context()));
  await app.input('/extension-fixture\r');
  await app.waitFor('Extension command ready');
  await app.input('/extensions Fixture extension\r');
  await app.waitFor(() => app.status().startsWith('─ Extensions '));
  await app.input('\r');
  await app.waitFor('Extension: Fixture extension');
  assert.match(app.all(), /State: running/);
  assert.match(app.all(), /Scope: current session/);
  await app.input('\x04');
  await app.shellCheck();
});

test('browser-only extensions are explicitly rejected instead of waiting for a nonexistent Web client', async t => {
  const app = await startDsh(t, 'extension-client');
  await app.waitFor('dsh · test', 15000);
  await app.input('/fixture client-extension\r');
  await app.waitFor('Browser extensions are not supported in this TUI. Use a host-only extension.');
  await app.waitFor(() => app.status().startsWith('─ Idle '));
  await app.input('/extensions Client fixture\r');
  await app.waitFor(() => app.status().startsWith('─ Extensions '));
  await app.input('\r');
  await app.waitFor('State: rejected');
  await app.input('\x04');
  await app.shellCheck();
});

test('PTC and Cordis presets expose their real model tools without a Web server', async t => {
  for (const [preset, tool] of [['ptc', 'run_code'], ['cordis', 'cordis_define']]) await t.test(preset, async t => {
    const app = await startDsh(t, `preset-${preset}`);
    await app.waitFor('dsh · test', 15000);
    await app.input(`/preset ${preset}\r`);
    await app.waitFor(text => text.includes(`Preset: ${preset} (session only)`) || text.includes('Command failed:'));
    assert.ok(app.all().includes(`Preset: ${preset} (session only)`), app.all().slice(-2500));
    await app.input('tool-catalog\r');
    await app.waitFor(text => text.replaceAll('\n', '').includes(tool));
    await app.input('\x04');
    await app.shellCheck();
  });
});

test('the preset picker discovers local presets, stays outside the input, and never treats Ctrl+S as save', async t => {
  const app = await startDsh(t, 'preset-picker');
  await app.waitFor('dsh · test', 15000);
  cpSync(new URL('../node_modules/@deepseek-ai/dsh-agent-presets/presets/minimal', import.meta.url),
    path.join(app.home, '.agent-presets/local-minimal'), { recursive: true });
  await app.input('/preset\r');
  await app.waitFor(text => text.includes('Select preset') || text.includes('Usage: /preset'));
  assert.match(app.status(), /^─ Select preset /);
  for (const id of ['standard', 'ptc', 'cordis', 'minimal', 'local-minimal']) assert.ok(app.all().includes(id));
  await app.input('local-minimal\x13');
  assert.match(app.status(), /^─ Select preset /);
  assert.doesNotMatch(app.footer(), /Ctrl\+S/);
  assert.equal(app.editor(), 'local-minimal');
  const buffer = app.terminal.buffer.normal;
  const cursor = buffer.baseY + buffer.cursorY;
  assert.equal(buffer.getLine(cursor + 1).translateToString(true), '─'.repeat(80));
  assert.match(buffer.getLine(cursor + 2).translateToString(true), /^> local-minimal/);
  await app.input('\x1b');
  await app.waitFor('Preset selection cancelled.');
  await app.input('/preset\r');
  await app.waitFor(() => app.status().startsWith('─ Select preset '));
  await app.input('local-minimal\r');
  await app.waitFor('Preset: local-minimal (session only)');
  await app.input('tool-catalog\r');
  await app.waitFor('Tools: bash, fixture_tool');
  await app.input('\x04');
  await app.shellCheck();
});

test('the model list shows eight real choices outside the input and scrolls across resizes', async t => {
  const app = await startDsh(t, 'model-list');
  await app.waitFor('dsh · test', 15000);
  await app.input('/model\r');
  await app.waitFor('Select model');
  await app.input('option');
  for (const [cols, rows, count] of [[80, 24, 8], [40, 12, 6], [40, 8, 2], [80, 24, 8]]) {
    await app.resize(cols, rows);
    const buffer = app.terminal.buffer.normal;
    const cursor = buffer.baseY + buffer.cursorY;
    assert.equal(app.editor(), 'option');
    assert.match(app.status(), /^─ Select model · 1\/12 /);
    assert.equal(buffer.cursorX, 6);
    assert.equal(buffer.getLine(cursor + 1).translateToString(true), '─'.repeat(cols));
    for (let i = 0; i < count; i++) {
      assert.ok(buffer.getLine(cursor + 2 + i).translateToString(true).includes(`test/option-${String(i + 1).padStart(2, '0')}`));
    }
    assert.doesNotMatch(app.all(), new RegExp(`test/option-${String(count + 1).padStart(2, '0')}`));
  }
  await app.input('\x1b[B'.repeat(9));
  await app.waitFor('> test/option-10');
  assert.match(app.status(), /^─ Select model · 10\/12 /);
  assert.equal(app.editor(), 'option');
  await app.input('\r');
  await app.waitFor('Model: test/option-10 (session only)');
  await app.input('which-model\r');
  await app.waitFor('Model used: option-10');
  await app.input('\x04');
  await app.shellCheck();
});

test('an empty model search never reads prompt history and Escape cancels the picker', async t => {
  const app = await startDsh(t, 'model-empty');
  await app.waitFor('dsh · test', 15000);
  await app.input('/model\r');
  await app.waitFor('Select model');
  await app.input('no-such-model');
  await app.waitFor('No matching models');
  await app.input('\x1b[A');
  assert.equal(app.editor(), 'no-such-model');
  await app.input('\x1b[B\r');
  assert.equal(app.editor(), 'no-such-model');
  await app.input('\x1b');
  await app.waitFor('Model selection cancelled.');
  assert.match(app.footer(), /\(test\) test · default$/);
  assert.match(app.status(), /^─ Idle /);
  await app.input('ready\r');
  await app.waitFor('Reply: ready');
  await app.input('\x04');
  await app.shellCheck();
});

test('the model picker searches the provider catalog and selects without changing the default', async t => {
  const app = await startDsh(t, 'model-picker');
  await app.waitFor('dsh · test', 15000);
  await app.input('/model\r');
  await app.waitFor('Select model');
  await app.input('test/flash');
  await app.waitFor('test/flash — Flash test model');
  const buffer = app.terminal.buffer.normal;
  const cursor = buffer.baseY + buffer.cursorY;
  assert.equal(app.editor(), 'test/flash');
  assert.equal(buffer.getLine(cursor + 1).translateToString(true), '─'.repeat(80));
  assert.match(buffer.getLine(cursor + 2).translateToString(true), /^> test\/flash — Flash test model/);
  assert.match(buffer.getLine(cursor - 1).translateToString(true), /^─ Select model /);
  assert.match(buffer.getLine(cursor + 4).translateToString(true), /^Enter choose .*\(test\) test · default$/);
  await app.input('\r');
  await app.waitFor('Model: test/flash (session only)');
  await app.input('which-model\r');
  await app.waitFor('Model used: flash');
  await app.input('/model\r');
  await app.waitFor('Select model');
  await app.input('\x1b');
  await app.waitFor('Model selection cancelled.');
  assert.equal(app.editor(), '');
  await app.input('\x04');
  await app.shellCheck();
});

test('/model changes the actual request while leaving the saved default unchanged', async t => {
  const app = await startDsh(t, 'model-command');
  await app.waitFor('dsh · test', 15000);
  await app.input('/model test/flash\r');
  await app.waitFor('Model: test/flash (session only)');
  await app.input('which-model\r');
  await app.waitFor('Model used: flash');
  await app.input('/model\r');
  await app.waitFor('Default model: test/test');
  await app.input('\x1b');
  await app.input('\x04');
  await app.shellCheck();
});

test('slash candidates stay outside the input border and above the footer across resizes', async t => {
  const app = await startDsh(t, 'completion-below');
  await app.waitFor('dsh · test', 15000);
  await app.input('placement-history\r');
  await app.waitFor('Reply: placement-history');
  await app.input('/fi');
  await app.waitFor('/fixture — Test command');
  const check = () => {
    const buffer = app.terminal.buffer.normal;
    const cursor = buffer.baseY + buffer.cursorY;
    assert.equal(app.editor(), '/fi');
    assert.equal(buffer.cursorX, 3);
    assert.equal(buffer.getLine(cursor + 1)?.translateToString(true), '─'.repeat(app.terminal.cols));
    assert.match(buffer.getLine(cursor + 2)?.translateToString(true) ?? '', /^> \/fixture — Test command/);
    assert.match(buffer.getLine(cursor - 1)?.translateToString(true) ?? '', /^─ Commands /);
    assert.match(buffer.getLine(cursor + 4)?.translateToString(true) ?? '', /\(test\) test · default$/);
    assert.equal(app.all().split('> placement-history').length - 1, 1);
    assert.equal(app.all().split('Reply: placement-history').length - 1, 1);
  };
  check();
  for (const [cols, rows] of [[80, 12], [30, 12], [80, 8], [80, 24]]) {
    await app.resize(cols, rows);
    check();
  }
  await app.input('\x1b');
  assert.equal(app.editor(), '/fi');
  assert.doesNotMatch(app.all(), /Test command/);
  await app.input('\x03\x04');
  await app.shellCheck();
});

test('slash completion filters real commands, preserves the draft on Escape, and never submits on Tab', async t => {
  const app = await startDsh(t, 'completion');
  await app.waitFor('dsh · test', 15000);
  await app.input('/fi');
  await app.waitFor('/fixture — Test command');
  await app.input('\x1b');
  assert.equal(app.editor(), '/fi');
  assert.doesNotMatch(app.all(), /Test command/);
  await app.input('x\x7f\t');
  assert.equal(app.editor().trimEnd(), '/fixture');
  assert.doesNotMatch(app.all(), /Command ready/);
  await app.input('\r');
  await app.waitFor('Command ready');
  await app.input('\x04');
  await app.shellCheck();
});

test('/help lists registered commands and editing shortcuts without invoking the model', async t => {
  const app = await startDsh(t, 'help');
  await app.waitFor('dsh · test', 15000);
  await app.input('/help\r');
  await app.waitFor('/fixture — Test command');
  await app.waitFor('Ctrl+A/E');
  assert.doesNotMatch(app.all(), /Reply: \/help/);
  await app.input('\x04');
  await app.shellCheck();
});

test('slash commands display their own results and unknown commands never become prompts', async t => {
  const app = await startDsh(t, 'commands');
  await app.waitFor('dsh · test', 15000);
  await app.input('/fixture\r');
  await app.waitFor('Command ready');
  await app.input('/unknown\r');
  await app.waitFor('Unknown or invalid command');
  await app.input('normal\r');
  await app.waitFor('Reply: normal');
  assert.doesNotMatch(app.all(), /Reply: \/(?:fixture|unknown)/);
  await app.input('\x04');
  await app.shellCheck();
});

test('a waiting command can be cancelled without exiting or losing the next draft', async t => {
  const app = await startDsh(t, 'command-cancel');
  await app.waitFor('dsh · test', 15000);
  await app.input('/fixture wait\r');
  await app.waitFor(() => app.status().startsWith('─ Command '));
  await app.input('next\r');
  await app.input('\x03');
  await app.waitFor('Command cancelled.');
  await app.input('\r');
  await app.waitFor('Reply: next');
  await app.input('\x04');
  await app.shellCheck();
});

test('approval reaches the real service and restores the interrupted Unicode draft', async t => {
  const app = await startDsh(t, 'approval');
  await app.waitFor('dsh · test', 15000);
  await app.input('approve\r');
  await app.input('saved中😀');
  await app.waitFor('Allow fixture_tool once?');
  await app.input('y\r');
  await app.waitFor('Decision: allowed-once');
  await app.waitFor(() => app.editor().trimEnd() === 'saved中😀');
  await app.input('\r');
  await app.waitFor('Reply: saved中😀');
  await app.input('\x04');
  await app.shellCheck();
});

test('the shipped ask-user tool receives answers through the same input position', async t => {
  const app = await startDsh(t, 'questions');
  await app.waitFor('dsh · test', 15000);
  await app.input('questions\r');
  await app.waitFor('Choose mode');
  await app.input('2\r');
  await app.waitFor('Your name');
  await app.input('Ada\r');
  await app.waitFor(text => text.replaceAll('\n', '').includes('"custom":"Ada"'));
  assert.match(app.all(), /"selected":\["B"\]/);
  await app.input('\x04');
  await app.shellCheck();
});

test('Unicode editing and multiline paste produce one single-line submission', async t => {
  const app = await startDsh(t, 'input');
  await app.waitFor('dsh · test', 15000);
  await app.input('中文😀ab\x1b[D');
  assert.equal(app.terminal.buffer.normal.cursorX, 7);
  await app.input('\x1b[200~X\r\nY\x1b[201~');
  await app.waitFor(() => app.editor().trimEnd() === '中文😀aX Yb');
  assert.equal(app.terminal.buffer.normal.cursorX, 10);
  assert.doesNotMatch(app.all(), /Reply:/);
  await app.input('\r');
  await app.waitFor('Reply: 中文😀aX Yb');
  await app.input('\x04');
  await app.shellCheck();
});

test('input history restores the saved draft and its cursor without replaying answers', async t => {
  const app = await startDsh(t, 'history');
  await app.waitFor('dsh · test', 15000);
  await app.input('first\r');
  await app.waitFor('Reply: first');
  await app.input('draft\x1b[D\x1b[A');
  await app.waitFor(() => app.editor() === 'first');
  await app.input('\x1b[B');
  await app.waitFor(() => app.editor().trimEnd() === 'draft');
  assert.equal(app.terminal.buffer.normal.cursorX, 4);
  await app.input('\x03');
  await app.input('\x04');
  await app.shellCheck();
  assert.equal(app.all().split('Reply: first').length - 1, 1);
});

test('standard line shortcuts edit Unicode without splitting characters', async t => {
  const app = await startDsh(t, 'shortcuts');
  await app.waitFor('dsh · test', 15000);
  await app.input('alpha 中文😀 omega\x01');
  assert.equal(app.terminal.buffer.normal.cursorX, 0);
  await app.input('\x05\x17');
  await app.waitFor(() => app.editor().trimEnd() === 'alpha 中文😀');
  assert.doesNotMatch(app.all(), /omega/);
  await app.input('\x15left right\x01\x1b[C\x1b[C\x1b[C\x1b[C\x0b');
  await app.waitFor(() => app.editor().trimEnd() === 'left');
  assert.doesNotMatch(app.all(), /left right/);
  await app.input('\x15done\r');
  await app.waitFor('Reply: done');
  await app.input('\x04');
  await app.shellCheck();
});

test('external process-stream output cannot clear history or disrupt a partially edited input', async t => {
  const app = await startDsh(t, 'external-output');
  await app.waitFor('dsh · test', 15000);
  await app.input('log\r');
  await app.input('draft\x1b[D');
  await app.waitFor('External warning');
  await app.waitFor('Reply: log');
  await app.waitFor(() => app.status().startsWith('─ Idle ') && app.editor() === 'draft');
  assert.equal(app.terminal.buffer.normal.cursorX, 4);
  await app.input('\x03\x04');
  await app.shellCheck();
});

test('the launcher handles SIGTERM during generation and restores the terminal', async t => {
  const app = await startDsh(t, 'sigterm');
  await app.waitFor('dsh · test', 15000);
  await app.input('slow\r');
  await app.waitFor('Reply:');
  await app.signal('SIGTERM');
  // dsh 0.1.5-rc.2 deliberately exits with 0 for a graceful SIGTERM.
  await app.shellCheck(0);
});

test('the launcher handles SIGINT while awaiting a question', async t => {
  const app = await startDsh(t, 'sigint');
  await app.waitFor('dsh · test', 15000);
  await app.input('questions\r');
  await app.waitFor('Choose mode');
  await app.signal('SIGINT');
  await app.shellCheck(130);
});

for (const reflow of [false, true]) test(`submitted prompts and answers survive resizing without duplicate history (cursor reflow=${reflow})`, async t => {
  const app = await startDsh(t, `resize-${reflow}`, { reflowCursorLine: reflow });
  await app.waitFor('dsh · test', 15000);
  await app.input('history-window\r');
  await app.waitFor('Reply: history-window');
  assert.equal(app.all().split('> history-window').length - 1, 1);
  await app.input('draft😀');
  for (const [cols, rows] of [[80, 12], [30, 12], [8, 12], [80, 24]]) await app.resize(cols, rows);
  await app.waitFor(() => app.editor().trimEnd() === 'draft😀');
  assert.equal(app.all().split('> history-window').length - 1, 1);
  assert.equal(app.all().split('Reply: history-window').length - 1, 1);
  await app.input('\x03\x04');
  await app.shellCheck();
});
