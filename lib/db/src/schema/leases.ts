import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
  date,
  timestamp,
  boolean,
  pgEnum,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const leaseStatusEnum = pgEnum("lease_status", [
  "draft",
  "active",
  "expired",
]);

export const paymentFrequencyEnum = pgEnum("payment_frequency", [
  "monthly",
  "quarterly",
  "annually",
]);

export const scheduleStatusEnum = pgEnum("schedule_status", [
  "draft",
  "posted",
]);

export const leaseClassificationEnum = pgEnum("lease_classification", [
  "operating",
  "finance",
]);

export const paymentTimingEnum = pgEnum("payment_timing", [
  "advance",
  "arrears",
]);

export const leasesTable = pgTable("leases", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  lessor: text("lessor").notNull(),
  commencementDate: date("commencement_date").notNull(),
  termMonths: integer("term_months").notNull(),
  monthlyPayment: numeric("monthly_payment", { precision: 15, scale: 2 }).notNull(),
  presentValue: numeric("present_value", { precision: 15, scale: 2 }).notNull(),
  borrowingRate: numeric("borrowing_rate", { precision: 8, scale: 4 }).notNull(),
  rouAssetAccount: text("rou_asset_account"),
  leaseLiabilityAccount: text("lease_liability_account"),
  interestExpenseAccount: text("interest_expense_account"),
  amortizationExpenseAccount: text("amortization_expense_account"),
  cashAccount: text("cash_account"),
  paymentFrequency: paymentFrequencyEnum("payment_frequency").notNull().default("monthly"),
  leaseClassification: leaseClassificationEnum("lease_classification").notNull().default("operating"),
  paymentTiming: paymentTimingEnum("payment_timing").notNull().default("arrears"),
  isShortTerm: boolean("is_short_term").notNull().default(false),
  prepaidRent: numeric("prepaid_rent", { precision: 15, scale: 2 }).notNull().default("0"),
  initialDirectCosts: numeric("initial_direct_costs", { precision: 15, scale: 2 }).notNull().default("0"),
  leaseIncentives: numeric("lease_incentives", { precision: 15, scale: 2 }).notNull().default("0"),
  status: leaseStatusEnum("status").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const scheduleEntriesTable = pgTable("schedule_entries", {
  id: serial("id").primaryKey(),
  leaseId: integer("lease_id").notNull().references(() => leasesTable.id, { onDelete: "cascade" }),
  periodNumber: integer("period_number").notNull(),
  paymentDate: date("payment_date").notNull(),
  beginningBalance: numeric("beginning_balance", { precision: 15, scale: 2 }).notNull(),
  payment: numeric("payment", { precision: 15, scale: 2 }).notNull(),
  interest: numeric("interest", { precision: 15, scale: 2 }).notNull(),
  principal: numeric("principal", { precision: 15, scale: 2 }).notNull(),
  endingBalance: numeric("ending_balance", { precision: 15, scale: 2 }).notNull(),
  rouAmortization: numeric("rou_amortization", { precision: 15, scale: 2 }).notNull(),
  leaseExpense: numeric("lease_expense", { precision: 15, scale: 2 }).notNull().default("0"),
  status: scheduleStatusEnum("status").notNull().default("draft"),
});

export const journalEntryStatusEnum = pgEnum("journal_entry_status", [
  "posted",
  "reversed",
]);

/**
 * One journal entry per posted (or reversed) period. Multiple JEs can exist for
 * the same scheduleEntry across post→unpost→repost cycles, but only one will
 * have status="posted" at any time. The reversal of an entry is itself a new
 * "posted" JE with offsetting debits/credits, while the original is flipped to
 * "reversed".
 */
/**
 * QBO sync status for a journal entry. `null` (default) means not yet attempted
 * because no QBO connection exists. Once a connection is set up, posting flips
 * this to "pending" → "synced" or "failed". Sync failures don't roll back the
 * local post — the local close completes; QBO sync is best-effort.
 */
export const qboSyncStatusEnum = pgEnum("qbo_sync_status", [
  "pending",
  "syncing",
  "synced",
  "failed",
  "skipped",
]);

export const journalEntriesTable = pgTable("journal_entries", {
  id: serial("id").primaryKey(),
  leaseId: integer("lease_id").notNull().references(() => leasesTable.id, { onDelete: "cascade" }),
  scheduleEntryId: integer("schedule_entry_id").notNull().references(() => scheduleEntriesTable.id, { onDelete: "cascade" }),
  period: text("period").notNull(), // YYYY-MM
  postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
  status: journalEntryStatusEnum("status").notNull().default("posted"),
  idempotencyKey: text("idempotency_key").notNull(),
  reversesEntryId: integer("reverses_entry_id").references((): any => journalEntriesTable.id, { onDelete: "set null" }),
  memo: text("memo"),
  qboId: text("qbo_id"),                                                          // QBO JournalEntry.Id
  qboSyncToken: text("qbo_sync_token"),                                            // QBO optimistic-locking token
  qboSyncStatus: qboSyncStatusEnum("qbo_sync_status"),                             // null until attempted
  qboSyncError: text("qbo_sync_error"),                                            // last error message
  qboSyncedAt: timestamp("qbo_synced_at", { withTimezone: true }),
}, (t) => ({
  idempotencyKeyIdx: uniqueIndex("journal_entries_idempotency_key_idx").on(t.idempotencyKey),
}));

export const journalEntryLinesTable = pgTable("journal_entry_lines", {
  id: serial("id").primaryKey(),
  journalEntryId: integer("journal_entry_id").notNull().references(() => journalEntriesTable.id, { onDelete: "cascade" }),
  accountCode: text("account_code").notNull(),
  debit: numeric("debit", { precision: 15, scale: 2 }).notNull().default("0"),
  credit: numeric("credit", { precision: 15, scale: 2 }).notNull().default("0"),
  memo: text("memo"),
});

export type JournalEntry = typeof journalEntriesTable.$inferSelect;
export type JournalEntryLine = typeof journalEntryLinesTable.$inferSelect;

/**
 * Singleton settings row (always id=1). Stores tenant-wide preferences such as
 * fiscal year start month for YTD calculations.
 */
export const appSettingsTable = pgTable("app_settings", {
  id: serial("id").primaryKey(),
  fiscalYearStartMonth: integer("fiscal_year_start_month").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertLeaseSchema = createInsertSchema(leasesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertLease = z.infer<typeof insertLeaseSchema>;
export type Lease = typeof leasesTable.$inferSelect;

export const insertScheduleEntrySchema = createInsertSchema(scheduleEntriesTable).omit({
  id: true,
});
export type InsertScheduleEntry = z.infer<typeof insertScheduleEntrySchema>;
export type ScheduleEntry = typeof scheduleEntriesTable.$inferSelect;

export type AppSettings = typeof appSettingsTable.$inferSelect;

export const qboEnvironmentEnum = pgEnum("qbo_environment", [
  "sandbox",
  "production",
]);

/**
 * Singleton QBO connection (always id=1). Stores the OAuth tokens and the
 * QBO realm (company) the tokens are scoped to. Only one connection at a
 * time — connecting again replaces the existing row.
 *
 * Token lifecycles:
 *   - access token: ~1 hour
 *   - refresh token: 100 days, rotated on every refresh response
 */
export const qboConnectionsTable = pgTable("qbo_connections", {
  id: serial("id").primaryKey(),
  realmId: text("realm_id").notNull(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }).notNull(),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }).notNull(),
  environment: qboEnvironmentEnum("environment").notNull().default("sandbox"),
  scope: text("scope"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

/**
 * Cached QuickBooks Chart of Accounts. Refreshed on demand (the GET /qbo/accounts
 * endpoint repulls from QBO and upserts). The lease GL-account fields store the
 * QBO Account.Id (text) — a foreign-ish reference into this table when QBO is
 * connected. We keep `acctNum` and `name` for display.
 */
export const qboAccountsTable = pgTable("qbo_accounts", {
  id: serial("id").primaryKey(),
  realmId: text("realm_id").notNull(),
  qboId: text("qbo_id").notNull(),
  acctNum: text("acct_num"),
  name: text("name").notNull(),
  fullyQualifiedName: text("fully_qualified_name"),
  accountType: text("account_type"),
  accountSubType: text("account_sub_type"),
  classification: text("classification"),
  active: boolean("active").notNull().default(true),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  realmQboIdIdx: uniqueIndex("qbo_accounts_realm_qbo_id_idx").on(t.realmId, t.qboId),
}));

/**
 * Short-lived OAuth `state` values for CSRF protection. Created when the user
 * clicks "Connect QBO", consumed (deleted) by the callback. Old rows past
 * `expiresAt` are stale and rejected.
 */
export const qboOauthStatesTable = pgTable("qbo_oauth_states", {
  id: serial("id").primaryKey(),
  state: text("state").notNull().unique(),
  environment: qboEnvironmentEnum("environment").notNull().default("sandbox"),
  redirectUri: text("redirect_uri").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export type QboConnection = typeof qboConnectionsTable.$inferSelect;
export type QboAccount = typeof qboAccountsTable.$inferSelect;
