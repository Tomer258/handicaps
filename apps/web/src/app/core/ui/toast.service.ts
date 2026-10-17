import { Injectable, signal } from '@angular/core';

export type ToastKind = 'info' | 'sound' | 'live' | 'warn' | 'danger';

export interface Toast {
  id: number;
  text: string;
  kind: ToastKind;
}

const DURATION_MS = 3600;

/** Top-centre stack, max 3, auto-dismiss 3.6 s, paused while hovered. Never steals focus. */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private seq = 0;
  private readonly timers = new Map<number, { handle: ReturnType<typeof setTimeout>; remaining: number; started: number }>();
  private readonly _toasts = signal<Toast[]>([]);
  readonly toasts = this._toasts.asReadonly();

  show(text: string, kind: ToastKind = 'info'): void {
    const id = ++this.seq;
    this._toasts.update((list) => {
      const next = [...list, { id, text, kind }];
      for (const dropped of next.slice(0, Math.max(0, next.length - 3))) this.clearTimer(dropped.id);
      return next.slice(-3);
    });
    this.schedule(id, DURATION_MS);
  }

  dismiss(id: number): void {
    this.clearTimer(id);
    this._toasts.update((list) => list.filter((t) => t.id !== id));
  }

  pause(id: number): void {
    const t = this.timers.get(id);
    if (!t) return;
    clearTimeout(t.handle);
    t.remaining -= Date.now() - t.started;
  }

  resume(id: number): void {
    const t = this.timers.get(id);
    if (t) this.schedule(id, Math.max(800, t.remaining));
  }

  private schedule(id: number, ms: number): void {
    this.clearTimer(id);
    this.timers.set(id, { handle: setTimeout(() => this.dismiss(id), ms), remaining: ms, started: Date.now() });
  }

  private clearTimer(id: number): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t.handle);
    this.timers.delete(id);
  }
}
