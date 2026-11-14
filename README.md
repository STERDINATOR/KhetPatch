# KhetPatch — NASA-Powered Agricultural Intelligence & Crop Rotation Platform

KhetPatch is a full-stack agricultural planning and advisory platform combining live NASA Earth-observation telemetry, Indian agroclimatic zone mapping, deterministic multi-strategy crop-rotation optimization, event-driven agronomic follow-ups, and multi-role RBAC workspaces.

## Core Architecture

- **Frontend**: React 19 + TypeScript + Tailwind CSS + Vite + Leaflet / Google Maps JS API
- **Backend**: Express + TypeScript (`server.ts`, `/server/routes/api.ts`) + SQLite (`better-sqlite3` with WAL mode and idempotent schema migrations)
- **Authentication & Cloud Sync**: Server-side HTTP-only session authentication + Firebase Auth & Cloud Firestore client/rules integration (`firestore.rules`)
- **AI Agronomic Assistant**: Server-side `@google/genai` (`gemini-4-hydrogen`) grounded strictly on persisted SQLite field, soil, weather, NASA, and 3-strategy solver context, with deterministic evidence-grounded fallback when `GEMINI_API_KEY` is not set.

## Live Data Sources & Honest Missing-Data Policy

KhetPatch explicitly separates live retrieved records, demo seed data, and missing inputs:

| Source | Endpoint / Method | Status Without Optional Keys |
|---|---|---|
| **NASA POWER** | Live Agroclimatology REST API (`T2M`, `PRECTOTCORR`, `ET0`, `ALLSKY_SFC_SW_DWN`, `RH2M`) | Live public API (no key required) |
| **NASA GPM IMERG** | CMR STAC / metadata discovery for precipitation granules | Live metadata search; binary data granules require `EARTHDATA_TOKEN` |
| **NASA SMAP L4** | CMR STAC / metadata discovery for surface & root-zone soil moisture | Live metadata search; binary data granules require `EARTHDATA_TOKEN` |
| **NASA / USGS Landsat & HLS** | CMR STAC / metadata search for optical scene & cloud-cover availability | Live scene discovery; pixel NDVI extraction requires `EARTHDATA_TOKEN` |
| **NASA GIBS** | WMTS tile overlay on field maps | Visual basemap overlay only (explicitly separated from numeric analysis) |
| **Open-Meteo** | Live 7-day forecast & recent weather fallback | Live public API (no key required) |
| **OpenStreetMap Nominatim** | Live Indian village/district geocoding combined with local agroclimatic directory | Live public API |
| **IMD / AGMARKNET / Soil Health Card** | Optional credentialed external providers | Explicitly marked `"Awaiting credentials"` or `"Missing"` when unconfigured; never fabricated |

## Deterministic 3-Strategy Crop Rotation Solver

Every rotation analysis (`server/intelligence/cropRotationEngine.ts`) evaluates crops across hard constraints (season, sowing month vs `targetPlantingDate`, total budget vs `fieldAreaAcres`, water availability vs crop water need, avoid-list exclusion) and produces three distinct strategies:

1. **MINIMAL_CHANGE**: Low-disruption seasonal option prioritizing continuity, budget fit, and low input shock.
2. **BALANCED_INCOME**: Optimizes net seasonal profit per acre while respecting soil fertility, NPK, and agroclimatic zone fit.
3. **CONSERVATION_SOIL**: Prioritizes legume/family rotation diversity, organic carbon restoration, and water efficiency.

Each strategy reports itemized input `costBreakdown`, expected yield & revenue ranges, assumption disclosures, and explicit `missingInformation` items whenever soil lab data, Earthdata NDVI, or mandi prices are absent.

## Event-Driven Follow-Up Engine & Background Worker

- **Plan Approval**: Approving a strategy activates crop-specific agronomic tasks idempotently (linked via `idempotency_key`).
- **Task Completion / Postponement**: Completing or postponing a task writes timeline events and updates future dependency windows.
- **Weather Risk Triggers**: Heavy rainfall (`>= 35 mm/day`) or extreme heat (`>= 39°C`) creates traceable weather-review tasks, notifications, and flags active `DRAFT`/`APPROVED` plans for reassessment.
- **Background Scheduler**: Runs periodic weather risk & overdue task checks (`processOverdueTasks` marks past-due `UPCOMING` tasks `OVERDUE` with idempotent `TASK_OVERDUE` notifications). Skipped automatically during `NODE_ENV=test`.

## Role-Based Access Control (5 Roles)

- `FARMER`: Isolated farm/field workspace, requirements, 3-strategy planner, follow-up tasks, and field diary.
- `AGRONOMIST`: Inspects field soil/NASA evidence and 3-strategy constraints before approving or requesting revision on organization plans.
- `FPO_MANAGER`: Cluster-wide FPO advisory oversight, crop distribution, and input aggregation.
- `ORGANIZATION_ADMIN`: Organization management, member invitations, and farmer-org assignment.
- `PLATFORM_ADMIN`: Provider connection verification (`POST /api/v1/platform/providers/:sourceId/test`), crop catalogue status, and audit logs — strictly restricted from reading unowned private farmer records.

## Environment Variables

See `.env.example` for supported keys:
- `PORT` (default `3000`)
- `APP_ENV` (`development` | `production`)
- `GEMINI_API_KEY` (optional; enables `gemini-4-hydrogen` server-side agronomic chat)
- `EARTHDATA_TOKEN` (optional; enables authenticated NASA Earthdata granule downloads)
- `IMD_API_KEY` / `DATA_GOV_API_KEY` (optional; enables IMD warnings and AGMARKNET mandi sync)
- `VITE_GOOGLE_MAPS_API_KEY` (optional; enables Google Maps basemap alongside Leaflet fallback)

## Local Setup & Verification

```bash
npm install
npm run dev          # Starts Express + Vite dev server on http://localhost:3000
npm run build        # Builds production Vite client bundle
npm run lint         # TypeScript check (tsc --noEmit)

# Unit tests & Firestore security rules tests
npx --yes tsx --test server/tests/khetpatch.test.ts
npx --yes tsx --test firestore.rules.test.ts
npx eslint firestore.rules src/lib/firebase.ts
```

Before deploying to Firebase, review `firestore.rules` in the Firebase Console to confirm the active project rules match your deployment requirements.
