// Status + risk pills with a fixed, semantic colour vocabulary so a "blocked"
// check and a "critical" risk read the same everywhere.

import type { JSX } from 'react';
import { humanize } from '../lib/format';

export type Tone = 'ready' | 'warn' | 'blocked' | 'accent' | 'neutral' | 'muted';

interface BadgeProps {
  label: string;
  tone: Tone;
  /** render a leading status dot */
  dot?: boolean;
}

export function Badge({ label, tone, dot = false }: BadgeProps): JSX.Element {
  return (
    <span className={`badge badge--${tone}`} data-tone={tone}>
      {dot ? <span className="badge-dot" aria-hidden="true" /> : null}
      {label}
    </span>
  );
}

// --- semantic mappers -------------------------------------------------------

const FEATURE_TONE: Record<string, Tone> = {
  shipped: 'ready',
  building: 'accent',
  planned: 'neutral',
  deprecated: 'muted',
};

const DECISION_TONE: Record<string, Tone> = {
  accepted: 'ready',
  proposed: 'accent',
  superseded: 'muted',
};

const RUN_TONE: Record<string, Tone> = {
  closed: 'ready',
  open: 'accent',
};

const SHIP_TONE: Record<string, Tone> = {
  READY: 'ready',
  READY_WITH_WARNINGS: 'warn',
  NOT_READY: 'blocked',
};

const RISK_TONE: Record<string, Tone> = {
  low: 'muted',
  medium: 'warn',
  high: 'warn',
  critical: 'blocked',
};

function toneFrom(map: Record<string, Tone>, value: string): Tone {
  return map[value] ?? 'neutral';
}

export function FeatureStatusBadge({ status }: { status: string }): JSX.Element {
  return <Badge label={humanize(status)} tone={toneFrom(FEATURE_TONE, status)} dot />;
}

export function DecisionStatusBadge({ status }: { status: string }): JSX.Element {
  return <Badge label={humanize(status)} tone={toneFrom(DECISION_TONE, status)} dot />;
}

export function RunStatusBadge({ status }: { status: string }): JSX.Element {
  return <Badge label={humanize(status)} tone={toneFrom(RUN_TONE, status)} dot />;
}

export function ShipStatusBadge({ status }: { status: string }): JSX.Element {
  return <Badge label={humanize(status)} tone={toneFrom(SHIP_TONE, status)} dot />;
}

export function RiskBadge({ level }: { level: string }): JSX.Element {
  return <Badge label={humanize(level)} tone={toneFrom(RISK_TONE, level)} />;
}
