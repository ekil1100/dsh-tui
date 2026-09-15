import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { sep } from 'node:path';
import { promisify } from 'node:util';
import type { Context } from '@deepseek-ai/cordis';
import { installModelSelection, type AgentHandle, type ModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from '@deepseek-ai/dsh-cmdline';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-user-approval';
import type {} from '@deepseek-ai/dsh-user-questions';
import type {} from '@deepseek-ai/cordis-plugin-loader';
import { TuiController, type TranscriptEntry } from './controller.js';
import { registerHelp } from './commands.js';
import { registerModel } from './model-command.js';
import { registerPreset } from './preset-command.js';
import { registerExtensions } from './extensions-command.js';
import { captureOutput } from './output.js';
import { cleanText, oneLine } from './display-text.js';
import { createTerminal, type Terminal, type TerminalEvent } from './terminal.js';

async function workspaceLabel(cwd: string, signal: AbortSignal): Promise<string> {
  const home = homedir();
  const directory = cwd === home ? '~' : cwd.startsWith(`${home}${sep}`) ? `~${cwd.slice(home.length)}` : cwd;
  try {
    const { stdout } = await promisify(execFile)('git', ['branch', '--show-current'], { cwd, signal, timeout: 1000 });
    const branch = oneLine(stdout);
    return branch ? `${directory} (${branch})` : directory;
  } catch {
    // Git is optional, and non-repository directories still have a usable path.
    return directory;
  }
}

/** Owns the terminal lifetime and serial transitions between owned Agent sessions. */
export class TuiApplication {
  private controller: TuiController;
  private terminal?: Terminal;
  private handle?: AgentHandle;
  private sessionId?: SessionId;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private stopped = false;
  private transitioning = false;
  private newRequested = false;
  private creation = new AbortController();
  private disposers: (() => void)[] = [];
  private sessionDisposers: (() => void)[] = [];
  private sessions;
  private commandAbort?: AbortController;
  private commandTask?: Promise<void>;
  private restoreOutput?: () => string[];
  private closingLogs: string[] = [];
  private workspace = process.cwd();

  constructor(private ctx: Context, private exit: (code: number) => void) {
    this.sessions = ctx.sessions;
    this.controller = this.makeController();
  }

  private makeController(history: readonly TranscriptEntry[] = []): TuiController {
    return new TuiController(
      name => this.ctx.tools.get(name, this.handle?.agent),
      message => this.ctx.logger.warn(message),
      () => this.update(() => {}),
      history,
    );
  }

  start(): Promise<void> { return this.starting ??= this.boot(); }

  private async createAgent(): Promise<ModelSelection> {
    const selection = this.ctx.agentDefaultModel.currentSelection();
    const preset = await this.ctx.agentPresets.resolve();
    this.creation.signal.throwIfAborted();
    this.controller.identity(selection.provider, selection.model, this.workspace, selection.reasoningEffort);
    const sessionId = `session-${randomUUID()}` as SessionId;
    this.sessionId = sessionId;
    const current = () => !this.stopped && this.sessionId === sessionId;
    this.sessionDisposers.push(this.ctx.on('session/event', (session, event) => {
      if (current() && session.id === sessionId) this.update(() => this.controller.session(event));
    }));
    this.handle = await this.ctx.agents.create({
      sessionId, signal: this.creation.signal,
      meta: { cwd: process.cwd(), agentPreset: preset.id },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (agentCtx, agent) => {
        await this.ctx.agentPresets.mount(agentCtx, preset.id);
        const modelSelection = { current: selection, assembled: undefined };
        agentCtx.inject(['commands', 'llm', 'agentDefaultModel', 'agentPresets', 'pluginInventory', 'dynamicCordisRunner'], commandCtx => {
          registerHelp(commandCtx);
          registerModel(commandCtx, modelSelection, this.controller, this.workspace);
          registerPreset(commandCtx, this.controller);
          registerExtensions(commandCtx, this.controller);
          commandCtx.commands.register({
            name: 'new', description: 'Start a new session',
            handler: ({ rawInput }) => {
              if (rawInput.trim()) return { kind: 'error', text: 'Usage: /new' };
              if (agent.status !== 'idle') return { kind: 'error', text: 'Stop the current task before starting a new session.' };
              this.newRequested = true;
              return { kind: 'success', text: 'Starting a new session…' };
            },
          });
        });
        installModelSelection(agentCtx, modelSelection);
        this.sessionDisposers.push(agentCtx.on('agent/assistant-stream', ({ frame }) => {
          if (current()) this.update(() => this.controller.stream(frame));
        }));
        this.sessionDisposers.push(agentCtx.on('agent/status', ({ status }) => {
          if (current()) this.update(() => this.controller.status(status));
        }));
        this.sessionDisposers.push(agentCtx.on('approval/request', (request, next) =>
          request.agent === agent && current() ? this.controller.approval(request) : next()));
        this.sessionDisposers.push(agentCtx.on('user-questions/request', (request, next) =>
          request.agent === agent && current() ? this.controller.questions(request) : next()));
      },
    });
    if (!this.stopped) this.controller.catalog(this.ctx.commands.list(this.handle.agent));
    return selection;
  }

  private async boot(): Promise<void> {
    await this.ctx.get('loader')?.await();
    if (this.stopped) return;
    this.workspace = await workspaceLabel(process.cwd(), this.creation.signal);
    if (this.stopped) return;
    const selection = await this.createAgent();
    if (this.stopped) return;
    this.disposers.push(this.ctx.on('commands/change', () => {
      if (!this.stopped && !this.transitioning && this.handle) {
        this.update(() => this.controller.catalog(this.ctx.commands.list(this.handle!.agent)));
      }
    }));
    this.disposers.push(this.ctx.on('cordis/request-run', request => {
      if (request.agentId !== this.sessionId) return;
      const message = 'Browser extensions are not supported in this TUI. Use a host-only extension.';
      this.update(() => this.controller.notice(message, 'error'));
      void this.ctx.dynamicCordisRunner.resolveRequestRun(request.requestId, {
        ok: false, reason: 'rejected', message,
      }).catch(error => this.fail(error));
    }));
    this.restoreOutput = captureOutput(line => {
      if (this.stopped) this.closingLogs.push(line);
      else this.update(() => this.controller.notice(line));
    });
    this.terminal = await createTerminal(`dsh · ${selection.model} · ${process.cwd()}`);
    if (this.stopped) { await this.terminal.close(); return; }
    this.update(() => this.controller.status(this.handle!.agent.status));
    void this.readInput().catch(error => this.fail(error));
  }

  private detachSession(): void {
    this.sessionId = undefined;
    for (const dispose of this.sessionDisposers.splice(0)) dispose();
    this.controller.closeInteractions();
  }

  private async replaceSession(): Promise<void> {
    this.transitioning = true;
    const previous = this.handle!;
    this.detachSession();
    previous.agent.cancel({ kind: 'disposed' });
    await previous.agent.whenIdle();
    await this.sessions.flush(previous.agent.session);
    await previous.dispose();
    this.handle = undefined;
    if (this.stopped) return;
    // Keep the append-only terminal timeline and its publication offset; reset only session state.
    this.controller = this.makeController(this.controller.snapshot().committed);
    this.controller.command(true);
    this.workspace = await workspaceLabel(process.cwd(), this.creation.signal);
    if (this.stopped) return;
    await this.createAgent();
    if (!this.stopped) this.controller.notice(`New session: ${this.sessionId}`);
  }

  private update(action: () => void): void {
    if (this.stopped) return;
    try {
      action();
      if (this.handle) {
        const agent = this.handle.agent;
        this.controller.status(agent.status);
        this.controller.composition(this.ctx.agentPresets.composedPreset(agent.ctx) ?? '', this.ctx.dynamicCordisRunner.listPlugins(agent).length);
      }
      this.terminal?.render(this.controller.snapshot());
    } catch (error) { void this.fail(error); }
  }

  private async readInput(): Promise<void> {
    for await (const event of this.terminal!.events()) {
      if (!this.stopped) this.input(event);
    }
  }

  private input(event: TerminalEvent): void {
    const agent = this.handle?.agent;
    if (event.type === 'pick') { this.controller.picker.answer(event); return; }
    if (event.type === 'eof') {
      if (agent?.status === 'idle' && !this.commandAbort && !this.controller.snapshot().interaction) void this.quit(0);
      return;
    }
    if (event.type === 'escape' || event.type === 'interrupt') {
      if (this.transitioning) { void this.quit(130); return; }
      if (this.commandAbort) { this.commandAbort.abort(); return; }
      if (agent?.status === 'running') agent.cancel({ kind: 'user' });
      else if (event.type === 'interrupt' && event.mode === 'idle') void this.quit(130);
      return;
    }
    if (event.type !== 'submit' || !agent) return;
    if (event.interactionId != null) {
      this.controller.answer(event.interactionId, event.text);
      return;
    }
    if (!event.text.trim() || this.commandAbort || this.controller.snapshot().interaction) return;
    this.update(() => this.controller.user(event.text));
    if (event.text.startsWith('/')) {
      this.commandAbort = new AbortController();
      this.update(() => this.controller.command(true));
      this.commandTask = this.runCommand(event.text, this.commandAbort.signal);
      return;
    }
    const message = createUserMessage({ content: [{ type: 'text', text: event.text }], source: { kind: 'user' } });
    if (agent.status === 'running') agent.steer(message);
    else agent.followup(message);
  }

  private async runCommand(line: string, signal: AbortSignal): Promise<void> {
    try {
      const execution = await this.ctx.commands.execute(this.handle!.agent, line, [], signal);
      this.update(() => this.controller.notice(signal.aborted ? 'Command cancelled.' : execution
        ? execution.result.text ?? 'Command completed.'
        : `Unknown or invalid command: ${line}`,
      !execution || execution.result.kind === 'error' ? 'error' : 'notice'));
      // The old command/done event must settle before its Agent is disposed.
      if (this.newRequested && !signal.aborted && !this.stopped) await this.replaceSession();
    } catch (error) {
      if (this.transitioning) { void this.fail(error); return; }
      this.update(() => this.controller.notice(signal.aborted ? 'Command cancelled.' : `Command failed: ${error instanceof Error ? error.message : String(error)}`, 'error'));
    } finally {
      this.newRequested = false;
      this.transitioning = false;
      this.commandAbort = undefined;
      this.update(() => this.controller.command(false));
    }
  }

  async fail(error: unknown): Promise<void> {
    if (this.stopped) return;
    await this.quit(1, error);
  }

  private async quit(code: number, error?: unknown): Promise<void> {
    try { await this.close(); }
    catch (failure) { error = failure; code = 1; }
    if (error) process.stderr.write(`dsh-tui: ${oneLine(error instanceof Error ? error.message : String(error))}\n`);
    this.exit(code);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.creation.abort();
    for (const dispose of this.disposers.splice(0)) dispose();
    this.detachSession();
    this.commandAbort?.abort();
    this.handle?.agent.cancel({ kind: 'disposed' });
    return this.closing = this.cleanup();
  }

  private async cleanup(): Promise<void> {
    try {
      await this.terminal?.close();
    } finally {
      // Startup failure is reported by fail(); cleanup still releases partial resources.
      await this.starting?.catch(() => {});
      for (const line of [...(this.restoreOutput?.() ?? []), ...this.closingLogs]) {
        process.stderr.write(`${cleanText(line)}\n`);
      }
      this.restoreOutput = undefined;
      await this.commandTask;
      const handle = this.handle;
      if (handle) {
        try {
          handle.agent.cancel({ kind: 'disposed' });
          await handle.agent.whenIdle();
          await this.sessions.flush(handle.agent.session);
        } finally { await handle.dispose(); }
      }
    }
  }
}
