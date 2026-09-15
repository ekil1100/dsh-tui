import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

export const inject = ['llm', 'tools', 'commands', 'approval'];

class Model extends LlmAdapter {
  async listModels(provider) { return [{ provider, id: 'test', name: 'Test model' }, { provider, id: 'flash', name: 'Flash test model' }]; }

  async *stream(options) {
    const prompt = options.messages.filter(message => message.source.kind === 'user').at(-1)
      ?.content.filter(block => block.type === 'text').map(block => block.text).join('') ?? '';
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
    const prefix = prompt === 'history-count' ? 'User messages: ' : prompt === 'markdown' ? '' : prompt === 'which-model' ? 'Model used: ' : prompt === 'approve' ? 'Decision: ' : prompt === 'questions' ? 'Answer: ' : 'Reply: ';
    const value = ['approve', 'questions'].includes(prompt) ? options.messages.filter(message => message.source.kind === 'tool').at(-1).content[0].content[0].text : prompt === 'history-count' ? String(options.messages.filter(message => message.source.kind === 'user').length) : prompt === 'which-model' ? options.model : prompt === 'markdown' ? '## Summary\n\nA **bold** word and `inline`.\n\n- first item\n- second item\n\n7. seventh\n8. eighth\n\n> quoted text\n\n```js\nconst answer = 42;\n```' : prompt;
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
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export function apply(ctx) {
  process.stdout.write(`TEST_PID=${process.pid}\n`);
  ctx.llm.registerAdapter(['test'], new Model());
  ctx.commands.register({ name: 'fixture', description: 'Test command', async handler({ rawInput, signal }) {
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
