import { HttpErrorResponse } from '@angular/common/http';

/** A ProblemDetails failure with a stable machine-readable code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }

  static from(err: unknown): ApiError {
    if (err instanceof ApiError) return err;
    if (err instanceof HttpErrorResponse) {
      const body = err.error && typeof err.error === 'object' ? err.error : {};
      if (err.status === 0) return new ApiError(0, 'network.offline', 'Cannot reach Hangar. Check your connection.');
      return new ApiError(
        err.status,
        String(body.code ?? `http.${err.status}`),
        String(body.title ?? err.statusText ?? 'Request failed.'),
        body.requestId,
        typeof body.retryAfterMs === 'number' ? body.retryAfterMs : undefined,
      );
    }
    return new ApiError(-1, 'client.error', err instanceof Error ? err.message : 'Unexpected error.');
  }
}
