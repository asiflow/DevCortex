// The ship-readiness gauge: a semicircular arc whose fill and colour encode the
// 0–100 score and the daemon's status verdict. Rendered as a single role="img"
// with an exhaustive aria-label so the whole thing reads as one statement.

import type { JSX } from 'react';
import { clampScore, humanize } from '../lib/format';

export type GaugeTone = 'ready' | 'warn' | 'blocked' | 'neutral';

interface GaugeProps {
  score: number;
  status: string;
  tone: GaugeTone;
}

// Geometry: 200×120 viewBox, arc centred at (100,100), radius 80.
const CX = 100;
const CY = 100;
const R = 80;
const ARC = `M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`;

export function Gauge({ score, status, tone }: GaugeProps): JSX.Element {
  const value = clampScore(score);
  const label = humanize(status);

  return (
    <div className={`gauge gauge--${tone}`}>
      <svg
        className="gauge-svg"
        viewBox="0 0 200 120"
        role="img"
        aria-label={`Ship-readiness score ${value} out of 100. Status: ${label}.`}
      >
        <path className="gauge-track" d={ARC} pathLength={100} />
        <path
          className="gauge-value"
          d={ARC}
          pathLength={100}
          strokeDasharray="100"
          strokeDashoffset={100 - value}
        />
      </svg>
      <div className="gauge-readout" aria-hidden="true">
        <span className="gauge-score">{value}</span>
        <span className="gauge-scale">/ 100</span>
      </div>
      <p className={`gauge-status gauge-status--${tone}`} aria-hidden="true">
        {label}
      </p>
    </div>
  );
}
