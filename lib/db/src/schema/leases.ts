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
