// Diagnostic fixture only; this is not the dsh terminal implementation.
import net from 'node:net';
import readline from 'node:readline';
import React, {useState} from 'react';
import {Box, Text, Static, render, useInput, usePaste, useWindowSize, useCursor} from 'ink';
import stringWidth from 'string-width';

const h = React.createElement;
const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
const graphemes = text => Array.from(segmenter.segment(text), item => item.segment);
const socket = net.createConnection(process.env.INK_PROBE_SOCKET);
const messages = readline.createInterface({input: socket});
let state = {items: [], frame: 0, layout: process.env.INK_PROBE_LAYOUT};
let closing = false;
let instance;

function App({snapshot}) {
  const {columns, rows} = useWindowSize();
  const {setCursorPosition} = useCursor();
  const [editor, setEditor] = useState({parts: [], at: 0});
  const [submitted, setSubmitted] = useState([]);
  const insert = text => setEditor(previous => {
    const left = graphemes(previous.parts.slice(0, previous.at).join('') + text);
    return {parts: [...left, ...previous.parts.slice(previous.at)], at: left.length};
  });
  useInput((input, key) => {
    if (key.ctrl && (input === 'd' || input === 'c')) {
      void close(input === 'c' ? 130 : 0);
    } else if (key.leftArrow) {
      setEditor(previous => ({...previous, at: Math.max(0, previous.at - 1)}));
    } else if (key.return) {
      setSubmitted(previous => [...previous, 'INPUT:' + editor.parts.join('')]);
      setEditor({parts: [], at: 0});
    } else if (!key.ctrl && !key.escape && input) {
      insert(input);
    }
  });
  usePaste(text => insert(text.replace(/\r\n|\r|\n/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '')));
  const height = snapshot.layout === 'overflow' ? 6 : Math.min(4, Math.max(1, rows - 1));
  const lines = Array.from({length: height - 1}, (_, i) => `LIVE${snapshot.frame}:${i}`);
  const x = stringWidth('> ' + editor.parts.slice(0, editor.at).join(''));
  setCursorPosition(process.env.INK_PROBE_CURSOR === 'false' ? undefined : {x, y: height - 1});
  if (snapshot.fail) throw new Error('PROBE_RENDER_FAILURE');
  return h(React.Fragment, null,
    h(Static, {items: [...snapshot.items, ...submitted]}, item => h(Text, {key: item}, item)),
    h(Box, {flexDirection: 'column', width: columns, height, overflow: 'hidden', flexShrink: 0},
      ...lines.map((line, i) => h(Text, {key: i, wrap: 'truncate'}, line)),
      h(Text, {wrap: 'truncate'}, '> ' + editor.parts.join('')),
    ),
  );
}

async function close(code) {
  if (closing) return;
  closing = true;
  instance.unmount();
  try {
    await instance.waitUntilExit();
  } catch {
    code = 1;
  } finally {
    if (process.stdin.isRaw) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\x1b[?25h');
    messages.close();
    socket.end();
    process.exitCode = code;
  }
}

instance = render(h(App, {snapshot: state}), {
  exitOnCtrlC: false,
  alternateScreen: false,
  interactive: true,
  maxFps: 30,
});
void instance.waitUntilExit().catch(() => close(1));
process.on('SIGINT', () => void close(130));
process.on('SIGTERM', () => void close(143));

await instance.waitUntilRenderFlush();
socket.write(JSON.stringify({ready: true, pid: process.pid}) + '\n');
for await (const line of messages) {
  if (closing) break;
  const command = JSON.parse(line);
  if (command.action === 'close') {
    await close(0);
    break;
  }
  state = {...state, ...command.state};
  instance.rerender(h(App, {snapshot: state}));
  await instance.waitUntilRenderFlush();
  if (closing) break;
  socket.write(JSON.stringify({ack: command.id}) + '\n');
}
