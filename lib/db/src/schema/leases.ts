import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
  date,
  timestamp,
  pgEnum,
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
