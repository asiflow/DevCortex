import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from './App';
import { makeDecision, makeFeature, makeReadyScore, makeRun } from './test/fixtures';
import { stubFetchByPath } from './test/helpers';

function stubAllEndpoints(): void {
  stubFetchByPath({
    '/api/health': { ok: true, root: '/Users/dev/devcortex', mode: 'passive', version: '0.1.0' },
    '/api/ready-score': makeReadyScore(),
    '/api/features': [makeFeature()],
    '/api/memory': [],
    '/api/architecture': { markdown: '# Architecture Map' },
    '/api/brief': { markdown: '# Project Brief' },
    '/api/runs': [makeRun()],
    '/api/decisions': [makeDecision()],
  });
}

describe('App', () => {
  it('renders the brand and every panel heading', async () => {
    stubAllEndpoints();
    render(<App />);

    expect(await screen.findByRole('heading', { level: 2, name: 'Ship-Readiness' })).toBeInTheDocument();
    const titles = [
      'Feature Ledger',
      'Architecture Map',
      'Risks & Known-Failures',
      'Recent Agent Runs',
      'Failed Checks',
      'Decision History',
      'Project Brief',
    ];
    for (const title of titles) {
      expect(screen.getByRole('heading', { level: 2, name: title })).toBeInTheDocument();
    }
  });

  it('exposes a skip link and a labelled main region', () => {
    stubAllEndpoints();
    render(<App />);
    expect(screen.getByRole('link', { name: /skip to dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole('main', { name: /project dashboard/i })).toBeInTheDocument();
  });
});
