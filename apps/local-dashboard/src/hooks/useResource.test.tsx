import type { JSX } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useResource } from './useResource';

function Probe({
  fetcher,
}: {
  fetcher: (o: { signal: AbortSignal }) => Promise<string>;
}): JSX.Element {
  const { state, reload } = useResource(fetcher, '/api/probe', 0);
  return (
    <div>
      <span data-testid="status">{state.status}</span>
      {state.status === 'success' ? <span data-testid="data">{state.data}</span> : null}
      {state.status === 'error' ? <span data-testid="error">{state.error.message}</span> : null}
      <button type="button" onClick={reload}>
        reload
      </button>
    </div>
  );
}

describe('useResource', () => {
  it('resolves to a success state with the fetched data', async () => {
    render(<Probe fetcher={() => Promise.resolve('payload')} />);
    expect(await screen.findByTestId('data')).toHaveTextContent('payload');
    expect(screen.getByTestId('status')).toHaveTextContent('success');
  });

  it('captures a rejection as an error state', async () => {
    render(<Probe fetcher={() => Promise.reject(new Error('kaboom'))} />);
    expect(await screen.findByTestId('error')).toHaveTextContent('kaboom');
  });

  it('re-runs the fetcher when reload is invoked', async () => {
    let count = 0;
    const fetcher = (): Promise<string> => {
      count += 1;
      return Promise.resolve(`call-${count}`);
    };
    render(<Probe fetcher={fetcher} />);
    expect(await screen.findByTestId('data')).toHaveTextContent('call-1');

    fireEvent.click(screen.getByRole('button', { name: 'reload' }));
    expect(await screen.findByText('call-2')).toBeInTheDocument();
  });
});
