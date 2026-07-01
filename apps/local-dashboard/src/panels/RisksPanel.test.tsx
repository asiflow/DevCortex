import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RisksPanel } from './RisksPanel';
import { makeFeature, makeMemory } from '../test/fixtures';
import { stubFetchByPath, stubFetchHttpError, stubFetchPending } from '../test/helpers';

describe('RisksPanel', () => {
  it('shows a loading state while fetching', () => {
    stubFetchPending();
    render(<RisksPanel reloadKey={0} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows an error state when either source fails', async () => {
    stubFetchHttpError();
    render(<RisksPanel reloadKey={0} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('shows an empty state when there are no risks', async () => {
    stubFetchByPath({ '/api/memory': [], '/api/features': [] });
    render(<RisksPanel reloadKey={0} />);
    expect(await screen.findByText(/no open risks/i)).toBeInTheDocument();
  });

  it('aggregates memory risks and feature known-failures', async () => {
    stubFetchByPath({
      '/api/memory': [makeMemory()],
      '/api/features': [makeFeature()],
    });
    render(<RisksPanel reloadKey={0} />);
    expect(
      await screen.findByText('Stripe webhook signature not verified in dev'),
    ).toBeInTheDocument();
    expect(screen.getByText('token rotation not covered')).toBeInTheDocument();
    expect(screen.getByText('Known failure')).toBeInTheDocument();
  });
});
