import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Channel } from '../../core/api/models';
import { avatarColor } from '../../shared/ui/avatar';
import { Icon } from '../../shared/ui/icon';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { ChannelUi } from './channel-ui';
import { ChatStore } from './chat.store';
import { formatFull, previewText } from './message-text';

/** Pinned messages popover (prototype "pins" panel). Kept fresh by message.pinned events. */
@Component({
  selector: 'hx-pins-panel',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pop fade" role="dialog" aria-labelledby="pins-title"
         style="position: absolute; right: 12px; top: 8px; width: 360px; max-width: calc(100% - 24px); max-height: 70%; display: flex; flex-direction: column; z-index: 15">
      <div style="display: flex; align-items: center; padding: 12px 14px; border-bottom: 1px solid var(--line)">
        <b id="pins-title" class="disp" style="flex: 1; font-size: 15px">Pinned in {{ channel().type === 'text' ? '#' : '' }}{{ channel().name }}</b>
        <button class="ibtn" aria-label="Close pins" (click)="ui.pinsOpen.set(false)"><hx-icon name="x" size="sm" /></button>
      </div>
      <div class="scroll" style="padding: 8px">
        @if (failed()) {
          <div class="note e" role="alert">Could not load pinned messages.</div>
        } @else if (items(); as list) {
          @for (p of list; track p.id) {
            <button (click)="jump(p.id)" style="display: block; width: 100%; text-align: left; padding: 10px; border-radius: 10px; background: var(--bg3); margin-bottom: 6px">
              <div style="display: flex; gap: 8px; align-items: baseline">
                <b [style.color]="p.color" style="font-size: 13px">{{ p.name }}</b>
                <span class="mono" style="font-size: 11px; color: var(--tx3)">{{ p.time }}</span>
                <span style="flex: 1"></span>
                <span style="font-size: 11.5px; color: var(--accent-tx)">Jump</span>
              </div>
              <div style="font-size: 13px; color: var(--tx2); margin-top: 2px; overflow-wrap: anywhere">{{ p.text }}</div>
            </button>
          } @empty {
            <div style="padding: 24px; text-align: center; color: var(--tx3); font-size: 13px">Nothing pinned yet. Hover a message and use the pin action.</div>
          }
        } @else {
          <div style="display: grid; place-items: center; padding: 24px"><span class="spin" aria-label="Loading pins"></span></div>
        }
      </div>
    </div>
  `,
})
export class PinsPanel {
  readonly channel = input.required<Channel>();
  readonly ui = inject(ChannelUi);
  private readonly chat = inject(ChatStore);
  private readonly workspace = inject(WorkspaceStore);
  readonly failed = signal(false);

  readonly items = computed(() => {
    const pins = this.chat.pins(this.channel().id);
    if (!pins) return undefined;
    const byId = this.workspace.memberById();
    return pins.map((m) => {
      const a = byId.get(m.authorUserId);
      return { id: m.id, name: a?.displayName ?? 'Former member', color: avatarColor(a?.avatarHue ?? 210), time: formatFull(m.createdAt), text: previewText(m.body, byId) };
    });
  });

  constructor() {
    effect(() => {
      const id = this.channel().id;
      untracked(() => {
        this.failed.set(false);
        this.chat.loadPins(id).catch(() => this.failed.set(true));
      });
    });
  }

  jump(id: string): void {
    this.ui.pinsOpen.set(false);
    void this.ui.jumpTo(id);
  }
}
