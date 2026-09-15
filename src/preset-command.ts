import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent-presets';
import type { TuiController } from './controller.js';

/** Use the preset service's guarded, durable selection rather than rebinding scopes here. */
export function registerPreset(ctx: Context, controller: TuiController): void {
  ctx.commands.register({
    name: 'preset', description: 'Choose the agent preset before the first turn', input: { hint: '[id]' },
    async handler({ agent, rawInput, signal }) {
      if (agent.status !== 'idle') return { kind: 'error', text: 'Stop the current task before changing presets.' };
      let id = rawInput.trim();
      if (!id) {
        const presets = await ctx.agentPresets.list();
        signal.throwIfAborted();
        if (!presets.length) return { kind: 'error', text: 'No agent presets found.' };
        const current = ctx.agentPresets.composedPreset(agent.ctx);
        const choice = await controller.picker.open(presets.map(preset => ({
          value: preset.id,
          label: `${preset.id}${preset.name ? ` — ${preset.name}` : ''} [${preset.trust}]`
            + (preset.id === current ? ' · current' : '')
            + (preset.id === ctx.agentPresets.defaultId ? ' · default' : '')
            + (preset.broken ? ` · broken: ${preset.broken}` : ''),
        })), { title: 'Select preset', hint: 'Enter choose · Esc cancel', empty: 'No matching presets', allowSave: false }, signal);
        if (!choice) return { kind: 'success', text: 'Preset selection cancelled.' };
        id = choice.value;
      }
      if (/\s/.test(id)) return { kind: 'error', text: 'Usage: /preset [id]' };
      signal.throwIfAborted();
      try {
        const selected = await ctx.agentPresets.select(agent, id);
        controller.catalog(ctx.commands.list(agent));
        return { kind: 'success', text: `Preset: ${selected} (session only)` };
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'agent-preset/locked') {
          return { kind: 'error', text: 'Preset is locked after the first turn. Use /new before changing it.' };
        }
        throw error;
      }
    },
  });
}
