import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Markdown, parseBlocks } from './markdown';

describe('parseBlocks', () => {
  it('parses headings, lists, code fences and rules', () => {
    const blocks = parseBlocks(
      ['# Title', '', 'Para line', '', '- one', '- two', '', '```ts', 'const x = 1;', '```', '', '---'].join('\n'),
    );
    const kinds = blocks.map((b) => b.kind);
    expect(kinds).toEqual(['heading', 'paragraph', 'ul', 'code', 'hr']);
  });

  it('clamps heading levels to 1..6', () => {
    const [block] = parseBlocks('####### too deep');
    expect(block?.kind).toBe('heading');
    if (block?.kind === 'heading') {
      expect(block.level).toBe(6);
    }
  });
});

describe('Markdown component', () => {
  it('renders headings and emphasis as real elements', () => {
    render(<Markdown source={'# Hello\n\nThis is **bold** and `code`.'} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Hello' })).toBeInTheDocument();
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('code').tagName).toBe('CODE');
  });

  it('renders safe links but strips dangerous protocols', () => {
    render(
      <Markdown source={'[safe](https://example.com) and [xss](javascript:alert(1))'} />,
    );
    const safe = screen.getByRole('link', { name: 'safe' });
    expect(safe).toHaveAttribute('href', 'https://example.com');
    expect(safe).toHaveAttribute('rel', expect.stringContaining('noopener'));
    // The javascript: link must not become an anchor.
    expect(screen.queryByRole('link', { name: 'xss' })).not.toBeInTheDocument();
    expect(screen.getByText('xss')).toBeInTheDocument();
  });

  it('renders list items', () => {
    render(<Markdown source={'- alpha\n- beta\n- gamma'} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });
});
