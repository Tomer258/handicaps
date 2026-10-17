import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { SessionService } from '../../core/auth/session.service';
import { WorkspaceStore } from '../workspaces/workspace.store';
import { Icon } from '../../shared/ui/icon';
import { ToastHost } from './toast-host';
import { ChatStore } from '../messages/chat.store';
import { VoicePresenceStore } from '../voice/voice-presence.store';

/**
 * Top-level authenticated layout: server rail + routed content + toasts + session recovery.
 * Root media/voice services live outside routed components so text navigation never ends a call.
 */
@Component({
  selector: 'hx-app-shell',
  imports: [RouterOutlet, RouterLink, Icon, ToastHost],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a class="skip-link" href="#composer">Skip to message composer</a>
    <div class="app">
      <nav class="rail" aria-label="Servers"
           style="width: 68px; flex: none; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 12px 0; background: var(--bg0)">
        <a class="srv" [class.on]="atHome()" routerLink="/" aria-label="Home" title="Home"
           style="background: var(--accent); color: var(--accent-ink)">
          <span class="pip"></span>
          <hx-icon name="home" size="lg" />
        </a>
        <div style="width: 28px; height: 2px; border-radius: 1px; background: var(--line)"></div>
        <div role="list" style="display: flex; flex-direction: column; gap: 10px; align-items: center">
          @for (s of session.servers(); track s.id) {
            <a role="listitem" class="srv" [class.on]="store.serverId() === s.id && !atHome()" [routerLink]="['/s', s.id]"
               [attr.aria-label]="s.name" [title]="s.name" style="background: #23262C; color: #ECEEF1">
              <span class="pip"></span>
              <span class="disp" style="font-size: 15px; font-weight: 700">{{ short(s.name) }}</span>
            </a>
          }
        </div>
        <div style="flex: 1"></div>
      </nav>

      <div style="flex: 1; min-width: 0; display: flex; position: relative">
        <router-outlet />
      </div>

      <hx-toast-host />

      @if (session.expired()) {
        <div class="scrim" role="alertdialog" aria-modal="true" aria-labelledby="expired-title">
          <div class="pop fade" style="width: 400px; max-width: calc(100% - 32px); padding: 22px; display: flex; flex-direction: column; gap: 12px">
            <h2 id="expired-title" class="disp" style="margin: 0; font-size: 20px">Signed out</h2>
            <p style="margin: 0; color: var(--tx2)">Your session ended (expired or revoked from another device). Sign in again to continue.</p>
            <button class="btn pri" (click)="session.recoverToLogin()" cdkFocusInitial>Sign in</button>
          </div>
        </div>
      }
    </div>
  `,
})
export class AppShell {
  readonly session = inject(SessionService);
  readonly store = inject(WorkspaceStore);
  /** Eager: starts realtime + unread tracking for the session, independent of the routed view. */
  private readonly chat = inject(ChatStore);
  private readonly voiceRoster = inject(VoicePresenceStore);

  readonly atHome = computed(() => this.store.serverId() === null);

  short(name: string): string {
    const words = name.replace(/^the\s+/i, '').split(/\s+/).filter(Boolean);
    return words.length > 1 ? (words[0][0] + words[1][0]).toUpperCase() : (words[0]?.[0] ?? '?').toUpperCase();
  }
}
