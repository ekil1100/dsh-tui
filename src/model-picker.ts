import { randomUUID } from 'node:crypto';
import { oneLine } from './display-text.js';

export interface ModelItem { value: string; label: string }
export interface ModelChoice { value: string; save: boolean }
export interface PickerEvent { type: 'pick'; id: string; value: string | null; save: boolean }

/** One abortable model choice, paired by identity so stale input cannot select a new dialog. */
export class ModelPicker {
  current: { id: string; items: ModelItem[] } | null = null;
  private settle?: (choice: ModelChoice | null, error?: unknown) => void;

  constructor(private changed: () => void) {}

  open(items: ModelItem[], signal: AbortSignal): Promise<ModelChoice | null> {
    signal.throwIfAborted();
    if (this.current) throw new Error('A model picker is already open');
    return new Promise((resolve, reject) => {
      const abort = () => this.settle?.(null, signal.reason);
      this.settle = (choice, error) => {
        signal.removeEventListener('abort', abort);
        this.current = null;
        this.settle = undefined;
        this.changed();
        if (error) reject(error); else resolve(choice);
      };
      this.current = { id: randomUUID(), items: items.map(item => ({ ...item, label: oneLine(item.label) })) };
      signal.addEventListener('abort', abort, { once: true });
      this.changed();
    });
  }

  answer(event: PickerEvent): void {
    if (event.id !== this.current?.id) return;
    if (event.value !== null && !this.current.items.some(item => item.value === event.value)) return;
    this.settle?.(event.value === null ? null : { value: event.value, save: event.save });
  }

  close(): void { this.settle?.(null); }
}
