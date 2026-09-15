import { randomUUID } from 'node:crypto';
import { oneLine } from './display-text.js';

export interface PickerItem { value: string; label: string }
export interface PickerChoice { value: string; save: boolean }
export interface PickerView { title: string; hint: string; empty: string; allowSave: boolean }
export interface PickerEvent { type: 'pick'; id: string; value: string | null; save: boolean }

/** One abortable choice, paired by identity so stale input cannot select a new dialog. */
export class Picker {
  current: (PickerView & { id: string; items: PickerItem[] }) | null = null;
  private settle?: (choice: PickerChoice | null, error?: unknown) => void;

  constructor(private changed: () => void) {}

  open(items: PickerItem[], view: PickerView, signal: AbortSignal): Promise<PickerChoice | null> {
    signal.throwIfAborted();
    if (this.current) throw new Error('A picker is already open');
    return new Promise((resolve, reject) => {
      const abort = () => this.settle?.(null, signal.reason);
      this.settle = (choice, error) => {
        signal.removeEventListener('abort', abort);
        this.current = null;
        this.settle = undefined;
        this.changed();
        if (error) reject(error); else resolve(choice);
      };
      this.current = { ...view, title: oneLine(view.title), hint: oneLine(view.hint), empty: oneLine(view.empty), id: randomUUID(), items: items.map(item => ({ ...item, label: oneLine(item.label) })) };
      signal.addEventListener('abort', abort, { once: true });
      this.changed();
    });
  }

  answer(event: PickerEvent): void {
    if (event.id !== this.current?.id || (event.save && !this.current.allowSave)) return;
    if (event.value !== null && !this.current.items.some(item => item.value === event.value)) return;
    this.settle?.(event.value === null ? null : { value: event.value, save: event.save });
  }

  close(): void { this.settle?.(null); }
}
