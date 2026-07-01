import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ArchitectureMapPanel } from './ArchitectureMapPanel';
import { stubFetchOnce, stubFetchHttpError, stubFetchPending } from '../test/helpers';

describe('ArchitectureMapPanel', () => {
  it('shows a loading state while fetching', () => {
    stubFetchPending();
    render(<ArchitectureMapPanel reloadKey={0} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows an error state on failure', async () => {
    stubFetchHttpError();
    render(<ArchitectureMapPanel reloadKey={0} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('shows an empty state when the map is blank', async () => {
    stubFetchOnce({ markdown: '   ' });
    render(<ArchitectureMapPanel reloadKey={0} />);
    expect(await screen.findByText(/no architecture map/i)).toBeInTheDocument();
  });

  it('renders the architecture markdown on success', async () => {
    stubFetchOnce({ markdown: '# Architecture Map\n\n## Stack\n\n- nextjs' });
    render(<ArchitectureMapPanel reloadKey={0} />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Architecture Map' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Stack' })).toBeInTheDocument();
  });
});
