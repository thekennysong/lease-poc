/**
 * One-shot backfill for schedule_entries.lease_expense.
 *
 * Run after pushing the lease_expense column. For each row where lease_expense
 * is still 0 (the column default), set it to interest + rou_amortization.
 * That equality holds for all pre-existing rows by construction of the
 * generator, regardless of classification:
 *   - operating: rouAmort = SLE − interest, so interest + rouAmort = SLE
 *   - finance:   rouAmort = openingROU/n,  so interest + rouAmort = period P&L
 *
 * Usage:  pnpm --filter @workspace/scripts run backfill:lease-expense
 *
 * Idempotent: re-running on already-backfilled rows is a no-op because the
 * filter restricts to rows where lease_expense = 0.
 */
import { db, pool, scheduleEntriesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

async function main(): Promise<void> {
  const before = await db
    .select({ id: scheduleEntriesTable.id })
    .from(scheduleEntriesTable)
    .where(eq(scheduleEntriesTable.leaseExpense, "0"));

  console.log(`Rows with lease_expense=0: ${before.length}`);

  if (before.length === 0) {
    console.log("Nothing to backfill.");
    return;
  }

  const result = await db.execute(sql`
    UPDATE ${scheduleEntriesTable}
    SET lease_expense = ROUND((interest + rou_amortization)::numeric, 2)
    WHERE lease_expense = '0'
  `);

  console.log(`Backfilled ${result.rowCount ?? "?"} rows.`);
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
