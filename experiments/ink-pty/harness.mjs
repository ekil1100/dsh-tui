import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import net from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import readline from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import pty from 'node-pty';
import xterm from '@xterm/headless';
import unicode11 from '@xterm/addon-unicode11';

const directory = path.dirname(fileURLToPath(import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

export async function startProbe(t, {
  name, cols = 80, rows = 24, layout = 'bounded', cursor = true,
  command = [process.execPath, path.join(directory, 'fixture.mjs')],
  artifactDirectory = path.join(directory, 'artifacts'),
  fixtureEnv = {},
} = {}) {
  const scratch = await mkdtemp(path.join(tmpdir(), 'ink-pty-'));
  // macOS limits Unix-domain socket paths to 104 bytes.
  const socketPath = path.join(scratch, 's');
  const terminal = new xterm.Terminal({cols, rows, scrollback: 10000, allowProposedApi: true});
  terminal.loadAddon(new unicode11.Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  const server = net.createServer();
  let socket;
  let processId;
  let raw = '';
  let pendingWrites = Promise.resolve();
  let lastOutput = Date.now();
  let commandId = 0;
  let exited = false;
  let exitInfo;
  const acks = new Set();
  const snapshots = [];
  const events = [];
  let child;
  let cursorVisible = true;
  let replyToCursorReports = true;
  const trackedModes = {alternate: 0, eraseScrollback: 0, pasteEnable: 0, pasteDisable: 0};
  terminal.parser.registerCsiHandler({final: 'J'}, params => {
    if (params[0] === 3) trackedModes.eraseScrollback++;
    return false;
  });
  for (const final of ['h', 'l']) {
    terminal.parser.registerCsiHandler({prefix: '?', final}, params => {
      if (params.includes(25)) cursorVisible = final === 'h';
      if (final === 'h' && params.some(p => [47, 1047, 1049].includes(p))) trackedModes.alternate++;
      if (params.includes(2004)) trackedModes[final === 'h' ? 'pasteEnable' : 'pasteDisable']++;
      return false;
    });
  }
  server.on('connection', connection => {
    socket = connection;
    const lines = readline.createInterface({input: connection});
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.ready) processId = message.pid;
      if (message.ack) acks.add(message.ack);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });

  async function waitFor(predicate, description, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await pendingWrites;
      if (predicate()) return;
      await delay(10);
    }
    throw new Error(`Timed out: ${description}\n${screen()}`);
  }

  async function settle() {
    await delay(100);
    await waitFor(() => Date.now() - lastOutput >= 50, 'output to settle');
    await pendingWrites;
  }

  function logicalLines() {
    const buffer = terminal.buffer.normal;
    const lines = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return lines;
  }

  function screen() {
    const buffer = terminal.buffer.active;
    return Array.from({length: terminal.rows}, (_, i) => buffer.getLine(buffer.baseY + i)?.translateToString(true) ?? '').join('\n');
  }

  function snapshot(label) {
    const buffer = terminal.buffer.normal;
    const result = {
      label, cols: terminal.cols, rows: terminal.rows,
      cursor: {x: buffer.cursorX, y: buffer.cursorY},
      baseY: buffer.baseY, screen: screen(), lines: logicalLines(),
      modes: {...trackedModes}, cursorVisible,
      bracketedPaste: terminal.modes.bracketedPasteMode,
      unicodeVersion: terminal.unicode.activeVersion,
      bytes: Buffer.byteLength(raw),
    };
    snapshots.push(result);
    return result;
  }

  const shell = `before=$(stty -g)
for ((i=0; i<60; i++)); do printf 'OLD_%02d\\n' "$i"; done
${command.map(quote).join(' ')}
code=$?
after=$(stty -g)
if [ "$before" = "$after" ]; then printf '\\nSTTY_OK\\n'; else printf '\\nSTTY_BAD\\nBEFORE=%s\\nAFTER=%s\\n' "$before" "$after"; fi
printf 'APP_EXIT=%s\\n' "$code"
IFS= read -r reply
printf 'SHELL_ECHO=%s\\n' "$reply"
`;
  const env = {...process.env, ...fixtureEnv, TERM: 'xterm-256color', NO_COLOR: '1', INK_PROBE_SOCKET: socketPath, INK_PROBE_LAYOUT: layout, INK_PROBE_CURSOR: String(cursor)};
  delete env.CI;
  delete env.FORCE_COLOR;
  try {
    child = pty.spawn('/bin/bash', ['--noprofile', '--norc', '-c', shell], {name: 'xterm-256color', cols, rows, cwd: directory, env});
  } catch (error) {
    terminal.dispose();
    server.close();
    await rm(scratch, {recursive: true, force: true});
    throw error;
  }
  terminal.onData(data => {
    const reply = replyToCursorReports ? data : data.replace(/\x1b\[\d+;\d+R/g, '');
    if (reply !== data) events.push({action: 'cursor-report-suppressed', data, rawOffset: raw.length});
    if (reply) child.write(reply);
  });
  child.onData(data => {
    raw += data;
    lastOutput = Date.now();
    pendingWrites = pendingWrites.then(() => new Promise(resolve => terminal.write(data, resolve)));
  });
  child.onExit(info => {exited = true; exitInfo = info;});

  t.after(async () => {
    if (!exited) {
      if (socket && !socket.destroyed) socket.write(JSON.stringify({action: 'close'}) + '\n');
      await delay(150);
      child.write('probe-cleanup\n');
      await delay(150);
      if (!exited) child.kill();
    }
    await pendingWrites;
    await mkdir(artifactDirectory, {recursive: true});
    await writeFile(path.join(artifactDirectory, `${name}.ansi`), raw);
    await writeFile(path.join(artifactDirectory, `${name}.json`), JSON.stringify({events, snapshots, final: snapshot('cleanup'), exitInfo}, null, 2));
    socket?.destroy();
    server.close();
    terminal.dispose();
    await rm(scratch, {recursive: true, force: true});
  });
  await waitFor(() => processId !== undefined || exited, 'fixture startup');
  assert.ok(processId, `Fixture failed to start: ${raw}`);
  await settle();

  return {
    snapshot, screen, logicalLines,
    get raw() {return raw;},
    get modes() {return trackedModes;},
    get cursorVisible() {return cursorVisible;},
    get terminal() {return terminal;},
    cursorReports(enabled) {
      replyToCursorReports = enabled;
      events.push({action: 'cursor-reports', enabled, rawOffset: raw.length});
    },
    async frame(state) {
      const id = ++commandId;
      events.push({action: 'frame', state, rawOffset: raw.length});
      socket.write(JSON.stringify({id, state}) + '\n');
      await waitFor(() => acks.has(id), `frame ${id}`);
      await settle();
    },
    async resize(width, height) {
      events.push({action: 'resize', cols: width, rows: height, rawOffset: raw.length});
      await pendingWrites;
      terminal.resize(width, height);
      // Capture emulator reflow before the application receives SIGWINCH.
      snapshot(`host-resize-${width}x${height}`);
      child.resize(width, height);
      await settle();
    },
    async input(text) {
      events.push({action: 'input', text, rawOffset: raw.length});
      child.write(text);
      await settle();
    },
    async stop(signal) {
      if (signal === 'render-error') socket.write(JSON.stringify({state: {fail: true}}) + '\n');
      else if (signal) process.kill(processId, signal);
      else socket.write(JSON.stringify({action: 'close'}) + '\n');
      await waitFor(() => raw.includes('APP_EXIT='), 'return to shell');
      await settle();
    },
    async assertShell(expectedExit = 0) {
      assert.match(raw, /STTY_OK/, 'TTY settings must match the same shell before and after the app');
      assert.match(raw, new RegExp(`APP_EXIT=${expectedExit}\\r?\\n`));
      assert.ok(cursorVisible, 'Cursor must be visible after exit');
      assert.equal(terminal.modes.bracketedPasteMode, false, 'Bracketed paste must be disabled after exit');
      assert.equal(trackedModes.pasteEnable, trackedModes.pasteDisable, 'Bracketed paste enable/disable must be balanced');
      child.write('shell-is-usable\n');
      await waitFor(() => exited, 'shell echo');
      assert.match(logicalLines().join('\n'), /SHELL_ECHO=shell-is-usable/);
    },
  };
}

export function assertHistory(probe, expected = []) {
  const lines = probe.logicalLines();
  const oldMarkers = Array.from({length: 60}, (_, i) => `OLD_${String(i).padStart(2, '0')}`);
  for (const marker of [...oldMarkers, ...expected]) {
    // A cell-diff renderer may reuse existing characters instead of writing the whole marker.
    assert.equal(lines.filter(line => line.includes(marker)).length, 1, `${marker} must exist exactly once`);
  }
  assert.equal(probe.modes.eraseScrollback, 0, 'Must not emit CSI 3 J');
  assert.equal(probe.modes.alternate, 0, 'Must not enter alternate screen');
}
