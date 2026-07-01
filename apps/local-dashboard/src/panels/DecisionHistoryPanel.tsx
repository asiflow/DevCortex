import type { JSX } from 'react';
import { api } from '../api';
import type { DecisionRecord } from '../api';
import { useResource } from '../hooks/useResource';
import { AsyncBoundary } from '../components/AsyncBoundary';
import { Panel } from '../components/Panel';
import { DecisionStatusBadge } from '../components/Badge';
import { formatDateTime, formatCount } from '../lib/format';

interface PanelProps {
  reloadKey: number;
}

function sortByDate(decisions: DecisionRecord[]): DecisionRecord[] {
  return [...decisions].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );
}

function DecisionItem({ decision }: { decision: DecisionRecord }): JSX.Element {
  return (
    <li className="timeline-item">
      <div className="timeline-marker" aria-hidden="true" />
      <div className="timeline-body">
        <div className="timeline-head">
          <span className="timeline-title">{decision.decision}</span>
          <DecisionStatusBadge status={decision.status} />
        </div>
        {decision.chosenOption ? (
          <p className="timeline-choice">
            Chose <strong>{decision.chosenOption}</strong>
          </p>
        ) : null}
        {decision.reason ? <p className="timeline-reason">{decision.reason}</p> : null}
        <p className="timeline-time">{formatDateTime(decision.date)}</p>
      </div>
    </li>
  );
}

export function DecisionHistoryPanel({ reloadKey }: PanelProps): JSX.Element {
  const { state, reload } = useResource(api.decisions, '/api/decisions', reloadKey);
  const count = state.status === 'success' ? state.data.length : null;
  return (
    <Panel
      title="Decision History"
      icon="decision"
      subtitle="Architectural decisions and their rationale"
      span="span-6"
      meta={count !== null ? <span className="count-pill">{formatCount(count)}</span> : null}
    >
      <AsyncBoundary
        state={state}
        onRetry={reload}
        isEmpty={(decisions) => decisions.length === 0}
        emptyTitle="No decisions recorded"
        emptyHint="Accepted architectural decisions will be logged here."
        loadingRows={4}
      >
        {(decisions) => (
          <ol className="timeline">
            {sortByDate(decisions).map((decision) => (
              <DecisionItem key={decision.id} decision={decision} />
            ))}
          </ol>
        )}
      </AsyncBoundary>
    </Panel>
  );
}
