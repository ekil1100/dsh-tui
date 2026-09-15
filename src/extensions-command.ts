import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { AgentPresetPluginRow, PluginInventoryGateway } from '@deepseek-ai/dsh-host-plugin-inventory';
import type {} from '@deepseek-ai/dsh-cordis-host-runner';
import type { TuiController } from './controller.js';

declare module '@deepseek-ai/cordis' {
  interface Context { pluginInventory: PluginInventoryGateway }
}

/** Inspect public, source-free inventories; never infer activation from installed packages. */
async function catalog(ctx: Context, agent: Agent) {
  const inventory = await ctx.pluginInventory.list();
  const items: { value: string; label: string; details: string }[] = [];
  const add = (label: string, details: string) => items.push({ value: String(items.length), label, details });
  for (const plugin of ctx.dynamicCordisRunner.listPlugins(agent)) {
    const state = plugin.latestRun?.status ?? 'defined';
    add(`[${state}] session · ${plugin.name} · ${plugin.pluginId}`, [
      `Extension: ${plugin.name}`, 'Scope: current session', `Plugin: ${plugin.pluginId}`,
      `Package: ${plugin.packageId}`, `State: ${state}`, `Purpose: ${plugin.purpose}`,
      ...(plugin.latestRun?.error ? [`Error: ${plugin.latestRun.error.message}`] : []),
    ].join('\n'));
  }
  const configured = (scope: string, rows: readonly AgentPresetPluginRow[]) => {
    for (const entry of rows) {
      const state = entry.enabled === 'conditional' ? 'conditional'
        : entry.enabled ? entry.fiberPhase ?? 'not loaded' : 'disabled';
      add(`[${state}] ${scope} · ${entry.moduleName}`, [
        `Extension: ${entry.moduleName}`, `Scope: ${scope}`, `Entry: ${entry.entryId ?? '(unnamed)'}`,
        `Module: ${entry.moduleName}`, `State: ${state}`,
      ].join('\n'));
    }
  };
  configured('host', inventory.entries);
  const current = ctx.agentPresets.composedPreset(agent.ctx);
  for (const preset of [...(inventory.agentPresets ?? [])].sort((a, b) => Number(b.id === current) - Number(a.id === current))) {
    if (preset.broken) add(`[broken] preset ${preset.id}`, `Preset: ${preset.id}\nState: broken\nError: ${preset.broken}`);
    else configured(`preset ${preset.id}`, preset.rows);
  }
  return items;
}

export function registerExtensions(ctx: Context, controller: TuiController): void {
  ctx.commands.register({
    name: 'extensions', description: 'Inspect dynamic extensions and host/preset plugins', input: { hint: '[filter]' },
    async handler({ agent, rawInput, signal }) {
      const filter = rawInput.trim().toLowerCase();
      const items = (await catalog(ctx, agent)).filter(item => item.label.toLowerCase().includes(filter));
      signal.throwIfAborted();
      if (!items.length) return { kind: 'success', text: 'No matching extensions.' };
      const choice = await controller.picker.open(items, {
        title: 'Extensions', hint: 'Enter inspect · Esc close · read-only', empty: 'No matching extensions', allowSave: false,
      }, signal);
      return { kind: 'success', text: choice ? items.find(item => item.value === choice.value)!.details : 'Extension list closed.' };
    },
  });
}
