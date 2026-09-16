import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

export const inject = ['llm', 'tools', 'commands', 'approval'];

class Model extends LlmAdapter {
  async listModels(provider) {
    return [{ provider, id: 'test', name: 'Test model' }, { provider, id: 'flash', name: 'Flash test model' },
      ...Array.from({ length: 12 }, (_, i) => {
        const number = String(i + 1).padStart(2, '0');
        return { provider, id: `option-${number}`, name: `Fixture option ${number}` };
      }),
    ];
  }

  async resolveModel(provider, model, signal) {
    if (process.env.DSH_TEST_MODEL_INFO_DELAY) {
      await delay(Number(process.env.DSH_TEST_MODEL_INFO_DELAY), undefined, { signal });
    }
    const info = await super.resolveModel(provider, model, signal);
    return model === 'reasoner' ? { ...info, reasoning: {
      efforts: ['off', 'low', 'high', 'max'].map(id => ({ id, name: id })), defaultEffort: 'high',
    } } : info;
  }

  async *stream(options) {
    const prompt = options.messages.filter(message => message.source.kind === 'user').at(-1)
      ?.content.filter(block => block.type === 'text').map(block => block.text).join('') ?? '';
    if (prompt === 'which-effort' || prompt === 'slow-effort') {
      const text = `Effort used: ${options.reasoningEffort ?? 'default'}`;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      if (prompt === 'slow-effort') await delay(1000, undefined, { signal: options.signal });
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    if (prompt === 'reasoning') {
      const reasoning = 'PRIVATE_REASONING 中文😀\nNever display this block.';
      yield { type: 'block-start', index: 0, blockType: 'reasoning' };
      yield { type: 'reasoning-delta', index: 0, text: reasoning };
      await delay(750, undefined, { signal: options.signal });
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } };
      yield { type: 'block-start', index: 1, blockType: 'text' };
      yield { type: 'text-delta', index: 1, text: 'Visible answer' };
      await delay(750, undefined, { signal: options.signal });
      yield { type: 'text-delta', index: 1, text: ' complete.' };
      yield { type: 'block-end', index: 1, block: { type: 'text', text: 'Visible answer complete.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    if (prompt === 'wrapped-preview' || prompt === 'stream-with-log') {
      const text = '## STREAM_PREVIEW_TITLE\n\n**Summary** ' +
        'A streamed paragraph 中文 must remain above the editor. '.repeat(12) +
        '\n\n**Architecture** ' + 'The controller owns session state; 中文 stays in the preview. '.repeat(12) +
        '\n\nSTREAM_PREVIEW_END';
      const characters = Array.from(text);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      for (let i = 0; i < characters.length; i += 12) {
        yield { type: 'text-delta', index: 0, text: characters.slice(i, i + 12).join('') };
        await delay(8, undefined, { signal: options.signal });
      }
      if (prompt === 'stream-with-log') process.stdout.write('LIVE_LOG_NOTICE\n');
      await delay(700, undefined, { signal: options.signal });
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    if (prompt === 'long-reply') {
      const parts = ['# LONG_TITLE', ...Array.from({ length: 48 }, (_, i) =>
        `LONG_${String(i).padStart(3, '0')} 中文😀 ${'A long answer must not retain the active footer. '.repeat(3)}`),
        '```ts\nconst result = 42;\n```', '| Key | Value |\n| --- | --- |\n| final | table |', 'LONG_END'];
      const text = parts.join('\n\n');
      yield { type: 'block-start', index: 0, blockType: 'text' };
      for (let i = 0; i < parts.length; i++) {
        yield { type: 'text-delta', index: 0, text: `${i ? '\n\n' : ''}${parts[i]}` };
        await delay(8, undefined, { signal: options.signal });
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    if (['tools', 'approve', 'questions'].includes(prompt) && !options.messages.slice(options.messages.findLastIndex(message => message.source.kind === 'user') + 1).some(message => message.source.kind === 'tool')) {
      const block = { type: 'tool-call', id: 'fixture-call', name: prompt === 'questions' ? 'ask_user_question' : 'fixture_tool',
        arguments: JSON.stringify(prompt === 'questions' ? { questions: [
          { id: 'mode', question: 'Choose mode', options: [{ label: 'A' }, { label: 'B' }] },
          { id: 'name', question: 'Your name' },
        ] } : { approval: prompt === 'approve' }) };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    const prefix = prompt === 'tool-catalog' ? 'Tools: ' : prompt === 'history-count' ? 'User messages: ' : prompt === 'markdown' ? '' : prompt === 'which-model' ? 'Model used: ' : prompt === 'approve' ? 'Decision: ' : prompt === 'questions' ? 'Answer: ' : 'Reply: ';
    const value = prompt === 'tool-catalog' ? (options.tools ?? []).map(tool => tool.name).sort().join(', ') : ['approve', 'questions'].includes(prompt) ? options.messages.filter(message => message.source.kind === 'tool').at(-1).content[0].content[0].text : prompt === 'history-count' ? String(options.messages.filter(message => message.source.kind === 'user').length) : prompt === 'which-model' ? options.model : prompt === 'markdown' ? '## Summary\n\nA **bold** word and `inline`.\n\n- first item\n- second item\n\n7. seventh\n8. eighth\n\n> quoted text\n\n```js\nconst answer = 42;\n```' : prompt;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    for (const text of [prefix, value]) {
      await delay(prompt === 'slow' && text === prompt ? 30000 : 100, undefined, { signal: options.signal });
      if (prompt === 'log' && text === value) {
        await delay(250, undefined, { signal: options.signal });
        process.stdout.write('\x1b[3JExternal warning\n');
      }
      yield { type: 'text-delta', index: 0, text };
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: `${prefix}${value}` } };
    if (prompt === 'usage') yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 42, cacheReadTokens: 2000 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export function apply(ctx) {
  process.stdout.write(`TEST_PID=${process.pid}\n`);
  ctx.llm.registerAdapter(['test'], new Model());
  ctx.commands.register({ name: 'fixture', description: 'Test command', async handler({ agent, rawInput, signal }) {
    const client = rawInput.trim() === 'client-extension';
    if (client || rawInput.trim() === 'extension') {
      const runner = ctx.get('dynamicCordisRunner');
      const { pluginId, packageId } = runner.define({
        sessionId: agent.session.id, plugin: { kind: 'new', idPrefix: 'test' },
        name: client ? 'Client fixture' : 'Fixture extension', purpose: 'Verify a real dynamic extension',
        code: client ? { client: 'return { apply() {} };' } : { host: `return { inject: ['commands'], apply(ctx) {
          ctx.commands.register({ name: 'extension-fixture', description: 'Dynamic extension command',
            handler() { return { kind: 'success', text: 'Extension command ready' }; } });
        } };` },
      });
      const result = await runner.run(agent, pluginId, packageId, 'run', signal);
      return { kind: result.ok ? 'success' : 'error', text: result.ok ? `Fixture extension ${result.status}` : result.message };
    }
    if (rawInput.trim() === 'wait') await delay(30000, undefined, { signal });
    return { kind: 'success', text: 'Command ready' };
  } });
  ctx.tools.register({
    name: 'fixture_tool', description: 'Return a deterministic test value',
    parameters: { type: 'object', properties: { approval: { type: 'boolean' } }, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      await delay(350, undefined, { signal: exec.signal });
      if (args.approval) return ctx.approval.request({ agent: exec.agent, toolName: 'fixture_tool', reason: 'Test permission', signal: exec.signal });
      return 'fixture content';
    },
    presentCall: () => ({ card: 'generic', title: 'Read fixture' }),
  });
}
