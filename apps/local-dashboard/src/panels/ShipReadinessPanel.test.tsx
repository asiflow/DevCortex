import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ShipReadinessPanel } from './ShipReadinessPanel';
import { makeReadyScore } from '../test/fixtures';
import { stubFetchOnce, stubFetchHttpError, stubFetchPending } from '../test/helpers';

describe('ShipReadinessPanel', () => {
  it('shows a loading state while fetching', () => {
    stubFetchPending();
    render(<ShipReadinessPanel reloadKey={0} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows an error state with a retry action on failure', async () => {
    stubFetchHttpError();
    render(<ShipReadinessPanel reloadKey={0} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('renders the gauge, score and status on success', async () => {
    stubFetchOnce(makeReadyScore({ score: 95, status: 'READY', passed: 12, blocked: 0, warnings: 0 }));
    render(<ShipReadinessPanel reloadKey={0} />);
    expect(
      await screen.findByRole('img', { name: /ship-readiness score 95 out of 100/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('95')).toBeInTheDocument();
    expect(screen.getByText('Passed')).toBeInTheDocument();
  });

  it('notes when no gate checks have run yet', async () => {
    stubFetchOnce(makeReadyScore({ score: 0, status: 'NOT_READY', passed: 0, blocked: 0, warnings: 0 }));
    render(<ShipReadinessPanel reloadKey={0} />);
    expect(await screen.findByText(/no gate checks recorded yet/i)).toBeInTheDocument();
  });
});
