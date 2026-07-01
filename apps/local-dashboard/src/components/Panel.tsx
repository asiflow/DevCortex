// The card chrome every panel sits in. A panel is a labelled landmark region so
// screen-reader users can jump between sections of the dashboard.

import type { JSX, ReactNode } from 'react';
import { useId } from 'react';
import type { IconName } from './Icon';
import { Icon } from './Icon';

interface PanelProps {
  title: string;
  icon: IconName;
  /** short supporting text under the title */
  subtitle?: string;
  /** right-aligned header slot (counts, controls) */
  meta?: ReactNode;
  /** visual weight: `feature` panels get a stronger frame */
  emphasis?: 'default' | 'feature';
  /** css grid-column span helper class, e.g. "span-6" */
  span?: string;
  children: ReactNode;
}

export function Panel({
  title,
  icon,
  subtitle,
  meta,
  emphasis = 'default',
  span,
  children,
}: PanelProps): JSX.Element {
  // Stable per-instance id for the aria-labelledby association.
  const headingId = `panel-${useId()}`;
  const classes = [
    'panel',
    emphasis === 'feature' ? 'panel--feature' : '',
    span ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section className={classes} aria-labelledby={headingId}>
      <header className="panel-head">
        <span className="panel-icon" aria-hidden="true">
          <Icon name={icon} />
        </span>
        <div className="panel-headings">
          <h2 className="panel-title" id={headingId}>
            {title}
          </h2>
          {subtitle ? <p className="panel-subtitle">{subtitle}</p> : null}
        </div>
        {meta ? <div className="panel-meta">{meta}</div> : null}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}
