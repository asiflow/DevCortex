// A small set of inline, decorative SVG glyphs. Each is aria-hidden by default
// because it always accompanies a text label — icons here carry no standalone
// meaning for assistive tech.

import type { JSX } from 'react';

export type IconName =
  | 'gauge'
  | 'ledger'
  | 'map'
  | 'risk'
  | 'runs'
  | 'checks'
  | 'decision'
  | 'brief'
  | 'refresh'
  | 'pulse'
  | 'check'
  | 'alert'
  | 'x';

interface IconProps {
  name: IconName;
  className?: string;
}

const PATHS: Record<IconName, JSX.Element> = {
  gauge: (
    <>
      <path d="M12 13a3 3 0 0 0 3-3" />
      <path d="M4.5 17a9 9 0 1 1 15 0" />
      <path d="m12 10 3-3" />
    </>
  ),
  ledger: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 9h16M9 4v16" />
    </>
  ),
  map: (
    <>
      <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z" />
      <path d="M9 4v14M15 6v14" />
    </>
  ),
  risk: (
    <>
      <path d="M12 3 2 20h20L12 3Z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  runs: (
    <>
      <path d="M6 4v16M6 8h10l-2.5 3L16 14H6" />
    </>
  ),
  checks: (
    <>
      <path d="m4 12 4 4 6-9" />
      <path d="M14 15h6M14 19h6" />
    </>
  ),
  decision: (
    <>
      <path d="M12 3v6M12 15v6" />
      <circle cx="12" cy="12" r="3" />
      <path d="M5 8h3M16 16h3" />
    </>
  ),
  brief: (
    <>
      <path d="M6 3h9l3 3v15H6Z" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11a8 8 0 1 0-2 5" />
      <path d="M20 5v6h-6" />
    </>
  ),
  pulse: (
    <>
      <path d="M3 12h4l2 6 4-12 2 6h6" />
    </>
  ),
  check: <path d="m4 12 5 5L20 6" />,
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16h.01" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6 6 18" />,
};

export function Icon({ name, className }: IconProps): JSX.Element {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
