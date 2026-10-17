import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, retry, throwError, timer } from 'rxjs';
import { SessionService } from '../auth/session.service';

/** Correlates browser requests with API logs. */
export const requestIdInterceptor: HttpInterceptorFn = (req, next) =>
  next(req.clone({ setHeaders: { 'X-Request-Id': crypto.randomUUID() } }));

/** Retries idempotent GETs on network/5xx failures with backoff. Commands retry only via their own idempotency keys. */
export const retryGetInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.method !== 'GET') return next(req);
  return next(req).pipe(
    retry({
      count: 2,
      delay: (err, attempt) => {
        if (err instanceof HttpErrorResponse && (err.status === 0 || err.status >= 500)) return timer(300 * 2 ** attempt);
        return throwError(() => err);
      },
    }),
  );
};

/** A 401 pauses the app and exposes login recovery; it never loops re-authentication silently. */
export const unauthorizedInterceptor: HttpInterceptorFn = (req, next) => {
  const session = inject(SessionService);
  return next(req).pipe(
    catchError((err) => {
      if (err instanceof HttpErrorResponse && err.status === 401 && !req.url.includes('/auth/')) {
        session.handleUnauthorized();
      }
      return throwError(() => err);
    }),
  );
};
