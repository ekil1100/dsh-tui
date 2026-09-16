import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pty from 'node-pty';
import xterm from '@xterm/headless';
import unicode11 from '@xterm/addon-unicode11';

const root = fileURLToPath(new URL('../../', import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

export async function startDsh(t, name = 'dsh', {
  reflowCursorLine = false, env = {}, reasoningEffort, model = 'test', cwd = root,
  command = `${quote(process.execPath)} ${quote(path.join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))} --profile tui`,
} = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-tui-'));
  const profile = path.join(home, 'profiles', 'tui');
  mkdirSync(path.join(profile, 'node_modules', '@ekil9'), { recursive: true });
  symlinkSync(root, path.join(profile, 'node_modules', '@ekil9', 'dsh-tui'), 'dir');
  writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    private: true,
    dependencies: { '@ekil9/dsh-tui': `link:${root}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@ekil9/dsh-tui'], patchReload: 'startup' } },
  }));
  writeFileSync(path.join(profile, 'cordis.patch.yml'), [
    '- id: agent-default-model', '  config:', '    provider: test', `    model: ${JSON.stringify(model)}`,
    '- id: session-title-llm', '  disabled: true',
    '- insert:', '    - id: test-model', `      name: ${JSON.stringify(path.join(root, 'test/fixtures/model.mjs'))}`,
  ].join('\n'));
  if (reasoningEffort !== undefined) writeFileSync(path.join(home, 'settings.yaml'), JSON.stringify({
    'agent-default-model': { provider: 'test', model, reasoningEffort },
  }));
  const app = await startApp(t, {
    name, reflowCursorLine, cwd, command,
    env: { ...env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_TOOLS_MODE: 'native' },
  });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return Object.assign(app, { home });
}

export async function startApp(t, { name = 'dialogue', command = `${quote(process.execPath)} test/fixtures/dialogue.mjs`, env = {}, reflowCursorLine = false, cwd = root } = {}) {
  if (process.platform === 'darwin') {
    chmodSync(path.join(root, `node_modules/node-pty/prebuilds/darwin-${process.arch}/spawn-helper`), 0o755);
  }
  const terminal = new xterm.Terminal({ cols: 80, rows: 24, scrollback: 10000, allowProposedApi: true, reflowCursorLine });
  terminal.loadAddon(new unicode11.Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  let raw = '', exited = false;
  const shell = pty.spawn('/bin/bash', ['--noprofile', '--norc', '-c', `
    before=$(stty -g)
    for i in {0..59}; do printf 'OLD_%02d\n' "$i"; done
    ${command}
    code=$?
    test "$(stty -g)" = "$before" && echo STTY_OK || echo STTY_BAD
    echo APP_EXIT=$code
    read -r line
    printf 'SHELL_ECHO=%s\n' "$line"
  `], { cwd, cols: 80, rows: 24, name: 'xterm-256color', env: { ...process.env, TERM: 'xterm-256color', NO_COLOR: '1', ...env } });
  terminal.onData(data => shell.write(data));
  shell.onData(data => { raw += data; terminal.write(data); });
  shell.onExit(() => { exited = true; });
  const all = () => Array.from({ length: terminal.buffer.normal.length }, (_, i) => terminal.buffer.normal.getLine(i).translateToString(true)).join('\n');
  const waitFor = async (expected, timeout = 8000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (typeof expected === 'function' ? expected(all()) : all().includes(expected)) return;
      await delay(20);
    }
    throw new Error(`Timed out waiting for ${expected}\n${all().slice(-4000)}`);
  };
  t.after(async () => {
    mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    writeFileSync(path.join(root, 'artifacts', `${name}.ansi`), raw);
    writeFileSync(path.join(root, 'artifacts', `${name}.txt`), all());
    if (!exited) shell.kill('SIGKILL');
    terminal.dispose();
  });
  return {
    terminal, all, waitFor,
    editor() {
      const buffer = terminal.buffer.normal;
      return buffer.getLine(buffer.baseY + buffer.cursorY).translateToString(true);
    },
    status() {
      const buffer = terminal.buffer.normal;
      return buffer.getLine(buffer.baseY + buffer.cursorY - 1)?.translateToString(true) ?? '';
    },
    footer() {
      const buffer = terminal.buffer.normal;
      // Inline content may leave blank rows below it after a conservative resize.
      for (let y = terminal.rows - 1; y > buffer.cursorY; y--) {
        const line = buffer.getLine(buffer.baseY + y)?.translateToString(true);
        if (line) return line;
      }
      return '';
    },
    get raw() { return raw; },
    async input(text) { shell.write(text); await delay(100); },
    async resize(cols, rows) { terminal.resize(cols, rows); shell.resize(cols, rows); await delay(160); },
    async signal(signal) {
      const match = /TEST_PID=(\d+)/.exec(all());
      assert.ok(match, 'The model fixture must identify its host process');
      process.kill(Number(match[1]), signal);
      await delay(100);
    },
    async shellCheck(code = 0) {
      await waitFor(`APP_EXIT=${code}`);
      assert.match(all(), /STTY_OK/);
      assert.doesNotMatch(raw, /\x1b\[3J|\x1b\[\?(?:1049|1047|47)h/);
      assert.equal(terminal.modes.bracketedPasteMode, false);
      shell.write('alive\n');
      await waitFor('SHELL_ECHO=alive');
      for (let i = 0; i < 60; i++) assert.equal(all().split(`OLD_${String(i).padStart(2, '0')}`).length - 1, 1);
    },
  };
}
