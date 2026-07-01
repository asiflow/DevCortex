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

export function ProjectBriefPanel({ reloadKey }: PanelProps): JSX.Element {
  const { state, reload } = useResource(api.brief, '/api/brief', reloadKey);
  return (
    <Panel
      title="Project Brief"
      icon="brief"
      subtitle="The at-a-glance summary the agent reads first"
      span="span-6"
    >
      <AsyncBoundary
        state={state}
        onRetry={reload}
        isEmpty={(res: MarkdownResponse) => res.markdown.trim().length === 0}
        emptyTitle="No project brief"
        emptyHint="Run a project scan to generate .cortex/project.md."
        loadingRows={6}
      >
        {(res) => <Markdown source={res.markdown} className="md--scroll" />}
      </AsyncBoundary>
    </Panel>
  );
}
