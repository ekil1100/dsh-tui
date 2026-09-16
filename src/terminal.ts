import { createRequire } from 'node:module';
import { oneLine } from './display-text.js';
import type { PickerEvent } from './picker.js';
import type { TuiController } from './controller.js';

export type TerminalEvent = PickerEvent | { type: 'submit'; text: string; interactionId: string | null } | { type: 'effort' } | { type: 'eof' | 'escape' | 'interrupt'; mode: Snapshot['mode'] };
export type Snapshot = ReturnType<TuiController['snapshot']>;

/** The production terminal and test capture implement the same small interface. */
export interface Terminal {
  render(snapshot: Snapshot): void;
  events(): AsyncIterable<TerminalEvent>;
  close(): Promise<void>;
}

interface Native {
  render(frame: string): void;
  nextEvent(): Promise<string | null>;
  close(): Promise<void>;
}

/** Load the in-process addon only after command-line parsing and TTY checks. */
export async function createTerminal(header: string): Promise<Terminal> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('dsh-tui requires an interactive TTY');
  const { NativeTerminal } = createRequire(import.meta.url)('../native/terminal.node') as {
    NativeTerminal: new (header: string) => Native;
  };
  const native = new NativeTerminal(oneLine(header));
  let published = 0;
  let closing: Promise<void> | undefined;
  try {
    const ready = await native.nextEvent();
    if (!ready || JSON.parse(ready).type !== 'ready') throw new Error('Terminal failed to start');
  } catch (error) {
    await native.close();
    throw error;
  }
  return {
    render(snapshot) {
      native.render(JSON.stringify({ ...snapshot, committed: snapshot.committed.slice(published) }));
      published = snapshot.committed.length;
    },
    async *events() {
      for (;;) {
        const raw = await native.nextEvent();
        if (raw === null) {
          if (!closing) throw new Error('Terminal driver stopped unexpectedly');
          return;
        }
        yield JSON.parse(raw) as TerminalEvent;
      }
    },
    close() { return closing ??= native.close(); },
  };
}
