import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SessionService } from './session.service';

/** Navigation hint only — the API is the authority. */
export const authGuard: CanActivateFn = async (_route, state) => {
  const session = inject(SessionService);
  const router = inject(Router);
  if (session.status() === 'unknown') await session.restore();
  if (session.status() === 'authenticated') return true;
  if (session.status() === 'offline') return router.createUrlTree(['/offline'], { queryParams: { next: state.url } });
  return router.createUrlTree(['/login'], { queryParams: state.url && state.url !== '/' ? { next: state.url } : {} });
};

export const anonymousGuard: CanActivateFn = async () => {
  const session = inject(SessionService);
  const router = inject(Router);
  if (session.status() === 'unknown') await session.restore();
  return session.status() === 'authenticated' ? router.createUrlTree(['/']) : true;
};
