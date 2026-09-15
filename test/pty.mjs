import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { startApp, startDsh } from './support/pty.mjs';

test('the built native addon loads in a fresh Node process', () => {
  const result = spawnSync(process.execPath, ['-e', 'console.log(typeof require("./native/terminal.node").NativeTerminal)'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, `Native load failed: ${result.signal ?? result.error ?? result.stderr}`);
  assert.equal(result.stdout.trim(), 'function');
});

test('the editor has a separator and an actual-model footer without moving the draft cursor', async t => {
  const app = await startDsh(t, 'footer');
  await app.waitFor('dsh · test', 15000);
  await app.input('中文😀ab\x1b[D');
  const buffer = app.terminal.buffer.normal;
  const cursor = buffer.baseY + buffer.cursorY;
  assert.match(buffer.getLine(cursor - 1).translateToString(true), /─/);
  assert.match(buffer.getLine(cursor + 1).translateToString(true), /test\/test.*idle/);
  assert.equal(buffer.cursorX, 9);
  await app.input('\x03\x04');
  await app.shellCheck();
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
  await app.waitFor(() => app.editor() === '>');
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
  await app.waitFor(() => app.editor() === '>');
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
  assert.match(app.footer(), /^test\/test · idle/);
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

test('color mode distinguishes submitted messages, headings, emphasis, and code', async t => {
  const app = await startDsh(t, 'markdown-color', { env: { NO_COLOR: '' } });
  await app.waitFor('dsh · test', 15000);
  await app.input('markdown\r');
  await app.waitFor(() => app.footer().includes(' · idle') && app.all().includes('const answer = 42;'));
  const lines = Array.from({ length: app.terminal.buffer.normal.length }, (_, i) => app.terminal.buffer.normal.getLine(i));
  const cell = (line, column) => lines.find(row => row.translateToString(true) === line)?.getCell(column);
  assert.ok(cell('> markdown', 0)?.isBold());
  assert.equal(cell('> markdown', 0)?.isFgDefault(), false);
  assert.ok(cell('Summary', 0)?.isBold());
  assert.equal(cell('Summary', 0)?.isFgDefault(), false);
  assert.ok(cell('A bold word and inline.', 2)?.isBold());
  assert.equal(cell('  const answer = 42;', 2)?.isFgDefault(), false);
  const buffer = app.terminal.buffer.normal;
  assert.equal(buffer.getLine(buffer.baseY + buffer.cursorY + 1).getCell(0).isFgDefault(), true);
  await app.input('\x04');
  await app.shellCheck();
});

test('Markdown preserves quote and numbered-list semantics and respects NO_COLOR', async t => {
  const app = await startDsh(t, 'markdown-semantics');
  await app.waitFor('dsh · test', 15000);
  await app.input('markdown\r');
  await app.waitFor(() => app.footer().includes(' · idle') && app.all().includes('const answer = 42;'));
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
  await app.waitFor(text => text.includes('test/test · idle'));
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

test('an empty model search never reads prompt history and Escape cancels the picker', async t => {
  const app = await startDsh(t, 'model-empty');
  await app.waitFor('dsh · test', 15000);
  await app.input('/model\r');
  await app.waitFor('Select model');
  await app.input('no-such-model');
  await app.waitFor('No matching models');
  await app.input('\x1b[A');
  assert.equal(app.editor(), '> no-such-model');
  await app.input('\x1b[B\r');
  assert.equal(app.editor(), '> no-such-model');
  await app.input('\x1b');
  await app.waitFor('Model selection cancelled.');
  assert.match(app.footer(), /^test\/test · idle/);
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
  assert.equal(app.editor(), '> test/flash');
  assert.match(buffer.getLine(cursor + 1).translateToString(true), /^> test\/flash — Flash test model/);
  assert.match(buffer.getLine(cursor + 3).translateToString(true), /^Select model/);
  await app.input('\r');
  await app.waitFor('Model: test/flash (session only)');
  await app.input('which-model\r');
  await app.waitFor('Model used: flash');
  await app.input('/model\r');
  await app.waitFor('Select model');
  await app.input('\x1b');
  await app.waitFor('Model selection cancelled.');
  assert.equal(app.editor(), '>');
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

test('slash candidates stay below the editor and above the footer across resizes', async t => {
  const app = await startDsh(t, 'completion-below');
  await app.waitFor('dsh · test', 15000);
  await app.input('placement-history\r');
  await app.waitFor('Reply: placement-history');
  await app.input('/fi');
  await app.waitFor('/fixture — Test command');
  const check = () => {
    const buffer = app.terminal.buffer.normal;
    const cursor = buffer.baseY + buffer.cursorY;
    assert.equal(app.editor(), '> /fi');
    assert.equal(buffer.cursorX, 5);
    assert.match(buffer.getLine(cursor + 1)?.translateToString(true) ?? '', /^> \/fixture — Test command/);
    assert.match(buffer.getLine(cursor + 3)?.translateToString(true) ?? '', /^test\/test · Tab complete/);
    assert.equal(app.all().split('> placement-history').length - 1, 1);
    assert.equal(app.all().split('Reply: placement-history').length - 1, 1);
  };
  check();
  for (const [cols, rows] of [[80, 12], [30, 12], [80, 24]]) {
    await app.resize(cols, rows);
    check();
  }
  await app.input('\x1b');
  assert.equal(app.editor(), '> /fi');
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
  assert.equal(app.editor(), '> /fi');
  assert.doesNotMatch(app.all(), /Test command/);
  await app.input('x\x7f\t');
  assert.equal(app.editor().trimEnd(), '> /fixture');
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
  await app.waitFor('command');
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
  await app.waitFor('> saved中😀');
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
  assert.equal(app.terminal.buffer.normal.cursorX, 9);
  await app.input('\x1b[200~X\r\nY\x1b[201~');
  await app.waitFor('> 中文😀aX Yb');
  assert.equal(app.terminal.buffer.normal.cursorX, 12);
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
  await app.waitFor(() => app.editor() === '> first');
  await app.input('\x1b[B');
  await app.waitFor('> draft');
  assert.equal(app.terminal.buffer.normal.cursorX, 6);
  await app.input('\x03');
  await app.input('\x04');
  await app.shellCheck();
  assert.equal(app.all().split('Reply: first').length - 1, 1);
});

test('standard line shortcuts edit Unicode without splitting characters', async t => {
  const app = await startDsh(t, 'shortcuts');
  await app.waitFor('dsh · test', 15000);
  await app.input('alpha 中文😀 omega\x01');
  assert.equal(app.terminal.buffer.normal.cursorX, 2);
  await app.input('\x05\x17');
  await app.waitFor('> alpha 中文😀');
  assert.doesNotMatch(app.all(), /omega/);
  await app.input('\x15left right\x01\x1b[C\x1b[C\x1b[C\x1b[C\x0b');
  await app.waitFor('> left');
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
  await app.waitFor(() => app.footer().includes(' · idle') && app.editor() === '> draft');
  assert.equal(app.terminal.buffer.normal.cursorX, 6);
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
  await app.waitFor('> draft😀');
  assert.equal(app.all().split('> history-window').length - 1, 1);
  assert.equal(app.all().split('Reply: history-window').length - 1, 1);
  await app.input('\x03\x04');
  await app.shellCheck();
});
