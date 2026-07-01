import type { JSX } from 'react';
import { api } from '../api';
import type { FeatureRecord, MemoryItem } from '../api';
import { useResource } from '../hooks/useResource';
import { combineStates } from '../lib/async';
import { AsyncBoundary } from '../components/AsyncBoundary';
import { Panel } from '../components/Panel';
import { RiskBadge, Badge } from '../components/Badge';

interface PanelProps {
  reloadKey: number;
}

interface RiskItem {
  id: string;
  title: string;
  detail: string;
  /** a RiskLevel value, or 'known' for a ledgered known-failure */
  level: string;
  origin: string;
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  known: 4,
};

function severityRank(level: string): number {
  return SEVERITY_ORDER[level] ?? 5;
}

function collectRisks(memory: MemoryItem[], features: FeatureRecord[]): RiskItem[] {
  const fromMemory: RiskItem[] = memory
    .filter((item) => item.type === 'risk')
    .map((item) => ({
      id: `mem-${item.id}`,
      title: item.title,
      detail: item.summary,
      level: item.riskLevel,
      origin: item.source || 'memory ledger',
    }));

  const fromFeatures: RiskItem[] = features.flatMap((feature) =>
    feature.knownRisks.map((risk, idx) => ({
      id: `feat-${feature.id}-${idx}`,
      title: feature.feature,
      detail: risk,
      level: 'known',
      origin: 'feature ledger',
    })),
  );

  return [...fromMemory, ...fromFeatures].sort(
    (a, b) => severityRank(a.level) - severityRank(b.level),
  );
}

function RiskList({ risks }: { risks: RiskItem[] }): JSX.Element {
  return (
    <ul className="risk-list">
      {risks.map((risk) => (
        <li key={risk.id} className="risk-item">
          <div className="risk-item-head">
            {risk.level === 'known' ? (
              <Badge label="Known failure" tone="warn" />
            ) : (
              <RiskBadge level={risk.level} />
            )}
            <span className="risk-item-title">{risk.title}</span>
          </div>
          {risk.detail ? <p className="risk-item-detail">{risk.detail}</p> : null}
          <p className="risk-item-origin">via {risk.origin}</p>
        </li>
      ))}
    </ul>
  );
}

export function RisksPanel({ reloadKey }: PanelProps): JSX.Element {
  const memory = useResource(api.memory, '/api/memory', reloadKey);
  const features = useResource(api.features, '/api/features', reloadKey);
  const combined = combineStates(memory.state, features.state);
  const retry = (): void => {
    memory.reload();
    features.reload();
  };

  return (
    <Panel
      title="Risks & Known-Failures"
      icon="risk"
      subtitle="Open risks and failure modes the agent must respect"
      span="span-4"
    >
      <AsyncBoundary
        state={combined}
        onRetry={retry}
        isEmpty={([memItems, featItems]) =>
          collectRisks(memItems, featItems).length === 0
        }
        emptyTitle="No open risks"
        emptyHint="Risks logged to memory and feature known-failures surface here."
        loadingRows={4}
      >
        {([memItems, featItems]) => <RiskList risks={collectRisks(memItems, featItems)} />}
      </AsyncBoundary>
    </Panel>
  );
}
