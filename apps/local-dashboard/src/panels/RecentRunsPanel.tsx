import type { JSX } from 'react';
import { api } from '../api';
import type { RunRecord } from '../api';
import { useResource } from '../hooks/useResource';
import { AsyncBoundary } from '../components/AsyncBoundary';
import { Panel } from '../components/Panel';
import { RunStatusBadge } from '../components/Badge';
import { Icon } from '../components/Icon';
import { formatRelative, formatCount } from '../lib/format';

interface PanelProps {
  reloadKey: number;
}

function CoverageChip({ label, present }: { label: string; present: boolean }): JSX.Element {
  return (
    <span className={`chip ${present ? 'chip--on' : 'chip--off'}`}>
      <span className="chip-mark" aria-hidden="true">
        <Icon name={present ? 'check' : 'x'} />
      </span>
      {label}
      <span className="sr-only">{present ? ' captured' : ' missing'}</span>
    </span>
  );
}

function sortByRecency(runs: RunRecord[]): RunRecord[] {
  return [...runs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

function RunItem({ run }: { run: RunRecord }): JSX.Element {
  return (
    <li className="run-item">
      <div className="run-item-head">
        <span className="run-item-task">{run.task || 'Untitled run'}</span>
        <RunStatusBadge status={run.status} />
      </div>
      <div className="run-item-coverage">
        <CoverageChip label="Intent" present={run.intentPresent} />
        <CoverageChip label="Context" present={run.contextPresent} />
        <CoverageChip label="Plan" present={run.planPresent} />
      </div>
      <div className="run-item-foot">
        <span className="run-item-time">{formatRelative(run.createdAt)}</span>
        <span className="run-item-metrics mono">
          {formatCount(run.commands.length)} cmd · {formatCount(run.evidenceIds.length)} evidence
        </span>
      </div>
    </li>
  );
}

export function RecentRunsPanel({ reloadKey }: PanelProps): JSX.Element {
  const { state, reload } = useResource(api.runs, '/api/runs', reloadKey);
  const count = state.status === 'success' ? state.data.length : null;
  return (
    <Panel
      title="Recent Agent Runs"
      icon="runs"
      subtitle="The flight recorder for recent agent sessions"
      span="span-6"
      meta={count !== null ? <span className="count-pill">{formatCount(count)}</span> : null}
    >
      <AsyncBoundary
        state={state}
        onRetry={reload}
        isEmpty={(runs) => runs.length === 0}
        emptyTitle="No runs recorded"
        emptyHint="Recorded agent sessions will appear here newest-first."
        loadingRows={4}
      >
        {(runs) => (
          <ul className="run-list">
            {sortByRecency(runs).map((run) => (
              <RunItem key={run.id} run={run} />
            ))}
          </ul>
        )}
      </AsyncBoundary>
    </Panel>
  );
}
