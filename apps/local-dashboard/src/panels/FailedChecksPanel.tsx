import type { JSX } from 'react';
import { api } from '../api';
import type { ReadyScore } from '../api';
import { useResource } from '../hooks/useResource';
import { AsyncBoundary } from '../components/AsyncBoundary';
import { Panel } from '../components/Panel';
import { Icon } from '../components/Icon';
import { formatCount } from '../lib/format';

interface PanelProps {
  reloadKey: number;
}

function FailedChecksView({ data }: { data: ReadyScore }): JSX.Element {
  const hasBlocked = data.blocked > 0;
  const hasWarnings = data.warnings > 0;
  const total = data.passed + data.blocked + data.warnings;

  if (!hasBlocked && !hasWarnings) {
    // A positive "all clear" is distinct from an empty/never-run state.
    return (
      <div className="state state--clear" role="status">
        <span className="state-glyph state-glyph--ready" aria-hidden="true">
          <Icon name="check" />
        </span>
        <div className="state-copy">
          <p className="state-title">
            {total > 0 ? `All ${formatCount(data.passed)} checks passing` : 'No checks recorded yet'}
          </p>
          <p className="state-detail">
            {total > 0
              ? 'Nothing is blocking a ship right now.'
              : 'Run a ship check to evaluate the gates.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <ul className="check-list">
      {hasBlocked ? (
        <li className="check-row check-row--blocked">
          <span className="check-glyph" aria-hidden="true">
            <Icon name="x" />
          </span>
          <span className="check-count mono">{formatCount(data.blocked)}</span>
          <span className="check-label">
            blocking {data.blocked === 1 ? 'check' : 'checks'} must pass before shipping
          </span>
        </li>
      ) : null}
      {hasWarnings ? (
        <li className="check-row check-row--warn">
          <span className="check-glyph" aria-hidden="true">
            <Icon name="alert" />
          </span>
          <span className="check-count mono">{formatCount(data.warnings)}</span>
          <span className="check-label">
            {data.warnings === 1 ? 'warning' : 'warnings'} to review
          </span>
        </li>
      ) : null}
      <li className="check-row check-row--passed">
        <span className="check-glyph" aria-hidden="true">
          <Icon name="check" />
        </span>
        <span className="check-count mono">{formatCount(data.passed)}</span>
        <span className="check-label">{data.passed === 1 ? 'check' : 'checks'} passing</span>
      </li>
    </ul>
  );
}

export function FailedChecksPanel({ reloadKey }: PanelProps): JSX.Element {
  const { state, reload } = useResource(api.readyScore, '/api/ready-score', reloadKey);
  return (
    <Panel
      title="Failed Checks"
      icon="checks"
      subtitle="Blockers and warnings from the latest gate run"
      span="span-4"
    >
      <AsyncBoundary state={state} onRetry={reload} loadingRows={3}>
        {(data) => <FailedChecksView data={data} />}
      </AsyncBoundary>
    </Panel>
  );
}
