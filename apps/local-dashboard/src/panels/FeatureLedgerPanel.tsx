import type { JSX } from 'react';
import { api } from '../api';
import type { FeatureRecord } from '../api';
import { useResource } from '../hooks/useResource';
import { AsyncBoundary } from '../components/AsyncBoundary';
import { Panel } from '../components/Panel';
import { FeatureStatusBadge, Badge } from '../components/Badge';
import type { Tone } from '../components/Badge';
import { formatRelative, formatCount } from '../lib/format';

interface PanelProps {
  reloadKey: number;
}

interface EvidenceSummary {
  verified: number;
  total: number;
  tone: Tone;
}

function summariseEvidence(feature: FeatureRecord): EvidenceSummary {
  const total = feature.evidence.length;
  const verified = feature.evidence.filter((e) => e.status === 'verified').length;
  const refuted = feature.evidence.some((e) => e.status === 'refuted');
  let tone: Tone = 'muted';
  if (refuted) {
    tone = 'blocked';
  } else if (total > 0 && verified === total) {
    tone = 'ready';
  } else if (verified > 0) {
    tone = 'warn';
  }
  return { verified, total, tone };
}

function surfaceCount(feature: FeatureRecord): number {
  return (
    feature.routes.length +
    feature.components.length +
    feature.apiEndpoints.length +
    feature.databaseTables.length
  );
}

function FeatureRow({ feature }: { feature: FeatureRecord }): JSX.Element {
  const evidence = summariseEvidence(feature);
  return (
    <tr>
      <th scope="row" className="cell-feature">
        <span className="cell-feature-name">{feature.feature}</span>
        {feature.purpose ? <span className="cell-feature-purpose">{feature.purpose}</span> : null}
      </th>
      <td>
        <FeatureStatusBadge status={feature.status} />
      </td>
      <td className="cell-value">{feature.userValue || '—'}</td>
      <td className="cell-num">
        <span className="mono">{formatCount(surfaceCount(feature))}</span>
      </td>
      <td>
        <Badge
          label={`${evidence.verified}/${evidence.total}`}
          tone={evidence.tone}
        />
      </td>
      <td className="cell-num">
        <span className="cell-time">{formatRelative(feature.updatedAt)}</span>
      </td>
    </tr>
  );
}

function FeatureTable({ features }: { features: FeatureRecord[] }): JSX.Element {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <caption className="sr-only">Feature ledger: every tracked feature with its status and evidence.</caption>
        <thead>
          <tr>
            <th scope="col">Feature</th>
            <th scope="col">Status</th>
            <th scope="col">User value</th>
            <th scope="col" className="cell-num">Surface</th>
            <th scope="col">Evidence</th>
            <th scope="col" className="cell-num">Updated</th>
          </tr>
        </thead>
        <tbody>
          {features.map((feature) => (
            <FeatureRow key={feature.id} feature={feature} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FeatureLedgerPanel({ reloadKey }: PanelProps): JSX.Element {
  const { state, reload } = useResource(api.features, '/api/features', reloadKey);
  const count = state.status === 'success' ? state.data.length : null;
  return (
    <Panel
      title="Feature Ledger"
      icon="ledger"
      subtitle="What has been built, and how well it is proven"
      span="span-12"
      meta={count !== null ? <span className="count-pill">{formatCount(count)}</span> : null}
    >
      <AsyncBoundary
        state={state}
        onRetry={reload}
        isEmpty={(features) => features.length === 0}
        emptyTitle="No features tracked yet"
        emptyHint="Features appear here as the agent records them in the ledger."
        loadingRows={5}
      >
        {(features) => <FeatureTable features={features} />}
      </AsyncBoundary>
    </Panel>
  );
}
