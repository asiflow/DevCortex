import type { JSX } from 'react';
import { api } from '../api';
import type { ReadyScore } from '../api';
import { useResource } from '../hooks/useResource';
import { AsyncBoundary } from '../components/AsyncBoundary';
import { Panel } from '../components/Panel';
import { Gauge } from '../components/Gauge';
import type { GaugeTone } from '../components/Gauge';
import { Stat, StatGroup } from '../components/Stat';

interface PanelProps {
  reloadKey: number;
}

function gaugeTone(status: string, score: number): GaugeTone {
  const normalized = status.trim().toUpperCase();
  if (normalized.includes('NOT') || normalized.includes('BLOCK') || normalized.includes('FAIL')) {
    return 'blocked';
  }
  if (normalized.includes('WARN')) {
    return 'warn';
  }
  if (normalized.includes('READY') || normalized.includes('PASS')) {
    return 'ready';
  }
  if (score >= 80) {
    return 'ready';
  }
  if (score >= 50) {
    return 'warn';
  }
  return 'blocked';
}

function ReadyScoreView({ data }: { data: ReadyScore }): JSX.Element {
  const tone = gaugeTone(data.status, data.score);
  const total = data.passed + data.blocked + data.warnings;
  return (
    <div className="readiness">
      <Gauge score={data.score} status={data.status} tone={tone} />
      <StatGroup>
        <Stat label="Passed" value={data.passed} tone="ready" />
        <Stat label="Blocked" value={data.blocked} tone="blocked" />
        <Stat label="Warnings" value={data.warnings} tone="warn" />
      </StatGroup>
      {total === 0 ? (
        <p className="readiness-note">No gate checks recorded yet — run a ship check to populate this score.</p>
      ) : null}
    </div>
  );
}

export function ShipReadinessPanel({ reloadKey }: PanelProps): JSX.Element {
  const { state, reload } = useResource(api.readyScore, '/api/ready-score', reloadKey);
  return (
    <Panel
      title="Ship-Readiness"
      icon="gauge"
      subtitle="Aggregate gate verdict for this project"
      emphasis="feature"
      span="span-4"
    >
      <AsyncBoundary state={state} onRetry={reload} loadingRows={4}>
        {(data) => <ReadyScoreView data={data} />}
      </AsyncBoundary>
    </Panel>
  );
}
