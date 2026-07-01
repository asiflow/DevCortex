import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DecisionHistoryPanel } from './DecisionHistoryPanel';
import { makeDecision } from '../test/fixtures';
import { stubFetchOnce, stubFetchHttpError, stubFetchPending } from '../test/helpers';

describe('DecisionHistoryPanel', () => {
  it('shows a loading state while fetching', () => {
    stubFetchPending();
    render(<DecisionHistoryPanel reloadKey={0} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows an error state on failure', async () => {
    stubFetchHttpError();
    render(<DecisionHistoryPanel reloadKey={0} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('shows an empty state when there are no decisions', async () => {
    stubFetchOnce([]);
    render(<DecisionHistoryPanel reloadKey={0} />);
    expect(await screen.findByText(/no decisions recorded/i)).toBeInTheDocument();
  });

  it('renders a decision with its chosen option and status', async () => {
    stubFetchOnce([makeDecision()]);
    render(<DecisionHistoryPanel reloadKey={0} />);
    expect(await screen.findByText('Adopt Zustand for client state')).toBeInTheDocument();
    expect(screen.getByText('Zustand')).toBeInTheDocument();
    expect(screen.getByText('Accepted')).toBeInTheDocument();
  });
});
