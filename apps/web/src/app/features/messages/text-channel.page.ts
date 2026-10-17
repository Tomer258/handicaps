import { ChangeDetectionStrategy, Component, OnDestroy, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { ApiError } from '../../core/api/api-error';
import { RealtimeService } from '../../core/realtime/realtime.service';
import { Icon } from '../../shared/ui/icon';
import { LayoutService } from '../shell/layout.service';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { ChannelUi } from './channel-ui';
import { ChatStore } from './chat.store';
import { Composer } from './composer';
import { MessageList } from './message-list';
import { PinsPanel } from './pins-panel';

/** Text channel view: header · history · typing line · composer, plus pins and delete confirmation. */
@Component({
  selector: 'hx-text-channel-page',
  imports: [Icon, MessageList, Composer, PinsPanel],
  providers: [ChannelUi],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (channel(); as ch) {
      <header style="height: 52px; flex: none; display: flex; align-items: center; gap: 12px; padding: 0 12px 0 16px; border-bottom: 1px solid var(--line)">
        <button class="ibtn only-m" aria-label="Open channels" (click)="layout.navOpen.set(true)"><hx-icon name="menu" /></button>
        <div style="display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1">
          <hx-icon name="hash" style="color: var(--tx3)" />
          <h1 class="disp" style="margin: 0; font-size: 16px; font-weight: 600; white-space: nowrap">{{ ch.name }}</h1>
          @if (ch.topic) {
            <span class="hide-m" style="width: 1px; height: 20px; background: var(--line2)"></span>
            <span class="hide-m" style="font-size: 13px; color: var(--tx3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis">{{ ch.topic }}</span>
          }
        </div>
        @if (realtimeDown()) {
          <span role="status" title="Live updates paused while reconnecting" style="font-size: 12px; color: var(--warn)">Reconnecting…</span>
        }
        <button class="ibtn" [class.on]="ui.pinsOpen()" aria-label="Pinned messages" [attr.aria-pressed]="ui.pinsOpen()" title="Pinned messages"
                (click)="ui.pinsOpen.set(!ui.pinsOpen())"><hx-icon name="pin" /></button>
        <button class="ibtn hide-m" [class.on]="layout.membersOpen()" aria-label="Toggle member list" [attr.aria-pressed]="layout.membersOpen()"
                title="Member list" (click)="layout.membersOpen.set(!layout.membersOpen())"><hx-icon name="users" /></button>
      </header>

      <div style="flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative">
        @if (loadError(); as err) {
          <div style="flex: 1; display: grid; place-items: center; padding: 24px">
            <div style="display: flex; flex-direction: column; gap: 12px; align-items: center; text-align: center">
              <div class="note e" role="alert">{{ err }}</div>
              <button class="btn" (click)="load()">Try again</button>
            </div>
          </div>
        } @else {
          <hx-message-list [channel]="ch" />
        }

        <div aria-live="polite" style="height: 22px; padding: 0 22px; font-size: 12px; color: var(--tx3); display: flex; align-items: center; gap: 6px">
          @if (typing(); as t) {
            <span class="typing" aria-hidden="true"><i></i><i></i><i></i></span>
            <span>
              @if (t.length === 1) {
                <b style="color: var(--tx2); font-weight: 600">{{ t[0] }}</b> is typing…
              } @else if (t.length === 2) {
                <b style="color: var(--tx2); font-weight: 600">{{ t[0] }}</b> and <b style="color: var(--tx2); font-weight: 600">{{ t[1] }}</b> are typing…
              } @else {
                Several people are typing…
              }
            </span>
          }
        </div>

        <hx-composer [channel]="ch" />

        @if (ui.pinsOpen()) {
          <hx-pins-panel [channel]="ch" />
        }
      </div>

      @if (ui.deleting()) {
        <div class="scrim" role="alertdialog" aria-modal="true" aria-labelledby="del-title" (click)="ui.deleting.set(null)" (keydown.escape)="ui.deleting.set(null)">
          <div class="pop fade" (click)="$event.stopPropagation()" style="width: 420px; max-width: calc(100% - 32px); padding: 22px; display: flex; flex-direction: column; gap: 12px">
            <h2 id="del-title" class="disp" style="margin: 0; font-size: 20px">Delete message?</h2>
            <p style="margin: 0; color: var(--tx2)">This removes the message for everyone. Replies will show that the original was deleted.</p>
            <div style="display: flex; justify-content: flex-end; gap: 8px">
              <button class="btn ghost" (click)="ui.deleting.set(null)">Cancel</button>
              <button class="btn dng" (click)="confirmDelete()" autofocus>Delete</button>
            </div>
          </div>
        </div>
      }
    }
  `,
  host: { style: 'flex: 1; min-height: 0; display: flex; flex-direction: column' },
})
export class TextChannelPage implements OnDestroy {
  readonly channelId = input.required<string>();

  readonly ui = inject(ChannelUi);
  readonly layout = inject(LayoutService);
  private readonly store = inject(WorkspaceStore);
  private readonly chat = inject(ChatStore);
  private readonly realtime = inject(RealtimeService);

  readonly channel = computed(() => this.store.channel(this.channelId()));
  readonly loadError = signal<string | null>(null);
  readonly realtimeDown = computed(() => this.realtime.state() === 'reconnecting' || this.realtime.state() === 'disconnected');

  readonly typing = computed(() => {
    const ids = this.chat.typingIn(this.channelId());
    if (!ids.length) return null;
    const byId = this.store.memberById();
    return ids.map((id) => byId.get(id)?.displayName ?? 'Someone');
  });

  constructor() {
    effect(() => {
      const id = this.channelId();
      untracked(() => {
        this.ui.reset(id);
        this.chat.activeChannelId.set(id);
        void this.load();
      });
    });
  }

  ngOnDestroy(): void {
    if (this.chat.activeChannelId() === this.channelId()) this.chat.activeChannelId.set(null);
  }

  async load(): Promise<void> {
    const id = this.channelId();
    this.loadError.set(null);
    try {
      await this.chat.open(id);
    } catch (e) {
      if (id === this.channelId()) this.loadError.set(ApiError.from(e).message);
    }
  }

  async confirmDelete(): Promise<void> {
    const m = this.ui.deleting();
    this.ui.deleting.set(null);
    if (m) await this.chat.remove(m);
  }
}
