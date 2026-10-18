import { Injectable, signal } from '@angular/core';

export interface ProfileRequest {
  userId: string;
  /** Where it opened from: positions the popover and gets focus back on close. */
  trigger: HTMLElement | null;
  rect: { left: number; right: number; top: number };
}

/** Opens the one UserProfilePopover (hx-profile-popover) from avatars, names and member rows. */
@Injectable({ providedIn: 'root' })
export class ProfileService {
  readonly open = signal<ProfileRequest | null>(null);

  show(userId: string, e?: Event): void {
    e?.stopPropagation();
    const trigger = (e?.currentTarget as HTMLElement | null) ?? null;
    const r = trigger?.getBoundingClientRect();
    this.open.set({ userId, trigger, rect: r ? { left: r.left, right: r.right, top: r.top } : { left: innerWidth / 2, right: innerWidth / 2, top: 80 } });
  }

  close(): void {
    const req = this.open();
    this.open.set(null);
    req?.trigger?.focus();
  }
}
