// Fetch-mocking utilities for panel tests. The api client only ever reads
// `.ok`, `.status`, `.statusText`, and `.json()` off the fetch result, so a
// minimal Response-like object is sufficient — no need for a real Response.
import { vi } from 'vitest';

interface MockResponseInit {
  status?: number;
  statusText?: string;
}

interface MockResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}

export function jsonResponse(data: unknown, init: MockResponseInit = {}): MockResponse {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: init.statusText ?? 'OK',
    json: () => Promise.resolve(data),
  };
}

/** Stub fetch to resolve every request with the same payload. */
export function stubFetchOnce(data: unknown, init?: MockResponseInit): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(jsonResponse(data, init))),
  );
}

/** Stub fetch to route by URL suffix, e.g. { '/api/memory': [], '/api/features': [] }. */
export function stubFetchByPath(routes: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      const key = Object.keys(routes).find((path) => url.endsWith(path));
      if (key === undefined) {
        return Promise.resolve(jsonResponse(null, { status: 404, statusText: 'Not Found' }));
      }
      return Promise.resolve(jsonResponse(routes[key]));
    }),
  );
}

/** Stub fetch to reject as a transport failure (daemon offline). */
export function stubFetchNetworkError(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
  );
}

/** Stub fetch to respond with an HTTP error status. */
export function stubFetchHttpError(status = 500, statusText = 'Server Error'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(jsonResponse(null, { status, statusText }))),
  );
}

/** Stub fetch with a never-resolving promise to hold the loading state. */
export function stubFetchPending(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<MockResponse>(() => undefined)),
  );
}
