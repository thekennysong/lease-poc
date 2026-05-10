# Double — Lease Capitalization

A month-end close lease capitalization app for finance teams. Manages ASC 842 / IFRS 16 operating leases with auto-generated amortization schedules, live payment tracking, and posting workflows.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/lease-app run dev` — run the frontend (port 20888, preview at `/`)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite, Tailwind CSS, shadcn/ui, TanStack Query, Wouter
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- DB schema: `lib/db/src/schema/leases.ts`
- API contract: `lib/api-spec/openapi.yaml`
- Generated hooks: `lib/api-client-react/src/generated/api.ts`
- Generated Zod schemas: `lib/api-zod/src/generated/api.ts`
- API routes: `artifacts/api-server/src/routes/leases.ts`
- Amortization logic: `artifacts/api-server/src/lib/amortization.ts`
- Frontend pages: `artifacts/lease-app/src/pages/`

## Architecture decisions

- Amortization schedule is generated server-side on lease creation and stored in `schedule_entries` table. Draft entries can be posted period-by-period.
- Client-side schedule preview in the Add Lease modal is computed in-browser for instant feedback (same formula as server).
- Numeric DB columns use `numeric(15,2)` precision; converted to JS numbers in route handlers before sending to client.
- `borrowingRate` is stored as annual percentage (e.g. `5.5` for 5.5%). Monthly rate is derived as `rate / 100 / 12`.
- Summary stats (active count, YTD interest, outstanding liability) are computed at query time, not cached.
- `leaseClassification` is `"operating"` (default) or `"finance"`. Affects ROU amortization column in the schedule:
  - **Operating (ASC 842):** ROU amortization = straight-line total expense minus interest for each period. Total expense is constant; interest front-loads, so ROU amortization back-loads.
  - **Finance (ASC 842 / IFRS 16):** ROU amortization = PV / number of periods (straight-line depreciation of the asset independent of interest).
- `paymentFrequency` is `"monthly"` (default), `"quarterly"`, or `"annually"`. Affects period count, periodic rate, and date increments. The `monthlyPayment` field stores the per-period payment regardless of frequency name.
- Orval generates `z.coerce.date()` for OpenAPI `format: date` fields. Route handlers must call `toDateStr(d)` before inserting into Drizzle `date` columns (which expect `"YYYY-MM-DD"` strings).
- API errors are wrapped in `ApiError<T>` from `custom-fetch`. Access the server error message via `err.data?.error`, not `err.error`.

## Product

- Leases list with summary stat cards (active count, YTD interest, outstanding lease liability)
- Add/edit lease modal with live amortization schedule preview before saving
- Lease detail page with full schedule, draft/posted status per period
- Post payments through a selected period (marks draft → posted)
- Delete lease action

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- After spec changes, always run `pnpm --filter @workspace/api-spec run codegen` before using types
- `pnpm --filter @workspace/db run push` to apply schema changes to dev DB
- Numeric fields from Drizzle are returned as strings; use `parseFloat()` in route handlers
- The `schedule_entries` table cascades delete on lease removal

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
