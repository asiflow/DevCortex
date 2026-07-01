import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProjectBriefPanel } from './ProjectBriefPanel';
import { stubFetchOnce, stubFetchHttpError, stubFetchPending } from '../test/helpers';

describe('ProjectBriefPanel', () => {
  it('shows a loading state while fetching', () => {
    stubFetchPending();
    render(<ProjectBriefPanel reloadKey={0} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows an error state on failure', async () => {
    stubFetchHttpError();
    render(<ProjectBriefPanel reloadKey={0} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('shows an empty state when the brief is blank', async () => {
    stubFetchOnce({ markdown: '' });
    render(<ProjectBriefPanel reloadKey={0} />);
    expect(await screen.findByText(/no project brief/i)).toBeInTheDocument();
  });

  it('renders the brief markdown on success', async () => {
    stubFetchOnce({ markdown: '# Project Brief\n\nStack: **nextjs**' });
    render(<ProjectBriefPanel reloadKey={0} />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Project Brief' }),
    ).toBeInTheDocument();
    expect(screen.getByText('nextjs').tagName).toBe('STRONG');
  });
});
