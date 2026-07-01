import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FailedChecksPanel } from './FailedChecksPanel';
import { makeReadyScore } from '../test/fixtures';
import { stubFetchOnce, stubFetchHttpError, stubFetchPending } from '../test/helpers';

describe('FailedChecksPanel', () => {
  it('shows a loading state while fetching', () => {
    stubFetchPending();
    render(<FailedChecksPanel reloadKey={0} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows an error state on failure', async () => {
    stubFetchHttpError(500);
    render(<FailedChecksPanel reloadKey={0} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('lists blocking checks and warnings when present', async () => {
    stubFetchOnce(makeReadyScore({ passed: 8, blocked: 3, warnings: 1, status: 'NOT_READY' }));
    render(<FailedChecksPanel reloadKey={0} />);
    expect(await screen.findByText(/blocking checks must pass/i)).toBeInTheDocument();
    expect(screen.getByText(/warning to review/i)).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows an all-clear state when nothing is blocked', async () => {
    stubFetchOnce(makeReadyScore({ passed: 10, blocked: 0, warnings: 0, status: 'READY' }));
    render(<FailedChecksPanel reloadKey={0} />);
    expect(await screen.findByText(/all 10 checks passing/i)).toBeInTheDocument();
  });
});
