import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval';
import type { AskUserQuestionRequest, AskUserQuestionAnswer, AskUserQuestionAnswerItem } from '@deepseek-ai/dsh-user-questions';

export type Questions = Pick<AskUserQuestionRequest, 'questions' | 'signal'>;

export type Approval = Pick<ApprovalRequest, 'toolName' | 'reason' | 'signal'>;
export interface Prompt { id: string; body: string; hint: string }
interface Entry {
  view(): Prompt;
  submit(text: string): boolean;
  cancel(): void;
  detach(): void;
}

/** One FIFO owns the input position; cancelled and stale answers cannot cross requests. */
export class InteractionQueue {
  private entries: Entry[] = [];
  private serial = 0;
  private closed = false;
  constructor(private changed: () => void) {}

  current(): Prompt | null { return this.entries[0]?.view() ?? null; }

  approval(request: Approval): Promise<ApprovalOutcome> {
    const id = `interaction-${++this.serial}`;
    return new Promise(resolve => {
      let hint = 'y allow once · n reject · Enter defaults to n';
      this.add({
        view: () => ({ id, body: `? Allow ${request.toolName} once?${request.reason ? `\nReason: ${request.reason}` : ''}`, hint }),
        submit: text => {
          const value = text.trim().toLowerCase();
          if (!['', 'y', 'n'].includes(value)) { hint = 'Enter y or n (default n).'; return false; }
          resolve(value === 'y' ? 'allowed-once' : 'rejected');
          return true;
        },
        cancel: () => resolve('cancelled'),
        detach: () => {},
      }, request.signal);
    });
  }

  questions(request: Questions): Promise<AskUserQuestionAnswer> {
    const id = `interaction-${++this.serial}`;
    if (!request.questions.length) return Promise.resolve({ answers: [] });
    return new Promise((resolve, reject) => {
      let index = 0;
      let error = '';
      const answers: AskUserQuestionAnswerItem[] = [];
      this.add({
        view: () => {
          const question = request.questions[index];
          const options = question.options ?? [];
          return {
            id: `${id}-${index}`,
            body: [question.header, `? ${question.question}`, question.detail,
              ...options.map((option, i) => `${i + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`),
            ].filter(Boolean).join('\n'),
            hint: error || `${question.multiSelect ? 'Numbers separated by commas' : options.length ? 'Number or custom text' : 'Your answer'} · Enter skips`,
          };
        },
        submit: text => {
          const question = request.questions[index];
          const options = question.options ?? [];
          const value = text.trim();
          const answer: AskUserQuestionAnswerItem = { id: question.id, selected: [] };
          if (value && question.multiSelect && options.length) {
            const numbers = value.split(',').map(part => part.trim());
            if (numbers.some(part => !/^\d+$/.test(part) || Number(part) < 1 || Number(part) > options.length)) {
              error = 'Choose valid option numbers separated by commas.';
              return false;
            }
            answer.selected = [...new Set(numbers.map(part => options[Number(part) - 1].label))];
          } else if (value) {
            const choice = /^\d+$/.test(value) ? options[Number(value) - 1] : undefined;
            if (choice) answer.selected = [choice.label];
            else answer.custom = value;
          }
          answers.push(answer);
          error = '';
          if (++index < request.questions.length) return false;
          resolve({ answers });
          return true;
        },
        cancel: () => reject(new DOMException('Question cancelled', 'AbortError')),
        detach: () => {},
      }, request.signal);
    });
  }

  answer(id: string, text: string): void {
    const entry = this.entries[0];
    if (!entry || entry.view().id !== id) return;
    if (entry.submit(text)) { this.entries.shift(); entry.detach(); }
    this.changed();
  }

  close(): void {
    this.closed = true;
    for (const entry of this.entries.splice(0)) { entry.detach(); entry.cancel(); }
    this.changed();
  }

  private add(entry: Entry, signal?: AbortSignal): void {
    if (this.closed || signal?.aborted) { entry.cancel(); return; }
    const abort = () => {
      const index = this.entries.indexOf(entry);
      if (index === -1) return;
      this.entries.splice(index, 1);
      entry.detach();
      entry.cancel();
      this.changed();
    };
    signal?.addEventListener('abort', abort, { once: true });
    entry.detach = () => signal?.removeEventListener('abort', abort);
    this.entries.push(entry);
    this.changed();
  }
}
