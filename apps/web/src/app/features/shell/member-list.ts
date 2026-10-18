import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { SessionService } from '../../core/auth/session.service';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { PresenceStore } from '../presence/presence.store';
import { MediaSessionService } from '../../core/media/media-session.service';
import { VoicePresenceStore } from '../voice/voice-presence.store';
import { Avatar } from '../../shared/ui/avatar';
import { Member, Perm } from '../../core/api/models';

interface Group {
  label: string;
  color?: string;
  members: (Member & { status: ReturnType<PresenceStore['status']>; live: boolean })[];
}

/** MemberList (hx-member-list): 248px aside grouped by hoisted role (highest first), then Online / Offline. */
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
      @if (quiet(); as q) {
        <div class="fade" role="status" style="margin: 6px 4px 10px; padding: 16px 12px; border-radius: 14px; border: 1px dashed var(--line2); display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center">
          <div style="display: flex">
            @for (m of q.faces; track m.userId; let i = $index) {
              <span style="opacity: .4; border-radius: 50%; border: 2px solid var(--bg1)" [style.margin-left.px]="i ? -10 : 0">
                <hx-avatar [name]="m.displayName" [hue]="m.avatarHue" [assetId]="m.avatarAssetId" [size]="32" />
              </span>
            }
          </div>
          <b style="font-size: 14px">Quiet hangar tonight</b>
          <span style="font-size: 12.5px; color: var(--tx3)">
            Nobody's online.@if (q.last) { {{ q.last.name }} was last here {{ q.last.ago }}.}
            @if (q.waiting) { You're in {{ q.channel?.name }} — friends see you there when they arrive. }
            @else if (q.channel) { Hop in {{ q.channel.name }} — friends see you there when they arrive. }
          </span>
          @if (q.channel && !q.waiting) {
            <button class="btn sec" style="margin-top: 4px" (click)="wait(q.channel.id)">Wait in {{ q.channel.name }}</button>
          }
        </div>
      }
      @for (g of groups(); track $index; let gi = $index) {
        @if (g.members.length) {
          <h3 class="grp" style="margin: 0" [id]="'mg-' + gi" [style.color]="g.color">{{ g.label }} — {{ g.members.length }}</h3>
          <div role="list" [attr.aria-labelledby]="'mg-' + gi">
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
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);

  /** States 04: nobody else is online — say who was here last and offer to wait in voice. */
  readonly quiet = computed(() => {
    const me = this.session.userId();
    const others = this.store.members().filter((m) => m.userId !== me);
    if (!others.length || others.some((m) => this.presence.status(m.userId) !== 'offline')) return null;
    const live = this.presence.wentOffline();
    const seen = others
      .map((m) => ({ m, at: live[m.userId] ?? (m.lastOnlineAt ? Date.parse(m.lastOnlineAt) : 0) }))
      .sort((a, b) => b.at - a.at);
    const channel = this.store.voiceChannels().find((c) => (c.permissions & Perm.JoinVoice) !== 0) ?? null;
    return {
      faces: seen.slice(0, 3).map((x) => x.m),
      last: seen[0].at ? { name: seen[0].m.displayName, ago: ago(Date.now() - seen[0].at) } : null,
      channel,
      waiting: this.media.connected() && !!channel && this.media.channelId() === channel.id,
    };
  });

  wait(channelId: string): void {
    const serverId = this.store.serverId();
    if (serverId) void this.router.navigate(['/s', serverId, 'v', channelId]);
    void this.media.join(channelId);
  }

  readonly groups = computed<Group[]>(() => {
    const server = this.store.server();
    const hoisted = (server?.roles ?? []).filter((r) => r.hoist && !r.isDefault).sort((a, b) => b.position - a.position);
    const byUser = this.voice.byUser();
    const decorated = this.store.members().map((m) => ({
      ...m,
      status: this.presence.status(m.userId),
      live: !!byUser.get(m.userId)?.screen,
    }));
    // Each member shows once, under their highest hoisted role; an owner without one still gets a group.
    const placed = new Set<string>();
    const roleGroups: Group[] = hoisted.map((r) => {
      const members = decorated.filter((m) => !placed.has(m.userId) && m.roleIds.includes(r.id));
      members.forEach((m) => placed.add(m.userId));
      return { label: r.name, color: r.color ?? undefined, members };
    });
    const owners = decorated.filter((m) => m.isOwner && !placed.has(m.userId));
    owners.forEach((m) => placed.add(m.userId));
    const rest = decorated.filter((m) => !placed.has(m.userId));
    return [
      { label: 'Owner', members: owners },
      ...roleGroups,
      { label: 'Online', members: rest.filter((m) => m.status !== 'offline') },
      { label: 'Offline', members: rest.filter((m) => m.status === 'offline') },
    ];
  });
}

function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
