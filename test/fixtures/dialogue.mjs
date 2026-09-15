import { setTimeout as delay } from 'node:timers/promises';
import { createAssistantMessage } from '@deepseek-ai/dsh-llm';
import { Session } from '@deepseek-ai/dsh-session';
import { TuiController } from '../../dist/controller.js';
import { createTerminal } from '../../dist/terminal.js';

const controller = new TuiController();
const session = Session.create('session-pty');
const terminal = await createTerminal('dsh · test');
const draw = () => terminal.render(controller.snapshot());
const publish = event => { controller.session(event); draw(); };
let turn = 0;
try {
  for await (const event of terminal.events()) {
    if (event.type === 'eof') break;
    if (event.type !== 'submit') continue;
    publish(session.append('turn/start', { turn }));
    const attemptId = `attempt-${turn}`;
    controller.stream({ type: 'start', attemptId, revision: 1, turn, step: 0 });
    for (const [index, text] of ['Hello', ' world'].entries()) {
      controller.stream({ type: 'chunk', attemptId, revision: index + 2, index, time: index,
        chunk: { type: 'text-delta', index: 0, text } });
      draw();
      await delay(150);
    }
    publish(session.append('assistant/message', { turn, step: 0, stream: [],
      message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'Hello world!' }] }),
    }, { surfaceOp: 'append' }));
    publish(session.append('turn/end', { turn, reason: { kind: 'completed' } }));
    turn++;
  }
} finally {
  await terminal.close();
}
