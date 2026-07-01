// Small labelled metric tiles used in the readiness + failed-checks panels.

import type { JSX, ReactNode } from 'react';
import type { Tone } from './Badge';
import { formatCount } from '../lib/format';

interface StatProps {
  label: string;
  value: number;
  tone: Tone;
}

export function Stat({ label, value, tone }: StatProps): JSX.Element {
  return (
    <div className={`stat stat--${tone}`}>
      <span className="stat-value">{formatCount(value)}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

interface StatGroupProps {
  children: ReactNode;
}

export function StatGroup({ children }: StatGroupProps): JSX.Element {
  return <div className="stat-group">{children}</div>;
}
