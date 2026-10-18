import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { ChannelSidebar } from './channel-sidebar';
import { MemberList } from './member-list';
import { LayoutService } from './layout.service';

/**
 * One server: channel sidebar · routed main (text/voice/stream) · member aside.
 * Grid per Handoff: 252px sidebar · 1fr main · 248px aside; drawer below 820px.
 */
@Component({
  selector: 'hx-server-view',
  imports: [RouterOutlet, ChannelSidebar, MemberList],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.server(); as server) {
      <hx-channel-sidebar [class.open]="layout.navOpen()" [class.th-hide]="layout.theater()" />
      @if (layout.navOpen()) {
        <div class="only-m" style="position: absolute; inset: 0; z-index: 25; background: rgba(4,5,7,.5)" (click)="layout.navOpen.set(false)"></div>
      }
      <main id="main" style="flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--bg2); margin-top: 8px; border-top: 1px solid var(--line); position: relative">
        <router-outlet />
      </main>
      @if (layout.membersOpen() && !layout.theater()) {
        @if (layout.membersOverlay()) {
          <div style="position: absolute; inset: 0; z-index: 27" (click)="layout.membersOpen.set(false)" aria-hidden="true"></div>
        }
        <hx-member-list class="members" [class.overlay]="layout.membersOverlay()" />
      }
    } @else {
      <div style="flex: 1; display: grid; place-items: center; color: var(--tx3)">
        @if (failed()) {
          <div class="note e" role="alert">This server is unavailable.</div>
        } @else {
          <span class="spin" aria-label="Loading server"></span>
        }
      </div>
    }
  `,
  host: { style: 'flex: 1; min-width: 0; display: flex; position: relative' },
})
export class ServerView {
  readonly serverId = input.required<string>();
  readonly store = inject(WorkspaceStore);
  readonly layout = inject(LayoutService);
  private readonly router = inject(Router);
  readonly failed = signal(false);

  constructor() {
    effect(() => {
      const id = this.serverId();
      untracked(async () => {
        this.failed.set(false);
        try {
          await this.store.select(id);
          // /s/:id without a channel → first text channel.
          if (this.router.url.replace(/\/$/, '').endsWith(id)) {
            const first = this.store.textChannels()[0];
            if (first) await this.router.navigate(['/s', id, 'c', first.id], { replaceUrl: true });
          }
        } catch {
          this.failed.set(true);
        }
      });
    });
  }
}
