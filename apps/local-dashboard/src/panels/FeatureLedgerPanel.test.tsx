import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FeatureLedgerPanel } from './FeatureLedgerPanel';
import { makeFeature } from '../test/fixtures';
import { stubFetchOnce, stubFetchHttpError, stubFetchPending } from '../test/helpers';

describe('FeatureLedgerPanel', () => {
  it('shows a loading state while fetching', () => {
    stubFetchPending();
    render(<FeatureLedgerPanel reloadKey={0} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows an error state on failure', async () => {
    stubFetchHttpError();
    render(<FeatureLedgerPanel reloadKey={0} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('shows an empty state when there are no features', async () => {
    stubFetchOnce([]);
    render(<FeatureLedgerPanel reloadKey={0} />);
    expect(await screen.findByText(/no features tracked yet/i)).toBeInTheDocument();
  });

  it('renders a feature row with status, surface count and evidence ratio', async () => {
    stubFetchOnce([makeFeature()]);
    render(<FeatureLedgerPanel reloadKey={0} />);
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Passwordless auth')).toBeInTheDocument();
    expect(screen.getByText('Shipped')).toBeInTheDocument();
    // 1 route + 1 component + 1 api + 1 table = 4 surfaces
    expect(screen.getByText('4')).toBeInTheDocument();
    // 1 of 2 evidence items verified
    expect(screen.getByText('1/2')).toBeInTheDocument();
  });
});
