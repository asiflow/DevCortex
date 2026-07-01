import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Header } from './Header';
import { stubFetchOnce, stubFetchNetworkError } from '../test/helpers';

function noop(): void {
  /* intentionally empty */
}

describe('Header', () => {
  it('reports an offline connection when the daemon is unreachable', async () => {
    stubFetchNetworkError();
    render(
      <Header reloadKey={0} autoRefresh={false} onRefresh={noop} onToggleAutoRefresh={noop} />,
    );
    expect(await screen.findByText('Offline')).toBeInTheDocument();
  });

  it('shows the project name, mode and version when connected', async () => {
    stubFetchOnce({ ok: true, root: '/Users/dev/my-proj', mode: 'passive', version: '0.1.0' });
    render(
      <Header reloadKey={0} autoRefresh={false} onRefresh={noop} onToggleAutoRefresh={noop} />,
    );
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('my-proj')).toBeInTheDocument();
    expect(screen.getByText('Passive')).toBeInTheDocument();
    expect(screen.getByText('v0.1.0')).toBeInTheDocument();
  });

  it('reflects the auto-refresh state and toggles it on click', async () => {
    stubFetchOnce({ ok: true, root: '/repo', mode: 'guarded', version: '0.1.0' });
    const onToggle = vi.fn();
    render(
      <Header reloadKey={0} autoRefresh onRefresh={noop} onToggleAutoRefresh={onToggle} />,
    );
    const toggle = screen.getByRole('switch', { name: /auto-refresh/i });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('invokes onRefresh when the refresh button is pressed', async () => {
    stubFetchOnce({ ok: true, root: '/repo', mode: 'guarded', version: '0.1.0' });
    const onRefresh = vi.fn();
    render(
      <Header reloadKey={0} autoRefresh={false} onRefresh={onRefresh} onToggleAutoRefresh={noop} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
