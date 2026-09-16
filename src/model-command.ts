import type { Context } from '@deepseek-ai/cordis';
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import type { LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm';
import type { CommandResult } from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import { TuiController } from './controller.js';

/** The same mutable selection drives both prompt assembly and the visible footer. */
export function registerModel(
  ctx: Context, selection: ModelSelectionRef, controller: TuiController, workspace: string,
  reasoning: LlmModelReasoningInfo | undefined,
): () => CommandResult {
  // Reuse capabilities resolved when selecting the model; a shortcut needs no async command state.
  const cycleEffort = (): CommandResult => {
    const current = selection.current;
    if (!current) throw new Error('The Agent has no model selection');
    const efforts = reasoning?.efforts;
    if (!efforts?.length) return { kind: 'error', text: `No reasoning effort choices are available for ${current.provider}/${current.model}.` };
    const effective = current.reasoningEffort ?? reasoning?.defaultEffort;
    const index = efforts.findIndex(effort => effort.id === effective);
    const next = { ...current, reasoningEffort: efforts[(index + 1) % efforts.length]!.id };
    selection.current = next;
    controller.identity(next.provider, next.model, workspace, next.reasoningEffort);
    return { kind: 'success' };
  };
  ctx.commands.register({
    name: 'effort', description: 'Cycle reasoning effort for this session',
    handler({ rawInput }) {
      return rawInput.trim() ? { kind: 'error', text: 'Usage: /effort' } : cycleEffort();
    },
  });
  ctx.commands.register({
    name: 'model', description: 'Choose a model for this session', input: { hint: '[provider/model]' },
    async handler({ agent, rawInput, signal }) {
      if (agent.status !== 'idle') return { kind: 'error', text: 'Stop the current task before changing models.' };
      const current = selection.current;
      if (!current) throw new Error('The Agent has no model selection');
      let value = rawInput.trim();
      let save = false;
      if (!value) {
        const saved = ctx.agentDefaultModel.currentSelection();
        controller.notice(`Current model: ${current.provider}/${current.model}\nDefault model: ${saved.provider}/${saved.model}\nEnter selects for this session. Ctrl+S saves the default for all profiles.`);
        const entries = await catalog(ctx, signal);
        signal.throwIfAborted();
        if (!entries.length) return { kind: 'error', text: 'No models advertised. Use /model provider/model for an exact model ID.' };
        const choice = await controller.picker.open(entries, {
          title: 'Select model', hint: 'Enter choose · Ctrl+S save globally · Esc cancel',
          empty: 'No matching models', allowSave: true,
        }, signal);
        if (!choice) return { kind: 'success', text: 'Model selection cancelled.' };
        value = choice.value;
        save = choice.save;
      }
      if (/\s/.test(value)) return { kind: 'error', text: 'Usage: /model [provider/model]' };
      const slash = value.indexOf('/');
      const provider = slash < 0 ? current.provider : value.slice(0, slash);
      const model = slash < 0 ? value : value.slice(slash + 1);
      if (!provider || !model) return { kind: 'error', text: 'Both provider and model must be non-empty.' };
      const info = await ctx.llm.resolveModelInfo(provider, model, signal);
      signal.throwIfAborted();
      const next = { provider, model,
        ...(provider === current.provider && model === current.model ? { reasoningEffort: current.reasoningEffort } : {}),
      };
      if (save) await ctx.agentDefaultModel.saveSelection(next);
      selection.current = next;
      reasoning = info.reasoning;
      controller.identity(provider, model, workspace, next.reasoningEffort ?? reasoning?.defaultEffort);
      return { kind: 'success', text: save ? `Saved default: ${provider}/${model} (all profiles)` : `Model: ${provider}/${model} (session only)` };
    },
  });
  return cycleEffort;
}

async function catalog(ctx: Context, signal: AbortSignal) {
  signal.throwIfAborted();
  const pending = Promise.all(ctx.llm.listProviders().map(async provider => {
    const models = await ctx.llm.listModels(provider.id);
    return models.map(model => ({ value: `${provider.id}/${model.id}`, label: `${provider.id}/${model.id} — ${model.name}` }));
  }));
  // listModels has no signal parameter. Stop waiting without allowing a late result to mutate UI.
  return new Promise<Awaited<typeof pending>[number]>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    pending.then(groups => resolve(groups.flat()), reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
