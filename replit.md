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

- DB schema: `lib/db/src/schema/leases.ts` (includes `appSettingsTable` singleton)
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
  - **Operating (ASC 842):** ROU amortization = straight-line total expense minus interest for each period. Total expense includes opening ROU adjustments: `(sumPayments + prepaid + IDC − incentives) / numPeriods`. Interest front-loads, so ROU amortization back-loads.
  - **Finance (ASC 842 / IFRS 16):** ROU amortization = openingROU / number of periods (straight-line depreciation of the asset independent of interest).
- `paymentFrequency` is `"monthly"` (default), `"quarterly"`, or `"annually"`. Affects period count, periodic rate, and date increments. The `monthlyPayment` field stores the per-period payment regardless of frequency name.
- `paymentTiming` is `"arrears"` (default — period-end, ordinary annuity) or `"advance"` (period-start, annuity-due). For `"advance"`: period 1 has zero interest (payment hits at t=0 before any time passes) and the first payment date equals the commencement date; subsequent periods accrue normally. The client-side PV preview multiplies the ordinary-annuity formula by `(1 + r)` for `"advance"`.
- `isShortTerm` is the ASC 842 § 842-20-25-2 short-term lease election. Only allowed when `termMonths ≤ 12`; the API rejects with 400 otherwise. When true, **no schedule is generated, no ROU/liability is recorded**, and the lease is excluded from the outstanding-liability rollup. The detail page renders an explanatory note in place of the schedule and hides the Post Payments button.
- Opening ROU adjustments — `prepaidRent`, `initialDirectCosts`, `leaseIncentives` (all `numeric(15,2)` defaulting to `"0"`). Computed `openingRouAsset = presentValue + prepaidRent + initialDirectCosts − leaseIncentives` is returned on `Lease` and `LeaseWithSchedule`. Lease liability stays at `presentValue`. Affects schedule: finance ROU/period uses opening ROU; operating SLE includes adjustments in `totalLeaseCost`. Surfaced in the modal under an "Advanced — Opening ROU Adjustments" collapsible.
- Fiscal-year YTD — `appSettingsTable` is a single-row table with `fiscalYearStartMonth` (default 1 = January). `GET /leases/summary` accepts `?fiscalYearStartMonth=N` (1-12) to override; otherwise reads the settings row, otherwise defaults to 1. The YTD window is computed by `fiscalYearWindow(now, startMonth)` which rolls back to the prior calendar year when `now` is before the start month.
- N+1 fix in `/leases/summary` — outstanding liability is computed with a single `SELECT DISTINCT ON (lease_id) ...` raw SQL query that returns the latest posted ending balance per lease, then joined in-memory against the leases list. Short-term leases are skipped. The YTD interest query also INNER JOINs `leases` and filters `isShortTerm = false`.
- Toggling `isShortTerm` on PUT wipes **all** schedule rows for that lease (posted included) before regenerating, because the election fundamentally changes whether a schedule should exist. Other regeneration triggers (payment, rate, term, etc.) only clear drafts. Short-term eligibility (`termMonths ≤ 12`) is validated against the merged current+incoming state **before** the UPDATE runs, so an invalid combination is never persisted.
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
