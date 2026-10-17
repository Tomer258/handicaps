import { Injectable, inject, signal } from '@angular/core';
import { Message } from '../../core/api/models';
import { ToastService } from '../../core/ui/toast.service';
import { ChatStore } from './chat.store';

/** Per-channel-view UI state shared by the list, messages and composer (provided by TextChannelPage). */
@Injectable()
export class ChannelUi {
  private readonly chat = inject(ChatStore);
  private readonly toast = inject(ToastService);

  readonly channelId = signal('');
  readonly replyTo = signal<Message | null>(null);
  readonly editingId = signal<string | null>(null);
  readonly reactFor = signal<string | null>(null);
  readonly deleting = signal<Message | null>(null);
  readonly highlightId = signal<string | null>(null);
  readonly pinsOpen = signal(false);
  readonly emojiOpen = signal(false);

  private highlightTimer?: ReturnType<typeof setTimeout>;

  reset(channelId: string): void {
    this.channelId.set(channelId);
    this.replyTo.set(null);
    this.editingId.set(null);
    this.reactFor.set(null);
    this.deleting.set(null);
    this.highlightId.set(null);
    this.pinsOpen.set(false);
    this.emojiOpen.set(false);
  }

  focusComposer(): void {
    queueMicrotask(() => document.getElementById('composer')?.focus());
  }

  startReply(m: Message): void {
    this.editingId.set(null);
    this.replyTo.set(m);
    this.focusComposer();
  }

  /** Scrolls to a message, paging older history in if needed, and flashes it. */
  async jumpTo(messageId: string): Promise<void> {
    const id = this.channelId();
    for (let i = 0; i < 6; i++) {
      const el = document.getElementById(`msg-${messageId}`);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        this.highlightId.set(messageId);
        clearTimeout(this.highlightTimer);
        this.highlightTimer = setTimeout(() => this.highlightId.set(null), 1600);
        return;
      }
      const c = this.chat.chat(id);
      if (!c.hasMore) break;
      await this.chat.loadOlder(id);
      await new Promise((r) => requestAnimationFrame(r));
    }
    this.toast.show('That message is no longer available.');
  }
}
