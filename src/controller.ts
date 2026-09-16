import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent';
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { ToolDefinition, ToolResultView } from '@deepseek-ai/dsh-tools';
import { cleanText, oneLine } from './display-text.js';
import { Picker } from './picker.js';
import { InteractionQueue, type Approval, type Questions } from './interactions.js';

type Presenter = Pick<ToolDefinition, 'presentCall' | 'presentResult'>;
export type TranscriptEntry = { kind: 'user' | 'assistant' | 'tool' | 'notice' | 'error'; text: string };
type Block = TranscriptEntry & { done: boolean };

function tokens(value: number): string {
  const unit = value >= 1_000_000 ? 1_000_000 : value >= 1000 ? 1000 : 1;
  return unit === 1 ? String(value) : (value / unit).toFixed(1).replace(/\.0$/, '') + (unit === 1000 ? 'k' : 'M');
}

/** Ordered, terminal-independent projection for one fresh session. */
export class TuiController {
  private committed: TranscriptEntry[] = [];
  private model = '';
  private effort = 'default';
  private cwd = '';
  private preset = '';
  private extensions = 0;
  private usage?: { input: number; output: number; read: number; write: number };
  private commands: { name: string; description: string }[] = [];
  private nextSeq = 0;
  private active?: Block;
  private activity: '' | 'thinking' | 'responding' = '';
  private textBlocks = new Map<number, string>();
  private commandActive = false;
  private interactions: InteractionQueue;
  readonly picker: Picker;
  private announced: string | undefined;
  private mode: 'idle' | 'running' = 'idle';
  private pending: Block[] = [];
  private calls = new Map<string, { block: Block; title: string; turn: number; args: unknown; presenter?: Presenter }>();

  constructor(
    private presenter: (name: string) => Presenter | undefined = () => undefined,
    private warn: (message: string) => void = () => {},
    changed: () => void = () => {},
    history: readonly TranscriptEntry[] = [],
  ) {
    this.committed = [...history];
    this.picker = new Picker(changed);
    this.interactions = new InteractionQueue(() => {
      const prompt = this.interactions.current();
      if (prompt && prompt.id !== this.announced) this.notice(prompt.body);
      this.announced = prompt?.id;
      changed();
    });
  }

  approval(request: Approval) { return this.interactions.approval(request); }
  questions(request: Questions) { return this.interactions.questions(request); }
  answer(id: string, text: string): void { this.interactions.answer(id, text); }
  closeInteractions(): void { this.interactions.close(); this.picker.close(); }

  identity(provider: string, model: string, cwd: string, effort?: string): void {
    this.model = oneLine(`(${provider}) ${model}`);
    this.effort = oneLine(effort ?? 'default');
    this.cwd = oneLine(cwd);
  }

  composition(preset: string, extensions: number): void {
    this.preset = oneLine(preset);
    this.extensions = extensions;
  }

  catalog(commands: readonly CommandDescriptor[]): void {
    this.commands = commands.map(({ name, description }) => ({ name: oneLine(name), description: oneLine(description) }));
  }

  status(mode: 'idle' | 'running'): void { this.mode = mode; }
  command(active: boolean): void { this.commandActive = active; }
  notice(text: string, kind: TranscriptEntry['kind'] = 'notice'): void {
    if (text) this.pending.push({ kind, text, done: true });
    this.flush();
  }
  user(text: string): void { this.notice(`> ${text}`, 'user'); }

  private settleAssistant(text: string): void {
    if (this.active) {
      this.active.text = text;
      this.active.done = true;
      this.active = undefined;
    } else {
      this.pending.push({ kind: 'assistant', text, done: true });
    }
  }

  private flush(): void {
    while (this.pending[0]?.done) {
      const { kind, text } = this.pending.shift()!;
      if (text) this.committed.push({ kind, text: cleanText(text) });
    }
  }

  stream(frame: AssistantStreamFrame): void {
    if (frame.type === 'start') {
      this.activity = '';
      this.textBlocks.clear();
      return;
    }
    if (frame.type === 'end') {
      // Successful messages have already settled via the durable session event.
      // Abandoned or failed attempts must not strand visible text or later notices.
      if (this.active) this.settleAssistant(`${this.active.text}\n[incomplete]`);
      this.activity = '';
      this.flush();
      return;
    }
    const chunk = frame.chunk;
    if (chunk.type === 'block-start') {
      this.activity = chunk.blockType === 'reasoning' ? 'thinking' : chunk.blockType === 'text' ? 'responding' : '';
    }
    if (chunk.type === 'reasoning-delta') this.activity = 'thinking';
    if (chunk.type === 'text-delta') {
      this.activity = 'responding';
      const { index, text } = chunk;
      this.textBlocks.set(index, (this.textBlocks.get(index) ?? '') + text);
      if (!this.active) {
        this.active = { kind: 'assistant', text: '', done: false };
        this.pending.push(this.active);
      }
      this.active.text = [...this.textBlocks].sort(([left], [right]) => left - right).map(([, text]) => text).join('');
    }
  }

