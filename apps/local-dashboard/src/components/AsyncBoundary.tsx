// Renders exactly one of loading / error / empty / content for a given async
// state. Centralising this guarantees every panel handles all four cases and
// keeps individual panels focused on their happy-path markup.

import type { ReactNode } from 'react';
import type { AsyncState } from '../lib/async';
import { EmptyBlock, ErrorBlock, LoadingBlock } from './states';

interface AsyncBoundaryProps<T> {
  state: AsyncState<T>;
  children: (data: T) => ReactNode;
  onRetry?: () => void;
  /** Predicate deciding whether successfully-loaded data is "empty". */
  isEmpty?: (data: T) => boolean;
  emptyTitle?: string;
  emptyHint?: string;
  loadingLabel?: string;
  loadingRows?: number;
  errorTitle?: string;
}

export function AsyncBoundary<T>({
  state,
  children,
  onRetry,
  isEmpty,
  emptyTitle,
  emptyHint,
  loadingLabel,
  loadingRows,
  errorTitle,
}: AsyncBoundaryProps<T>): ReactNode {
  if (state.status === 'loading') {
    return <LoadingBlock label={loadingLabel} rows={loadingRows} />;
  }
  if (state.status === 'error') {
    return (
      <ErrorBlock
        title={errorTitle}
        message={state.error.message}
        onRetry={onRetry}
      />
    );
  }
  if (isEmpty?.(state.data)) {
    return <EmptyBlock title={emptyTitle} hint={emptyHint} />;
  }
  return children(state.data);
}
