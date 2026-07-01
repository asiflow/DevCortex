// Loading / error / empty presentational blocks, shared by every panel so the
// three non-happy states look and behave identically across the dashboard.

import type { JSX } from 'react';
import { Icon } from './Icon';

interface LoadingBlockProps {
  label?: string;
  /** number of shimmer rows to show */
  rows?: number;
}

export function LoadingBlock({ label = 'Loading', rows = 3 }: LoadingBlockProps): JSX.Element {
  return (
    <div className="state state--loading" role="status" aria-live="polite">
      <span className="sr-only">{label}…</span>
      <div className="skeleton-stack" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <div key={`sk-${i}`} className="skeleton-row" style={{ width: `${88 - i * 12}%` }} />
        ))}
      </div>
    </div>
  );
}

interface ErrorBlockProps {
  title?: string;
  message: string;
  onRetry?: () => void;
}

export function ErrorBlock({
  title = 'Could not load',
  message,
  onRetry,
}: ErrorBlockProps): JSX.Element {
  return (
    <div className="state state--error" role="alert">
      <span className="state-glyph state-glyph--error" aria-hidden="true">
        <Icon name="alert" />
      </span>
      <div className="state-copy">
        <p className="state-title">{title}</p>
        <p className="state-detail">{message}</p>
      </div>
      {onRetry ? (
        <button type="button" className="btn btn--ghost" onClick={onRetry}>
          <Icon name="refresh" />
          Retry
        </button>
      ) : null}
    </div>
  );
}

interface EmptyBlockProps {
  title?: string;
  hint?: string;
}

export function EmptyBlock({
  title = 'Nothing yet',
  hint,
}: EmptyBlockProps): JSX.Element {
  return (
    <div className="state state--empty">
      <div className="state-copy">
        <p className="state-title">{title}</p>
        {hint ? <p className="state-detail">{hint}</p> : null}
      </div>
    </div>
  );
}
