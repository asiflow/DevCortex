import type { JSX } from 'react';
import { api } from '../api';
import type { HealthResponse } from '../api';
import type { AsyncState } from '../lib/async';
import { useResource } from '../hooks/useResource';
import { Icon } from './Icon';
import { humanize } from '../lib/format';

interface HeaderProps {
  reloadKey: number;
  autoRefresh: boolean;
  onRefresh: () => void;
  onToggleAutoRefresh: () => void;
}

interface Connection {
  tone: 'ready' | 'warn' | 'blocked' | 'muted';
  label: string;
}

function connectionFor(state: AsyncState<HealthResponse>): Connection {
  if (state.status === 'loading') {
    return { tone: 'muted', label: 'Connecting' };
  }
  if (state.status === 'error') {
    return { tone: 'blocked', label: 'Offline' };
  }
  return state.data.ok
    ? { tone: 'ready', label: 'Connected' }
    : { tone: 'warn', label: 'Degraded' };
}

function projectName(root: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] ?? root) : root;
}

function BrandMark(): JSX.Element {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
      <rect x="1.5" y="1.5" width="29" height="29" rx="8" className="brand-mark-frame" />
      <path
        className="brand-mark-glyph"
        d="M21 10a7 7 0 1 0 0 12M16 16h-5M13 13v6"
        fill="none"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Header({
  reloadKey,
  autoRefresh,
  onRefresh,
  onToggleAutoRefresh,
}: HeaderProps): JSX.Element {
  const { state } = useResource(api.health, '/api/health', reloadKey);
  const connection = connectionFor(state);
  const health = state.status === 'success' ? state.data : null;

  return (
    <header className="app-header">
      <div className="app-header-brand">
        <BrandMark />
        <div className="brand-text">
          <span className="brand-name">
            Dev<span className="brand-accent">Cortex</span>
          </span>
          <span className="brand-tagline">Local dashboard</span>
        </div>
      </div>

      <div className="app-header-project">
        {health ? (
          <>
            <span className="project-name" title={health.root}>
              {projectName(health.root)}
            </span>
            <span className="project-meta">
              <span className="tag">{humanize(health.mode)}</span>
              <span className="tag tag--mono">v{health.version}</span>
            </span>
          </>
        ) : (
          <span className="project-name project-name--pending">DevCortex project</span>
        )}
      </div>

      <div className="app-header-controls">
        <span className={`conn conn--${connection.tone}`} role="status" aria-live="polite">
          <span className="conn-dot" aria-hidden="true" />
          {connection.label}
        </span>

        <button
          type="button"
          className="switch"
          role="switch"
          aria-checked={autoRefresh}
          onClick={onToggleAutoRefresh}
        >
          <span className="switch-track" aria-hidden="true">
            <span className="switch-thumb" />
          </span>
          <span className="switch-label">Auto-refresh</span>
        </button>

        <button type="button" className="btn btn--primary" onClick={onRefresh}>
          <Icon name="refresh" />
          Refresh
        </button>
      </div>
    </header>
  );
}
