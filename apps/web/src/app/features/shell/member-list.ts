import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { PresenceStore } from '../presence/presence.store';
import { MediaSessionService } from '../../core/media/media-session.service';
import { VoicePresenceStore } from '../voice/voice-presence.store';
import { Avatar } from '../../shared/ui/avatar';
import { Member } from '../../core/api/models';

interface Group {
  label: string;
  members: (Member & { status: ReturnType<PresenceStore['status']>; live: boolean })[];
}

/** MemberList (hx-member-list): 248px aside grouped Admins / Online / Offline. */
@Component({
  selector: 'hx-member-list',
  imports: [Avatar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'complementary',
    'aria-label': 'Members',
    style: 'width: 248px; flex: none; display: flex; flex-direction: column; background: var(--bg1); border-left: 1px solid var(--line); margin-top: 8px; border-top: 1px solid var(--line)',
  },
  template: `
    <div class="scroll" style="flex: 1; padding: 8px">
      @for (g of groups(); track g.label) {
        @if (g.members.length) {
          <h3 class="grp" style="margin: 0" [id]="'mg-' + g.label">{{ g.label }} — {{ g.members.length }}</h3>
          <div role="list" [attr.aria-labelledby]="'mg-' + g.label">
            @for (m of g.members; track m.userId) {
              <div role="listitem" class="vp" style="padding-left: 8px; height: 42px" [style.opacity]="m.status === 'offline' ? 0.5 : 1">
                <hx-avatar [name]="m.displayName" [hue]="m.avatarHue" [assetId]="m.avatarAssetId" [size]="32" [status]="m.status" [speaking]="media.speaking().has(m.userId)" />
                <span style="flex: 1; min-width: 0">
                  <span style="display: block; font-weight: 600; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis" dir="auto">{{ m.displayName }}</span>
                  <span style="display: block; font-size: 11.5px; color: var(--tx3)">&#64;{{ m.login }}</span>
                </span>
                @if (m.live) { <span class="tag live" style="height: 18px; font-size: 10px">LIVE</span> }
              </div>
            }
          </div>
        }
      }
    </div>
  `,
})
export class MemberList {
  private readonly store = inject(WorkspaceStore);
  private readonly presence = inject(PresenceStore);
  private readonly voice = inject(VoicePresenceStore);
  readonly media = inject(MediaSessionService);

  readonly groups = computed<Group[]>(() => {
    const server = this.store.server();
    const hoisted = new Set((server?.roles ?? []).filter((r) => r.hoist).map((r) => r.id));
    const byUser = this.voice.byUser();
    const decorated = this.store.members().map((m) => ({
      ...m,
      status: this.presence.status(m.userId),
      live: !!byUser.get(m.userId)?.screen,
    }));
    const admins = decorated.filter((m) => m.isOwner || m.roleIds.some((r) => hoisted.has(r)));
    const rest = decorated.filter((m) => !admins.includes(m));
    return [
      { label: 'Admins', members: admins },
      { label: 'Online', members: rest.filter((m) => m.status !== 'offline') },
      { label: 'Offline', members: rest.filter((m) => m.status === 'offline') },
    ];
  });
}
