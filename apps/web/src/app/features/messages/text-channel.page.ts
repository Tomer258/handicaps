import { ChangeDetectionStrategy, Component, OnDestroy, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { ApiError } from '../../core/api/api-error';
import { Channel } from '../../core/api/models';
import { RealtimeService } from '../../core/realtime/realtime.service';
import { Icon } from '../../shared/ui/icon';
import { LayoutService } from '../shell/layout.service';
import { VoicePill } from '../shell/voice-pill';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { AttachmentUploads } from './attachment-uploads';
import { ChannelUi } from './channel-ui';
import { ChatStore } from './chat.store';
import { Composer } from './composer';
import { MessageList } from './message-list';
import { PinsPanel } from './pins-panel';

/** Text channel view: header · history · typing line · composer, plus pins and delete confirmation. */
@Component({
  selector: 'hx-text-channel-page',
  imports: [Icon, MessageList, Composer, PinsPanel, VoicePill],
  providers: [ChannelUi, AttachmentUploads],
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
        <button class="ibtn" [class.on]="layout.membersOpen()" aria-label="Toggle member list" [attr.aria-pressed]="layout.membersOpen()"
                title="Member list" (click)="layout.membersOpen.set(!layout.membersOpen())"><hx-icon name="users" /></button>
      </header>

      <div style="flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative"
           (dragenter)="onDragOver($event)" (dragover)="onDragOver($event)" (dragleave)="onDragLeave($event)" (drop)="onDrop($event, ch)">
        @if (dragOver()) {
          <div data-testid="drop-zone" style="position: absolute; inset: 12px; border-radius: 18px; border: 2px dashed var(--accent); background: color-mix(in oklab,var(--bg2) 82%,var(--accent)); display: grid; place-items: center; z-index: 20; pointer-events: none">
            <div style="text-align: center">
              <hx-icon name="upload" style="width: 40px; height: 40px; color: var(--accent-tx)" />
              <div class="disp" style="font-size: 22px; font-weight: 700; margin-top: 8px">Drop to share in #{{ ch.name }}</div>
              <div style="color: var(--tx2); font-size: 13px">Images up to 10 MB · text files up to 1 MB</div>
            </div>
          </div>
        }
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

        @if (layout.mobile()) {
          <hx-voice-pill />
        }
        <hx-composer [channel]="ch" />

        @if (ui.pinsOpen()) {
          <hx-pins-panel [channel]="ch" />
        }
      </div>

      @if (ui.viewer(); as v) {
        <div class="scrim" role="dialog" aria-modal="true" [attr.aria-label]="'Image ' + v.attachment.name" style="background: rgba(0,0,0,.86)"
             (click)="ui.viewer.set(null)" (keydown.escape)="ui.viewer.set(null)" tabindex="-1">
          <div class="fade" style="max-width: min(1200px, 92%); display: flex; flex-direction: column; gap: 12px" (click)="$event.stopPropagation()">
            <img [src]="'/api/v1/attachments/' + v.attachment.id" [alt]="v.attachment.name" data-testid="viewer-image"
                 style="max-width: 100%; max-height: calc(100vh - 140px); object-fit: contain; border-radius: 12px; align-self: center; background: var(--bg1)" />
            <div style="display: flex; align-items: center; gap: 10px; color: #fff; min-width: 0">
              <b style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis">{{ v.attachment.name }}</b>
              <span style="opacity: .6; font-size: 12.5px; white-space: nowrap">shared by {{ v.by }}</span>
              <span style="flex: 1"></span>
              <a class="btn sec" [href]="'/api/v1/attachments/' + v.attachment.id + '?download=true'" download>Download</a>
              <button class="btn sec" (click)="ui.viewer.set(null)" autofocus>Close</button>
            </div>
          </div>
        </div>
      }

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
  readonly dragOver = signal(false);
  private readonly uploads = inject(AttachmentUploads);
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

  onDragOver(e: DragEvent): void {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    const ch = this.channel();
    const ok = !!ch && this.uploads.canAttach(ch);
    e.dataTransfer.dropEffect = ok ? 'copy' : 'none';
    if (ok && !this.dragOver()) this.dragOver.set(true);
  }

  onDragLeave(e: DragEvent): void {
    if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) return;
    this.dragOver.set(false);
  }

  onDrop(e: DragEvent, ch: Channel): void {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    this.dragOver.set(false);
    this.uploads.add(ch, Array.from(e.dataTransfer.files));
    this.ui.focusComposer();
  }

  async confirmDelete(): Promise<void> {
    const m = this.ui.deleting();
    this.ui.deleting.set(null);
    if (m) await this.chat.remove(m);
  }
}
