import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-commands';

export const SHORTCUTS = [
  'Enter: send · Esc: clear draft / stop work · Ctrl+D: exit when idle and empty',
  'Ctrl+A/E: start/end · Ctrl+U/K/W: delete left/right/word · Up/Down: input history',
  'Paste: line breaks become spaces; Enter sends explicitly',
].join('\n');

/** Register against the receiving Agent's command scope, not a second parser. */
export function registerHelp(ctx: Context): void {
  ctx.commands.register({
    name: 'help', description: 'Show commands and keyboard shortcuts',
    handler({ agent, rawInput }) {
      if (rawInput.trim()) return { kind: 'error', text: 'Usage: /help' };
      return { kind: 'success', text: ['Commands',
        ...ctx.commands.list(agent).map(command => `/${command.name}${command.input ? ` ${command.input.hint}` : ''} — ${command.description}`),
        '', 'Keyboard', SHORTCUTS,
      ].join('\n') };
    },
  });
}
