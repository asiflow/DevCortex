// A tiny, exhaustive async-state model shared by every panel. Using a
// discriminated union (never a bag of nullable booleans) means the UI is forced
// to handle loading / error / success explicitly — no `as`, no `any`.

import { ApiError } from '../api';

export type AsyncState<T> =
  | { readonly status: 'loading'; readonly data: null; readonly error: null }
  | { readonly status: 'success'; readonly data: T; readonly error: null }
  | { readonly status: 'error'; readonly data: null; readonly error: ApiError };

export const loadingState = <T>(): AsyncState<T> => ({
  status: 'loading',
  data: null,
  error: null,
});

export const successState = <T>(data: T): AsyncState<T> => ({
  status: 'success',
  data,
  error: null,
});

export const errorState = <T>(error: ApiError): AsyncState<T> => ({
  status: 'error',
  data: null,
  error,
});

/** Normalise any thrown value into an ApiError the UI can render. */
export function toApiError(cause: unknown, endpoint: string): ApiError {
  if (cause instanceof ApiError) {
    return cause;
  }
  if (cause instanceof Error) {
    return new ApiError(cause.message, endpoint, null);
  }
  return new ApiError('Unexpected error while loading data.', endpoint, null);
}

/**
 * Combine two async states into one for panels that read two endpoints. The
 * merged state is loading if either is loading, errored if either errored
 * (first error wins), and successful only when both resolve.
 */
export function combineStates<A, B>(
  a: AsyncState<A>,
  b: AsyncState<B>,
): AsyncState<readonly [A, B]> {
  if (a.status === 'error') {
    return errorState(a.error);
  }
  if (b.status === 'error') {
    return errorState(b.error);
  }
  if (a.status === 'success' && b.status === 'success') {
    return successState([a.data, b.data] as const);
  }
  return loadingState();
}
