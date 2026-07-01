# @devcortex/local-dashboard

A single-page cockpit that visualizes a DevCortex project by reading the local
daemon's HTTP API. Dark, technical, evidence-focused — a refined engineering
dashboard, not a marketing page.

## How it is served

- **Production:** the DevCortex daemon serves the built `dist/` bundle at its own
  origin, so the app fetches the API with relative `/api/*` paths (same-origin).
- **Development:** `npm run dev` starts Vite on port 5173 and proxies `/api` to
  the daemon. Override the daemon target with `VITE_DEVCORTEX_DAEMON` when it is
  not on the default `http://127.0.0.1:4823`.
- **Cross-origin dev (optional):** set `VITE_DEVCORTEX_API` to the daemon origin
  to fetch it directly instead of through the proxy.

## Daemon API contract

All endpoints are JSON, under `http://127.0.0.1:<port>`, CORS-restricted to
localhost. Response shapes come from `@devcortex/core` (type-only imports — no
core runtime code ever enters the browser bundle).

| Endpoint | Shape |
| --- | --- |
| `GET /api/health` | `{ ok, root, mode, version }` |
| `GET /api/brief` | `{ markdown }` |
| `GET /api/architecture` | `{ markdown }` |
| `GET /api/graph` | `ProjectGraph` |
| `GET /api/features` | `FeatureRecord[]` |
| `GET /api/decisions` | `DecisionRecord[]` |
| `GET /api/memory` | `MemoryItem[]` |
| `GET /api/runs` | `RunRecord[]` |
| `GET /api/ship-reports` | `{ name, markdown }[]` |
| `GET /api/ready-score` | `{ score, status, passed, blocked, warnings }` |

## Panels

Ship-Readiness gauge · Failed Checks · Risks & Known-Failures · Feature Ledger ·
Architecture Map · Project Brief · Recent Agent Runs · Decision History.

Every panel independently handles its loading, error and empty states.

## Scripts

```bash
npm run dev        # Vite dev server + /api proxy
npm run build      # production build to dist/
npm run typecheck  # tsc --noEmit
npm run lint       # eslint src
npm run test       # vitest run
```