  session(event: SessionEvent): void {
    if (event.seq !== this.nextSeq) throw new Error(`Expected session event ${this.nextSeq}, received ${event.seq}`);
    this.nextSeq++;
    switch (event.type) {
      case 'turn/start': this.mode = 'running'; break;
      case 'assistant/message': {
        if (event.data.usage) {
          const usage = event.data.usage;
          this.usage ??= { input: 0, output: 0, read: 0, write: 0 };
          this.usage.input += usage.inputTokens;
          this.usage.output += usage.outputTokens;
          this.usage.read += usage.cacheReadTokens ?? 0;
          this.usage.write += usage.cacheWriteTokens ?? 0;
        }
        const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
        this.settleAssistant(text && event.data.interrupted ? `${text}\n[incomplete]` : text);
        this.activity = '';
        break;
      }
      case 'tool/call': {
        const { name, arguments: raw, callId } = event.data;
        let args: unknown;
        let presenter: Presenter | undefined;
        let title = name;
        try {
          args = JSON.parse(raw);
          presenter = this.presenter(name);
          const view = presenter?.presentCall?.(args);
          title = `${view?.card === 'terminal' ? '$ ' : ''}${view?.title ?? name}`;
        } catch { this.warn(`Cannot present tool call: ${oneLine(name)}`); }
        title = oneLine(title);
        const block: Block = { kind: 'tool', text: `… ${title}`, done: false };
        this.pending.push(block);
        this.calls.set(callId, { block, title, turn: event.data.turn, args, presenter });
        break;
      }
      case 'tool/result': {
        const { message, meta } = event.data;
        const call = this.calls.get(message.source.callId);
        if (!call) break;
        const result = message.content[0];
        let view: ToolResultView | undefined;
        try {
          view = call.presenter?.presentResult?.(call.args, {
            content: result.content, isError: Boolean(result.isError), meta,
          });
        } catch { this.warn(`Cannot present tool result: ${call.title}`); }
        const suffix = view?.card === 'terminal'
          ? view.exitCode !== undefined ? ` · exit ${view.exitCode}` : view.signal ? ` · ${view.signal}` : ''
          : '';
        const error = result.isError ? oneLine(result.content
          .filter(block => block.type === 'text').map(block => block.text).join('')) : '';
        call.block.text = `${result.isError ? '✗' : '✓'} ${call.title}${suffix}${error ? ` · ${error}` : ''}`;
        call.block.kind = result.isError ? 'error' : 'tool';
        call.block.done = true;
        this.calls.delete(message.source.callId);
        break;
      }
      case 'turn/end': {
        const { turn, reason } = event.data;
        for (const [id, call] of this.calls) {
          if (call.turn !== turn) continue;
          call.block.text = `✗ ${call.title} · ${reason.kind === 'aborted' ? 'cancelled' : 'failed'}`;
          call.block.kind = 'error';
          call.block.done = true;
          this.calls.delete(id);
        }
        if (this.active) this.settleAssistant(`${this.active.text}\n[incomplete]`);
        this.activity = '';
        if (reason.kind !== 'completed') {
          const text = reason.kind === 'aborted' ? 'Stopped.'
            : reason.kind === 'error' ? `Error: ${reason.error.code}: ${reason.error.message}`
            : `Turn ended: ${reason.kind}`;
          this.pending.push({ kind: reason.kind === 'aborted' ? 'notice' : 'error', done: true, text });
        }
        this.mode = 'idle';
        break;
      }
    }
    this.flush();
  }

  snapshot() {
    const prompt = this.interactions.current();
    const usage = this.usage;
    return {
      committed: [...this.committed],
      model: this.model, effort: this.effort, cwd: this.cwd, preset: this.preset, extensions: this.extensions,
      commands: this.commands, picker: this.picker.current,
      stats: usage ? [`↑${tokens(usage.input)}`, `↓${tokens(usage.output)}`,
        usage.read ? `R${tokens(usage.read)}` : '', usage.write ? `W${tokens(usage.write)}` : '',
      ].filter(Boolean).join(' ') : '',
      active: this.pending.filter(entry => entry.text).map(({ kind, text }) => ({ kind, text: cleanText(text) })),
      activity: this.activity,
      mode: prompt ? 'interaction' as const : this.commandActive ? 'command' as const : this.mode,
      interaction: prompt ? { id: prompt.id, hint: oneLine(prompt.hint) } : null,
    };
  }
}
