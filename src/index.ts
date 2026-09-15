import type { Context } from '@deepseek-ai/cordis';
import { TuiApplication } from './application.js';

export const name = 'tui-runner';
export const inject = ['agents', 'sessions', 'agentDefaultModel', 'agentPresets', 'pluginInventory', 'dynamicCordisRunner', 'tools', 'commands', 'llm', 'approval', 'userQuestions'];

/** Mount one owned session; the launcher remains the process and signal owner. */
export function apply(ctx: Context): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('dsh-tui requires an interactive TTY');
  const exit = ctx.get('appExit');
  if (!exit) throw new Error('dsh-tui requires the dsh launcher');
  const app = new TuiApplication(ctx, exit);
  ctx.effect(() => {
    void app.start().catch(error => app.fail(error));
    return () => app.close();
  });
}
