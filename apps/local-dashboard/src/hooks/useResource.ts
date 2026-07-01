// Data-fetching hook for the dashboard.
//
// Note on approach: DevCortex intentionally ships the dashboard with a minimal
// dependency footprint (react + react-dom only — no data-fetching library), so
// this hook owns the fetch lifecycle directly. It is written to be correct
// under that constraint: every request is abortable, a mounted-guard prevents
// state updates after unmount, and stale responses from a superseded reload are
// discarded via a monotonic request id.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AsyncState } from '../lib/async';
import { errorState, loadingState, successState, toApiError } from '../lib/async';

export interface Resource<T> {
  readonly state: AsyncState<T>;
  /** Imperatively re-run the fetch (used by retry buttons + global refresh). */
  readonly reload: () => void;
}

/**
 * Fetch a resource and expose a fully-typed async state.
 *
 * @param fetcher  called with an AbortSignal; must reject with ApiError-like errors
 * @param endpoint stable label used for error attribution
 * @param reloadKey bump to force a refetch (e.g. a global refresh counter)
 */
export function useResource<T>(
  fetcher: (opts: { signal: AbortSignal }) => Promise<T>,
  endpoint: string,
  reloadKey = 0,
): Resource<T> {
  const [state, setState] = useState<AsyncState<T>>(loadingState<T>());
  const [nonce, setNonce] = useState(0);

  // Keep the latest fetcher/endpoint in refs so the effect depends only on the
  // reload triggers, not on referentially-unstable callbacks passed inline.
  const fetcherRef = useRef(fetcher);
  const endpointRef = useRef(endpoint);
  fetcherRef.current = fetcher;
  endpointRef.current = endpoint;

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    setState(loadingState<T>());

    fetcherRef
      .current({ signal: controller.signal })
      .then((data) => {
        if (active) {
          setState(successState(data));
        }
      })
      .catch((cause: unknown) => {
        // An aborted request is expected during reload/unmount — swallow it.
        if (controller.signal.aborted) {
          return;
        }
        if (active) {
          setState(errorState<T>(toApiError(cause, endpointRef.current)));
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [reloadKey, nonce]);

  return { state, reload };
}
