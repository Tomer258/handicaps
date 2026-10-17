import { Injectable, signal } from '@angular/core';

/**
 * Unread and mention counts per channel for the sidebar. Fed by the messages feature
 * (read positions + channel last sequence + notifications). Only readable channels ever appear.
 */
@Injectable({ providedIn: 'root' })
export class ChannelBadges {
  private readonly _unread = signal<Record<string, number>>({});
  private readonly _mentions = signal<Record<string, number>>({});

  readonly unreadMap = this._unread.asReadonly();
  readonly mentionMap = this._mentions.asReadonly();

  unread(channelId: string): number {
    return this._unread()[channelId] ?? 0;
  }

  mentions(channelId: string): number {
    return this._mentions()[channelId] ?? 0;
  }

  setUnread(channelId: string, n: number): void {
    this._unread.update((m) => ({ ...m, [channelId]: Math.max(0, n) }));
  }

  setMentions(channelId: string, n: number): void {
    this._mentions.update((m) => ({ ...m, [channelId]: Math.max(0, n) }));
  }

  replace(unread: Record<string, number>, mentions: Record<string, number>): void {
    this._unread.set(unread);
    this._mentions.set(mentions);
  }

  clear(channelId: string): void {
    this.setUnread(channelId, 0);
    this.setMentions(channelId, 0);
  }
}
