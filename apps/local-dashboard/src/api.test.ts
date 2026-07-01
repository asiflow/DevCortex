import { describe, it, expect, vi } from 'vitest';
import { api, ApiError } from './api';
import { stubFetchNetworkError } from './test/helpers';

describe('api client', () => {
  it('requests the correct endpoint with a JSON Accept header', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve({ ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve({ ok: true }) }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.health();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call ?? [];
    expect(String(url)).toMatch(/\/api\/health$/);
    expect(init?.headers).toMatchObject({ Accept: 'application/json' });
  });

  it('parses and returns the JSON body on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve([{ id: 'feat-1' }]),
        }),
      ),
    );

    const features = await api.features();
    expect(features).toEqual([{ id: 'feat-1' }]);
  });

  it('throws an ApiError carrying the HTTP status on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({ ok: false, status: 503, statusText: 'Service Unavailable', json: () => Promise.resolve(null) }),
      ),
    );

    const error = await api.runs().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    if (error instanceof ApiError) {
      expect(error.status).toBe(503);
      expect(error.endpoint).toBe('/api/runs');
    }
  });

  it('wraps transport failures as an ApiError with a null status', async () => {
    stubFetchNetworkError();
    const error = await api.decisions().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    if (error instanceof ApiError) {
      expect(error.status).toBeNull();
      expect(error.message).toMatch(/daemon/i);
    }
  });

  it('throws an ApiError when the body is not valid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.reject(new Error('Unexpected token')),
        }),
      ),
    );

    const error = await api.brief().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    if (error instanceof ApiError) {
      expect(error.message).toMatch(/malformed/i);
    }
  });
});
