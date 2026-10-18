import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';

export function avatarColor(hue: number): string {
  return `hsl(${hue} 75% 72%)`;
}

/** Validator-normalized avatar (immutable per asset id, so the browser can cache it). */
export function avatarUrl(assetId: string | null | undefined): string | null {
  return assetId ? `/api/v1/avatars/${assetId}` : null;
}

export function initials(name: string): string {
  const n = (name || '?').trim();
  return n.slice(0, 1).toUpperCase() + (n.length > 1 ? n.slice(1, 2).toLowerCase() : '');
}

/** Circular avatar with optional status dot and speaking ring (class toggle, no layout change). */
@Component({
  selector: 'hx-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  template: `
    <span class="av ring s{{ size() }}" [class.talk]="speaking()" [style.background]="color()" aria-hidden="true">
      @if (src(); as u) {
        <img [src]="u" alt="" />
      } @else {
        {{ ini() }}
      }
      @if (status(); as st) {
        <span class="st" [style.background]="statusColor()" [style.border-color]="statusBorder()"></span>
      }
    </span>
  `,
})
export class Avatar {
  readonly name = input.required<string>();
  readonly hue = input(200);
  readonly assetId = input<string | null | undefined>(null);
  readonly size = input<20 | 28 | 32 | 40 | 72 | 80>(32);
  readonly status = input<PresenceStatus | null>(null);
  readonly speaking = input(false);
  /** Surface the dot sits on, for the cut-out border. */
  readonly surface = input('var(--bg1)');

  readonly color = computed(() => avatarColor(this.hue()));
  readonly src = computed(() => avatarUrl(this.assetId()));
  readonly ini = computed(() => initials(this.name()));
  readonly statusColor = computed(() => `var(--${this.status() ?? 'offline'})`);
  readonly statusBorder = computed(() => this.surface());
}
