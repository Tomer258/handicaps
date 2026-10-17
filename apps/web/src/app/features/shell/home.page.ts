import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SessionService } from '../../core/auth/session.service';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { Icon } from '../../shared/ui/icon';

/** Home / welcome: pick a server. */
@Component({
  selector: 'hx-home-page',
  imports: [RouterLink, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fade" style="flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--bg0)">
      <div style="width: 560px; max-width: 100%">
        <div style="display: flex; align-items: center; gap: 12px">
          <span style="width: 44px; height: 44px; border-radius: 14px; background: var(--accent); color: var(--accent-ink); display: grid; place-items: center"><hx-icon name="home" size="lg" /></span>
          <span class="disp" style="font-size: 26px; font-weight: 700">Hangar</span>
        </div>
        <h1 class="disp" style="font-size: 44px; line-height: 1.05; margin: 34px 0 10px; font-weight: 700" dir="auto">Welcome back, {{ session.user()?.displayName }}.</h1>
        <p style="margin: 0 0 28px; color: var(--tx2); font-size: 16px">Where are we hanging out tonight?</p>
        <div style="display: flex; flex-direction: column; gap: 10px">
          @for (s of session.servers(); track s.id) {
            <a class="card" [routerLink]="['/s', s.id]" style="display: flex; align-items: center; gap: 16px; text-align: left; padding: 16px 18px; color: var(--tx); text-decoration: none">
              <span class="srv" style="background: #23262C; color: #ECEEF1; width: 52px; height: 52px"><span class="disp" style="font-size: 18px; font-weight: 700">{{ s.name.replace('The ', '').slice(0, 1) }}</span></span>
              <span style="flex: 1"><b class="disp" style="font-size: 18px">{{ s.name }}</b>
                <span style="display: block; font-size: 13px; color: var(--tx3)">{{ s.isOwner ? 'You own this server' : 'Member' }}</span></span>
              <hx-icon name="chevron-right" />
            </a>
          } @empty {
            <div class="note">You're not a member of any server yet.</div>
          }
        </div>
        <p style="margin: 24px 0 0; font-size: 12.5px; color: var(--tx3)">Invite-only · voice, streams and a soundboard for friends.</p>
      </div>
    </div>
  `,
})
export class HomePage implements OnInit {
  readonly session = inject(SessionService);
  private readonly store = inject(WorkspaceStore);

  ngOnInit(): void {
    // Leaving a server view: clear selection so the rail shows Home as active. Voice (root service) is unaffected.
    this.store.clearSelection();
  }
}
