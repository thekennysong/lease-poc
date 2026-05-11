/**
 * Reports any journal_entry_lines that reference placeholder GL accounts of
 * the form `UNASSIGNED-*`. These can only exist from data posted before the
 * post endpoint started rejecting unmapped leases — they should be fixed by
 * editing the lease's GL accounts and re-posting (after reversing the bad JE).
 *
 * Usage:  pnpm --filter @workspace/scripts run audit:unassigned-accounts
 *
 * Read-only. Does not auto-fix anything.
 */
import {
  db,
  pool,
  journalEntriesTable,
  journalEntryLinesTable,
  leasesTable,
} from "@workspace/db";
import { eq, like, sql } from "drizzle-orm";

async function main(): Promise<void> {
  const rows = await db
    .select({
      leaseId: leasesTable.id,
      leaseName: leasesTable.name,
      classification: leasesTable.leaseClassification,
      jeId: journalEntriesTable.id,
      period: journalEntriesTable.period,
      jeStatus: journalEntriesTable.status,
      accountCode: journalEntryLinesTable.accountCode,
    })
    .from(journalEntryLinesTable)
    .innerJoin(
      journalEntriesTable,
      eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id),
    )
    .innerJoin(leasesTable, eq(journalEntriesTable.leaseId, leasesTable.id))
    .where(like(journalEntryLinesTable.accountCode, "UNASSIGNED-%"))
    .orderBy(leasesTable.id, journalEntriesTable.id);

  if (rows.length === 0) {
    console.log("No journal entry lines reference UNASSIGNED-* accounts.");
    return;
  }

  console.log(`Found ${rows.length} line(s) on UNASSIGNED-* accounts:\n`);

  const byLease = new Map<number, typeof rows>();
  for (const r of rows) {
    const arr = byLease.get(r.leaseId) ?? [];
    arr.push(r);
    byLease.set(r.leaseId, arr);
  }

  for (const [leaseId, lineRows] of byLease) {
    const first = lineRows[0];
    console.log(`Lease #${leaseId} "${first.leaseName}" (${first.classification})`);
    const codes = [...new Set(lineRows.map((r) => r.accountCode))].sort();
    console.log(`  Placeholder codes: ${codes.join(", ")}`);
    const jes = [...new Set(lineRows.map((r) => `JE#${r.jeId} ${r.period} (${r.jeStatus})`))];
    console.log(`  Affected JEs: ${jes.join(", ")}\n`);
  }

  // Use sql tag so the linter doesn't complain about unused import in the
  // unlikely case the audit query is later swapped for a count query.
  void sql;
}

main()
  .catch((err) => {
    console.error("Audit failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
