import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, Observable } from 'rxjs';
import { ApiError } from './api-error';

const BASE = '/api/v1';

/** Thin typed HTTP boundary. Converts failures to ApiError; owns no domain state. */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  get<T>(path: string, params?: Record<string, string | number | boolean | undefined | null>): Promise<T> {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null) p = p.set(k, String(v));
    return this.run(this.http.get<T>(BASE + path, { params: p }));
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.run(this.http.post<T>(BASE + path, body ?? {}));
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.run(this.http.put<T>(BASE + path, body ?? {}));
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.run(this.http.patch<T>(BASE + path, body ?? {}));
  }

  delete<T = void>(path: string): Promise<T> {
    return this.run(this.http.delete<T>(BASE + path));
  }

  /** Multipart upload with progress callback. */
  upload<T>(path: string, form: FormData, onProgress?: (pct: number) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.http.post<T>(BASE + path, form, { reportProgress: true, observe: 'events' }).subscribe({
        next: (ev) => {
          if (ev.type === 1 && ev.total) onProgress?.(Math.round((100 * ev.loaded) / ev.total));
          if (ev.type === 4) resolve(ev.body as T);
        },
        error: (e) => reject(ApiError.from(e)),
      });
    });
  }

  private async run<T>(obs: Observable<T>): Promise<T> {
    try {
      return await firstValueFrom(obs);
    } catch (e) {
      throw ApiError.from(e);
    }
  }
}
