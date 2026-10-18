import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ToastKind, ToastService } from '../../core/ui/toast.service';

const DOT: Record<ToastKind, string> = {
  info: 'var(--accent)',
  sound: 'var(--sb)',
  live: 'var(--live)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
};

@Component({
  selector: 'hx-toast-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div aria-live="polite" role="status"
         style="position: absolute; left: 50%; top: 66px; transform: translateX(-50%); display: flex; flex-direction: column; gap: 8px; align-items: center; z-index: 60; pointer-events: none">
      @for (t of toasts.toasts(); track t.id) {
        <div class="toast" style="pointer-events: auto" (mouseenter)="toasts.pause(t.id)" (mouseleave)="toasts.resume(t.id)">
          <span class="dotc" [style.background]="dot[t.kind]"></span>
          <span style="flex: 1">{{ t.text }}</span>
          @if (t.action; as a) {
            <button class="btn pri" style="height: 28px; padding: 0 12px; margin-left: 6px" (click)="toasts.act(t)">{{ a.label }}</button>
          }
        </div>
      }
    </div>
  `,
})
export class ToastHost {
  readonly toasts = inject(ToastService);
  readonly dot = DOT;
}
