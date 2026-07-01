// A deliberately small, safe markdown renderer.
//
// Why hand-rolled: the dashboard ships with react + react-dom only. Rather than
// pull in a markdown library (and its HTML-sanitisation surface), we parse the
// subset that .cortex/project.md and .cortex/architecture.md actually use into
// React elements. Because output is built from typed React nodes — never
// dangerouslySetInnerHTML — untrusted content cannot inject markup.

import type { JSX, ReactNode } from 'react';
import { Fragment } from 'react';

type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'hr' };

// Accept any run of leading `#`; levels beyond 6 clamp to 6 (see clampLevel).
const HEADING_RE = /^(#+)\s+(.*)$/;
const UL_RE = /^\s*[-*+]\s+(.*)$/;
const OL_RE = /^\s*\d+[.)]\s+(.*)$/;
const HR_RE = /^\s*([-*_])\1{2,}\s*$/;
const FENCE_RE = /^\s*```(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;

function clampLevel(hashes: string): 1 | 2 | 3 | 4 | 5 | 6 {
  switch (hashes.length) {
    case 1:
      return 1;
    case 2:
      return 2;
    case 3:
      return 3;
    case 4:
      return 4;
    case 5:
      return 5;
    default:
      return 6;
  }
}

/** Parse a markdown document into a flat list of blocks. */
export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Fenced code block.
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const lang = (fence[1] ?? '').trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // consume closing fence (or EOF)
      blocks.push({ kind: 'code', lang, code: body.join('\n') });
      continue;
    }

    // Blank line — separates blocks.
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // Horizontal rule.
    if (HR_RE.test(line)) {
      blocks.push({ kind: 'hr' });
      i += 1;
      continue;
    }

    // Heading.
    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: clampLevel(heading[1] ?? '#'),
        text: (heading[2] ?? '').trim(),
      });
      i += 1;
      continue;
    }

    // Blockquote (consecutive `>` lines).
    if (QUOTE_RE.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i] ?? '')) {
        const m = QUOTE_RE.exec(lines[i] ?? '');
        quoteLines.push(m?.[1] ?? '');
        i += 1;
      }
      blocks.push({ kind: 'quote', lines: quoteLines });
      continue;
    }

    // Unordered list.
    if (UL_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && UL_RE.test(lines[i] ?? '')) {
        const m = UL_RE.exec(lines[i] ?? '');
        items.push((m?.[1] ?? '').trim());
        i += 1;
      }
      blocks.push({ kind: 'ul', items });
      continue;
    }

    // Ordered list.
    if (OL_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && OL_RE.test(lines[i] ?? '')) {
        const m = OL_RE.exec(lines[i] ?? '');
        items.push((m?.[1] ?? '').trim());
        i += 1;
      }
      blocks.push({ kind: 'ol', items });
      continue;
    }

    // Paragraph — gather until a blank line or a structural line.
    const paragraph: string[] = [];
    while (i < lines.length) {
      const cur = lines[i] ?? '';
      if (
        cur.trim() === '' ||
        HEADING_RE.test(cur) ||
        UL_RE.test(cur) ||
        OL_RE.test(cur) ||
        HR_RE.test(cur) ||
        QUOTE_RE.test(cur) ||
        FENCE_RE.test(cur)
      ) {
        break;
      }
      paragraph.push(cur.trim());
      i += 1;
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
  }

  return blocks;
}

// --- inline rendering -------------------------------------------------------

const INLINE_RE = /(`[^`]+`)|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
const SAFE_HREF_RE = /^(https?:\/\/|mailto:|\/|#)/i;

function renderLink(token: string, key: string): ReactNode {
  const match = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
  const label = match?.[1] ?? token;
  const href = match?.[2] ?? '';
  if (!SAFE_HREF_RE.test(href)) {
    // Dangerous protocol (javascript:, data:, …): drop the anchor entirely and
    // render only the visible label — in a span so it stays a discrete element.
    return <span key={key}>{label}</span>;
  }
  return (
    <a key={key} href={href} target="_blank" rel="noreferrer noopener">
      {label}
    </a>
  );
}

/** Render inline emphasis / code / links inside a single text run. */
export function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let seq = 0;
  INLINE_RE.lastIndex = 0;

  let match: RegExpExecArray | null = INLINE_RE.exec(text);
  while (match !== null) {
    const start = match.index;
    if (start > lastIndex) {
      nodes.push(
        <Fragment key={`${keyPrefix}-t${seq}`}>{text.slice(lastIndex, start)}</Fragment>,
      );
      seq += 1;
    }

    const [, codeTok, linkTok, boldTok, italicTok] = match;
    const key = `${keyPrefix}-m${seq}`;
    if (codeTok !== undefined) {
      nodes.push(<code key={key}>{codeTok.slice(1, -1)}</code>);
    } else if (linkTok !== undefined) {
      nodes.push(renderLink(linkTok, key));
    } else if (boldTok !== undefined) {
      nodes.push(<strong key={key}>{boldTok.slice(2, -2)}</strong>);
    } else if (italicTok !== undefined) {
      nodes.push(<em key={key}>{italicTok.slice(1, -1)}</em>);
    }
    seq += 1;

    const matched = match[0] ?? '';
    lastIndex = start + matched.length;
    match = INLINE_RE.exec(text);
  }

  if (lastIndex < text.length) {
    nodes.push(<Fragment key={`${keyPrefix}-t${seq}`}>{text.slice(lastIndex)}</Fragment>);
  }
  return nodes;
}

// --- block rendering --------------------------------------------------------

const HEADING_TAGS = {
  1: 'h1',
  2: 'h2',
  3: 'h3',
  4: 'h4',
  5: 'h5',
  6: 'h6',
} as const;

function renderBlock(block: Block, key: string): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const Tag = HEADING_TAGS[block.level];
      return <Tag key={key}>{renderInline(block.text, key)}</Tag>;
    }
    case 'paragraph':
      return <p key={key}>{renderInline(block.text, key)}</p>;
    case 'ul':
      return (
        <ul key={key}>
          {block.items.map((item, idx) => (
            <li key={`${key}-i${idx}`}>{renderInline(item, `${key}-i${idx}`)}</li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol key={key}>
          {block.items.map((item, idx) => (
            <li key={`${key}-i${idx}`}>{renderInline(item, `${key}-i${idx}`)}</li>
          ))}
        </ol>
      );
    case 'code':
      return (
        <pre key={key} className="md-code" data-lang={block.lang || undefined}>
          <code>{block.code}</code>
        </pre>
      );
    case 'quote':
      return (
        <blockquote key={key}>
          {block.lines.map((ln, idx) => (
            <p key={`${key}-q${idx}`}>{renderInline(ln, `${key}-q${idx}`)}</p>
          ))}
        </blockquote>
      );
    case 'hr':
      return <hr key={key} />;
    default: {
      // Exhaustiveness guard — unreachable, but keeps the switch total.
      const _never: never = block;
      return _never;
    }
  }
}

export interface MarkdownProps {
  source: string;
  className?: string;
}

/** Render a trusted-subset markdown string as sanitised React elements. */
export function Markdown({ source, className }: MarkdownProps): JSX.Element {
  const blocks = parseBlocks(source);
  return (
    <div className={className ? `md ${className}` : 'md'}>
      {blocks.map((block, idx) => renderBlock(block, `b${idx}`))}
    </div>
  );
}
