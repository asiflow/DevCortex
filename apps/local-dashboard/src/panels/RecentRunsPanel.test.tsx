import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RecentRunsPanel } from './RecentRunsPanel';
import { makeRun } from '../test/fixtures';
import { stubFetchOnce, stubFetchHttpError, stubFetchPending } from '../test/helpers';

describe('RecentRunsPanel', () => {
  it('shows a loading state while fetching', () => {
    stubFetchPending();
    render(<RecentRunsPanel reloadKey={0} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows an error state on failure', async () => {
    stubFetchHttpError();
    render(<RecentRunsPanel reloadKey={0} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('shows an empty state when there are no runs', async () => {
    stubFetchOnce([]);
    render(<RecentRunsPanel reloadKey={0} />);
    expect(await screen.findByText(/no runs recorded/i)).toBeInTheDocument();
  });

  it('renders a run with its task, coverage chips and metrics', async () => {
    stubFetchOnce([makeRun()]);
    render(<RecentRunsPanel reloadKey={0} />);
    expect(await screen.findByText('Implement billing webhook')).toBeInTheDocument();
    expect(screen.getByText('Intent')).toBeInTheDocument();
    expect(screen.getByText('Plan')).toBeInTheDocument();
    expect(screen.getByText(/2 cmd · 3 evidence/)).toBeInTheDocument();
  });
});
