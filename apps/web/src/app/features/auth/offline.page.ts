import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { SessionService } from '../../core/auth/session.service';

@Component({
  selector: 'hx-offline-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="auth-wrap">
      <div class="auth-card fade" role="alert">
        <h1>Can't reach Hangar</h1>
        <p>The server isn't responding. Your friends might be fixing it right now.</p>
        <button class="btn pri" (click)="retry()" [disabled]="busy()">{{ busy() ? 'Retrying…' : 'Try again' }}</button>
      </div>
    </main>
  `,
})
export class OfflinePage {
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  readonly busy = signal(false);

  async retry(): Promise<void> {
    this.busy.set(true);
    await this.session.restore();
    this.busy.set(false);
    if (this.session.status() !== 'offline') {
      const next = this.route.snapshot.queryParamMap.get('next') ?? '/';
      await this.router.navigateByUrl(next.startsWith('/') && !next.startsWith('//') ? next : '/');
    }
  }
}
