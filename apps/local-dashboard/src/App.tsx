import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Header } from './components/Header';
import { ShipReadinessPanel } from './panels/ShipReadinessPanel';
import { FailedChecksPanel } from './panels/FailedChecksPanel';
import { RisksPanel } from './panels/RisksPanel';
import { FeatureLedgerPanel } from './panels/FeatureLedgerPanel';
import { ArchitectureMapPanel } from './panels/ArchitectureMapPanel';
import { ProjectBriefPanel } from './panels/ProjectBriefPanel';
import { RecentRunsPanel } from './panels/RecentRunsPanel';
import { DecisionHistoryPanel } from './panels/DecisionHistoryPanel';

const AUTO_REFRESH_MS = 20_000;

export function App(): JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);
  const toggleAutoRefresh = useCallback(() => setAutoRefresh((v) => !v), []);

  useEffect(() => {
    if (!autoRefresh) {
      return;
    }
    const id = window.setInterval(refresh, AUTO_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [autoRefresh, refresh]);

  return (
    <div className="app">
      <a className="skip-link" href="#dashboard-main">
        Skip to dashboard
      </a>
      <Header
        reloadKey={reloadKey}
        autoRefresh={autoRefresh}
        onRefresh={refresh}
        onToggleAutoRefresh={toggleAutoRefresh}
      />
      <main id="dashboard-main" className="dashboard-grid" aria-label="Project dashboard">
        <ShipReadinessPanel reloadKey={reloadKey} />
        <FailedChecksPanel reloadKey={reloadKey} />
        <RisksPanel reloadKey={reloadKey} />
        <FeatureLedgerPanel reloadKey={reloadKey} />
        <ArchitectureMapPanel reloadKey={reloadKey} />
        <ProjectBriefPanel reloadKey={reloadKey} />
        <RecentRunsPanel reloadKey={reloadKey} />
        <DecisionHistoryPanel reloadKey={reloadKey} />
      </main>
      <footer className="app-footer">
        <span>DevCortex · local cognition dashboard</span>
        <span className="mono">reads .cortex via the local daemon</span>
      </footer>
    </div>
  );
}
