# KhetPatch Architecture & NASA Data Provenance

## Runtime Architecture
- **Frontend**: React 19 + TypeScript + Tailwind CSS v4 + Leaflet + Recharts
- **Backend**: Express + TypeScript (`server.ts` + `server/`) with Zod validation, bcryptjs session auth, and persistent SQLite (`data/khetpatch.db`, WAL mode)
- **PostgreSQL / PostGIS Production Blueprint**: `supabase/migrations/001_initial_schema.sql` & `supabase/policies/002_rls_policies.sql`

## Live Data & Credential Transparency
| Provider | Endpoint / Product | Auth Required | Status |
|---|---|---|---|
| NASA POWER | `power.larc.nasa.gov/api/temporal/daily/point` | None | Live operational HTTP integration |
| NASA CMR Discovery | `cmr.earthdata.nasa.gov/search/granules.json` (GPM IMERG, SMAP L4, HLSL30) | None for granule discovery; `EARTHDATA_TOKEN` for HDF5/GeoTIFF subsetting | Live catalog discovery |
| Open-Meteo | `api.open-meteo.com/v1/forecast` | None | Live forecast & ET0 integration |
| IMD Weather & Warnings | `api.imd.gov.in` | `IMD_API_KEY` | Awaiting official IMD API credentials |
| AGMARKNET Mandi Prices | `api.data.gov.in` | `DATA_GOV_API_KEY` | Awaiting `DATA_GOV_API_KEY` (labeled `DEMO_DATA` shown for Kopargaon reference) |
| Gemini AI Assistant | `@google/genai` (`gemini-4-hydrogen`) | `GEMINI_API_KEY` | Server-side grounded explanation with deterministic fallback |

## Five Role Workspaces
1. `FARMER` -> `/farmer/home` (`FarmerLayout`)
2. `AGRONOMIST` -> `/workspace/dashboard` (`EnterpriseLayout`)
3. `FPO_MANAGER` -> `/organization/overview` (`OrganizationLayout`)
4. `ORGANIZATION_ADMIN` -> `/organization/admin` (`OrganizationAdminLayout`)
5. `PLATFORM_ADMIN` -> `/platform/admin` (`PlatformAdminLayout`)
