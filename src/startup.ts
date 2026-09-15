import type { Context } from '@deepseek-ai/cordis';
import { parseCmdline } from '@deepseek-ai/dsh-cmdline';
import { Command } from 'commander';

export const name = 'tui-startup';
export const inject = ['cmdlineArgs'];

/** Help and invalid arguments never activate the terminal runner. */
export function apply(ctx: Context): void {
  const program = new Command()
    .name('dsh --profile tui')
    .description('Start an inline terminal session. Esc stops work; Ctrl+D exits when idle.')
    .helpOption('-h, --help', 'show this help')
    .action(() => { ctx.provide('tuiStartup', {}); });
  parseCmdline(ctx, program);
}
