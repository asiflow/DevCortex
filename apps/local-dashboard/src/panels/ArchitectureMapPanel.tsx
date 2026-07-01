import type { JSX } from 'react';
import { api } from '../api';
import type { MarkdownResponse } from '../api';
import { useResource } from '../hooks/useResource';
import { AsyncBoundary } from '../components/AsyncBoundary';
import { Panel } from '../components/Panel';
import { Markdown } from '../lib/markdown';

interface PanelProps {
  reloadKey: number;
}

export function ArchitectureMapPanel({ reloadKey }: PanelProps): JSX.Element {
  const { state, reload } = useResource(api.architecture, '/api/architecture', reloadKey);
  return (
    <Panel
      title="Architecture Map"
      icon="map"
      subtitle="Stack, surfaces and dependency hotspots"
      span="span-6"
    >
      <AsyncBoundary
        state={state}
        onRetry={reload}
        isEmpty={(res: MarkdownResponse) => res.markdown.trim().length === 0}
        emptyTitle="No architecture map"
        emptyHint="Run a project scan to generate .cortex/architecture.md."
        loadingRows={6}
      >
        {(res) => <Markdown source={res.markdown} className="md--scroll" />}
      </AsyncBoundary>
    </Panel>
  );
}
