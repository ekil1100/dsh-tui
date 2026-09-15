import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent';
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { ToolDefinition, ToolResultView } from '@deepseek-ai/dsh-tools';
import { cleanText, oneLine } from './display-text.js';
import { ModelPicker } from './model-picker.js';
import { InteractionQueue, type Approval, type Questions } from './interactions.js';

type Presenter = Pick<ToolDefinition, 'presentCall' | 'presentResult'>;
export type TranscriptEntry = { kind: 'user' | 'assistant' | 'tool' | 'notice' | 'error'; text: string };
type Block = TranscriptEntry & { done: boolean };

/** Ordered, terminal-independent projection for one fresh session. */
export class TuiController {
  private committed: TranscriptEntry[] = [];
  private model = '';
  private cwd = '';
  private commands: { name: string; description: string }[] = [];
  private nextSeq = 0;
  private active = '';
  private textBlocks = new Map<number, string>();
  private commandActive = false;
  private interactions: InteractionQueue;
  readonly picker: ModelPicker;
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
    this.picker = new ModelPicker(changed);
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

  identity(provider: string, model: string, cwd: string): void {
    this.model = oneLine(`${provider}/${model}`);
    this.cwd = oneLine(cwd);
  }

  catalog(commands: readonly CommandDescriptor[]): void {
    this.commands = commands.map(({ name, description }) => ({ name: oneLine(name), description: oneLine(description) }));
  }

  status(mode: 'idle' | 'running'): void { this.mode = mode; }
  command(active: boolean): void { this.commandActive = active; }
  notice(text: string, kind: TranscriptEntry['kind'] = 'notice'): void {
    if (text) this.committed.push({ kind, text: cleanText(text) });
  }
  user(text: string): void { this.notice(`> ${text}`, 'user'); }

  stream(frame: AssistantStreamFrame): void {
    if (frame.type === 'start') { this.active = ''; this.textBlocks.clear(); }
    if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') {
      const { index, text } = frame.chunk;
      this.textBlocks.set(index, (this.textBlocks.get(index) ?? '') + text);
      this.active = [...this.textBlocks].sort(([left], [right]) => left - right).map(([, text]) => text).join('');
    }
  }

  session(event: SessionEvent): void {
    if (event.seq !== this.nextSeq) throw new Error(`Expected session event ${this.nextSeq}, received ${event.seq}`);
    this.nextSeq++;
    switch (event.type) {
      case 'turn/start': this.mode = 'running'; break;
      case 'assistant/message':
        this.pending.push({ kind: 'assistant', done: true, text: event.data.message.content
          .filter(block => block.type === 'text').map(block => block.text).join('') + (event.data.interrupted ? '\n[incomplete]' : '') });
        this.active = '';
        break;
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
        if (this.active) this.pending.push({ kind: 'assistant', done: true, text: `${this.active}\n[incomplete]` });
        this.active = '';
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
    while (this.pending[0]?.done) {
      const block = this.pending.shift()!;
      if (block.text) this.notice(block.text, block.kind);
    }
  }

  snapshot() {
    const prompt = this.interactions.current();
    return {
      committed: [...this.committed],
      model: this.model, cwd: this.cwd, commands: this.commands, picker: this.picker.current,
      active: cleanText([...this.pending.map(block => block.text), this.active].filter(Boolean).join('\n')),
      mode: prompt ? 'interaction' as const : this.commandActive ? 'command' as const : this.mode,
      interaction: prompt ? { id: prompt.id, hint: oneLine(prompt.hint) } : null,
    };
  }
}
