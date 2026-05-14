import { Router, type IRouter } from "express";
import { eq, and, lte, gte, asc, sql, inArray } from "drizzle-orm";
import {
  db,
  leasesTable,
  scheduleEntriesTable,
  appSettingsTable,
  journalEntriesTable,
  journalEntryLinesTable,
} from "@workspace/db";
import {
  CreateLeaseBody,
  UpdateLeaseBody,
  GetLeaseParams,
  UpdateLeaseParams,
  DeleteLeaseParams,
  GetLeaseScheduleParams,
  PostLeasePaymentsParams,
  PostLeasePaymentsBody,
  UnpostLeasePaymentParams,
  GetLeaseJournalEntriesParams,
  GetLeasesSummaryQueryParams,
} from "@workspace/api-zod";
import {
  generateSchedule,
  computeOpeningRou,
  type PaymentFrequency,
  type LeaseClassification,
  type PaymentTiming,
} from "../lib/amortization";
import {
  buildJournalLines,
  reverseLines,
  assertBalanced,
  periodLabelFromDate,
  validateAccountsForPost,
} from "../lib/journal";
import {
  ensureValidConnection,
  getConnection,
  pushJournalEntry,
  deleteJournalEntry,
} from "../lib/qbo";

const router: IRouter = Router();

function toNumber(v: string | null | undefined): number {
  return v == null ? 0 : parseFloat(v);
}

/** Drizzle date columns require "YYYY-MM-DD" strings; Zod coerces format:date to Date objects. */
function toDateStr(d: Date | string): string {
  if (d instanceof Date) return d.toISOString().split("T")[0];
  return d;
}

function mapLease(lease: typeof leasesTable.$inferSelect) {
  const presentValue = toNumber(lease.presentValue);
  const prepaidRent = toNumber(lease.prepaidRent);
  const initialDirectCosts = toNumber(lease.initialDirectCosts);
  const leaseIncentives = toNumber(lease.leaseIncentives);
  return {
    id: lease.id,
    name: lease.name,
    lessor: lease.lessor,
    commencementDate: lease.commencementDate,
    termMonths: lease.termMonths,
    monthlyPayment: toNumber(lease.monthlyPayment),
    presentValue,
    borrowingRate: toNumber(lease.borrowingRate),
    leaseClassification: lease.leaseClassification,
    rouAssetAccount: lease.rouAssetAccount,
    leaseLiabilityAccount: lease.leaseLiabilityAccount,
    interestExpenseAccount: lease.interestExpenseAccount,
    amortizationExpenseAccount: lease.amortizationExpenseAccount,
    cashAccount: lease.cashAccount,
    paymentFrequency: lease.paymentFrequency,
    paymentTiming: lease.paymentTiming,
    isShortTerm: lease.isShortTerm,
    prepaidRent,
    initialDirectCosts,
    leaseIncentives,
    openingRouAsset: computeOpeningRou(presentValue, {
      prepaidRent,
      initialDirectCosts,
      leaseIncentives,
    }),
    status: lease.status,
    createdAt: lease.createdAt.toISOString(),
    currentBalance: null as number | null,
    nextPayment: null as number | null,
    nextPaymentDate: null as string | null,
  };
}

async function attachScheduleSummary(leaseId: number, mapped: ReturnType<typeof mapLease>) {
  const entries = await db
    .select()
    .from(scheduleEntriesTable)
    .where(eq(scheduleEntriesTable.leaseId, leaseId))
    .orderBy(scheduleEntriesTable.periodNumber);

  if (entries.length > 0) {
    const lastPosted = [...entries].reverse().find((e) => e.status === "posted");
    const firstDraft = entries.find((e) => e.status === "draft");

    if (lastPosted) {
      mapped.currentBalance = toNumber(lastPosted.endingBalance);
    } else {
      mapped.currentBalance = toNumber(entries[0].beginningBalance);
    }

    if (firstDraft) {
      mapped.nextPayment = toNumber(firstDraft.payment);
      mapped.nextPaymentDate = firstDraft.paymentDate;
    }
  }

  return mapped;
}

function buildScheduleRows(lease: typeof leasesTable.$inferSelect) {
  return generateSchedule(
    toNumber(lease.presentValue),
    toNumber(lease.monthlyPayment),
    toNumber(lease.borrowingRate),
    lease.termMonths,
    lease.commencementDate,
    lease.paymentFrequency as PaymentFrequency,
    lease.leaseClassification as LeaseClassification,
    lease.paymentTiming as PaymentTiming,
    {
      prepaidRent: toNumber(lease.prepaidRent),
      initialDirectCosts: toNumber(lease.initialDirectCosts),
      leaseIncentives: toNumber(lease.leaseIncentives),
    },
  );
}

/** Read fiscal year start month — query param overrides app_settings; both default to 1. */
async function resolveFiscalYearStartMonth(override?: number): Promise<number> {
  if (override != null && override >= 1 && override <= 12) return override;
  const [row] = await db.select().from(appSettingsTable).limit(1);
  return row?.fiscalYearStartMonth ?? 1;
}

/** Compute fiscal-year window enclosing `now`, given start month (1-12). */
function fiscalYearWindow(now: Date, startMonth: number): { start: string; end: string } {
  const year = now.getMonth() + 1 >= startMonth ? now.getFullYear() : now.getFullYear() - 1;
  const startDate = new Date(Date.UTC(year, startMonth - 1, 1));
  const endDate = new Date(Date.UTC(year + 1, startMonth - 1, 1));
  endDate.setUTCDate(endDate.getUTCDate() - 1);
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  return { start: fmt(startDate), end: fmt(endDate) };
}

// GET /leases
router.get("/leases", async (req, res): Promise<void> => {
  const leases = await db.select().from(leasesTable).orderBy(leasesTable.createdAt);
  const mapped = await Promise.all(
    leases.map(async (l) => {
      const m = mapLease(l);
      return attachScheduleSummary(l.id, m);
    }),
  );
  res.json(mapped);
});

// GET /leases/summary
router.get("/leases/summary", async (req, res): Promise<void> => {
  const queryParse = GetLeasesSummaryQueryParams.safeParse(req.query);
  if (!queryParse.success) {
    res.status(400).json({ error: queryParse.error.message });
    return;
  }
  const fiscalYearStartMonth = await resolveFiscalYearStartMonth(
    queryParse.data.fiscalYearStartMonth,
  );

  const leases = await db.select().from(leasesTable);
  const activeLeases = leases.filter((l) => l.status === "active").length;

  // YTD interest within current fiscal year. Joined against leases so we can
  // exclude leases currently flagged short-term — even though wiping their
  // schedule on toggle should make this redundant, defensive filtering avoids
  // counting any stale rows.
  const { start: ytdStart, end: ytdEnd } = fiscalYearWindow(new Date(), fiscalYearStartMonth);
  const ytdRows = await db
    .select({ interest: scheduleEntriesTable.interest })
    .from(scheduleEntriesTable)
    .innerJoin(leasesTable, eq(leasesTable.id, scheduleEntriesTable.leaseId))
    .where(
      and(
        eq(scheduleEntriesTable.status, "posted"),
        gte(scheduleEntriesTable.paymentDate, ytdStart),
        lte(scheduleEntriesTable.paymentDate, ytdEnd),
        eq(leasesTable.isShortTerm, false),
      ),
    );
  const interestExpenseYtd = ytdRows.reduce((sum, r) => sum + toNumber(r.interest), 0);

  // Outstanding liability — single query: latest posted ending_balance per lease.
  // Short-term leases are excluded because they have no schedule/liability.
  const lastPostedRows = await db.execute<{ lease_id: number; ending_balance: string }>(sql`
    SELECT DISTINCT ON (lease_id) lease_id, ending_balance
    FROM ${scheduleEntriesTable}
    WHERE status = 'posted'
    ORDER BY lease_id, period_number DESC
  `);
  const lastPostedByLease = new Map<number, number>();
  for (const r of lastPostedRows.rows) {
    lastPostedByLease.set(r.lease_id, toNumber(r.ending_balance));
  }

  let outstandingLeaseLiability = 0;
  for (const lease of leases) {
    if (lease.isShortTerm) continue;
    const posted = lastPostedByLease.get(lease.id);
    outstandingLeaseLiability += posted ?? toNumber(lease.presentValue);
  }

  res.json({
    activeLeases,
    interestExpenseYtd: Math.round(interestExpenseYtd * 100) / 100,
    outstandingLeaseLiability: Math.round(outstandingLeaseLiability * 100) / 100,
  });
});

// GET /leases/:id
router.get("/leases/:id", async (req, res): Promise<void> => {
  const params = GetLeaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [lease] = await db.select().from(leasesTable).where(eq(leasesTable.id, params.data.id));
  if (!lease) {
    res.status(404).json({ error: "Lease not found" });
    return;
  }

  const entries = await db
    .select()
    .from(scheduleEntriesTable)
    .where(eq(scheduleEntriesTable.leaseId, lease.id))
    .orderBy(scheduleEntriesTable.periodNumber);

  const mapped = mapLease(lease);
  await attachScheduleSummary(lease.id, mapped);

  res.json({
    ...mapped,
    schedule: entries.map(mapScheduleEntry),
  });
});

// POST /leases
router.post("/leases", async (req, res): Promise<void> => {
  const parsed = CreateLeaseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const data = parsed.data;

  // Short-term lease exemption: ASC 842 § 842-20-25-2 only allows for terms ≤ 12 months.
  if (data.isShortTerm && data.termMonths > 12) {
    res.status(400).json({
      error: "Short-term lease election requires termMonths ≤ 12",
    });
    return;
  }

  const [lease] = await db
    .insert(leasesTable)
    .values({
      name: data.name,
      lessor: data.lessor,
      commencementDate: toDateStr(data.commencementDate),
      termMonths: data.termMonths,
      monthlyPayment: data.monthlyPayment.toString(),
      presentValue: data.presentValue.toString(),
      borrowingRate: data.borrowingRate.toString(),
      leaseClassification: (data.leaseClassification as "operating" | "finance") ?? "operating",
      rouAssetAccount: data.rouAssetAccount,
      leaseLiabilityAccount: data.leaseLiabilityAccount,
      interestExpenseAccount: data.interestExpenseAccount,
      amortizationExpenseAccount: data.amortizationExpenseAccount,
      cashAccount: data.cashAccount,
      paymentFrequency: (data.paymentFrequency as "monthly" | "quarterly" | "annually") ?? "monthly",
      paymentTiming: (data.paymentTiming as "advance" | "arrears") ?? "arrears",
      isShortTerm: data.isShortTerm ?? false,
      prepaidRent: (data.prepaidRent ?? 0).toString(),
      initialDirectCosts: (data.initialDirectCosts ?? 0).toString(),
      leaseIncentives: (data.leaseIncentives ?? 0).toString(),
      status: "active",
    })
    .returning();

  // Skip schedule generation entirely for short-term leases — they get
  // straight-line monthly expense recognition only, no ROU/liability tracking.
  if (!lease.isShortTerm) {
    const rows = buildScheduleRows(lease);

    if (rows.length > 0) {
      await db.insert(scheduleEntriesTable).values(
        rows.map((r) => ({
          leaseId: lease.id,
          periodNumber: r.periodNumber,
          paymentDate: r.paymentDate,
          beginningBalance: r.beginningBalance,
          payment: r.payment,
          interest: r.interest,
          principal: r.principal,
          endingBalance: r.endingBalance,
          rouAmortization: r.rouAmortization,
          leaseExpense: r.leaseExpense,
          status: "draft" as const,
        })),
      );
    }
  }

  const mapped = mapLease(lease);
  await attachScheduleSummary(lease.id, mapped);

  res.status(201).json(mapped);
});

// PUT /leases/:id
router.put("/leases/:id", async (req, res): Promise<void> => {
  const params = UpdateLeaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateLeaseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const data = parsed.data;

  // Pre-flight validation against the merged (current + incoming) state, so
  // we never persist an invalid combination and only rollback at the catch site.
  const [existing] = await db.select().from(leasesTable).where(eq(leasesTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Lease not found" });
    return;
  }
  const nextIsShortTerm = data.isShortTerm ?? existing.isShortTerm;
  const nextTermMonths = data.termMonths ?? existing.termMonths;
  if (nextIsShortTerm && nextTermMonths > 12) {
    res.status(400).json({
      error: "Short-term lease election requires termMonths ≤ 12",
    });
    return;
  }

  const updateData: Record<string, unknown> = {};

  if (data.name !== undefined) updateData.name = data.name;
  if (data.lessor !== undefined) updateData.lessor = data.lessor;
  if (data.commencementDate !== undefined) updateData.commencementDate = toDateStr(data.commencementDate);
  if (data.termMonths !== undefined) updateData.termMonths = data.termMonths;
  if (data.monthlyPayment !== undefined) updateData.monthlyPayment = data.monthlyPayment.toString();
  if (data.presentValue !== undefined) updateData.presentValue = data.presentValue.toString();
  if (data.borrowingRate !== undefined) updateData.borrowingRate = data.borrowingRate.toString();
  if (data.leaseClassification !== undefined) updateData.leaseClassification = data.leaseClassification;
  if (data.rouAssetAccount !== undefined) updateData.rouAssetAccount = data.rouAssetAccount;
  if (data.leaseLiabilityAccount !== undefined) updateData.leaseLiabilityAccount = data.leaseLiabilityAccount;
  if (data.interestExpenseAccount !== undefined) updateData.interestExpenseAccount = data.interestExpenseAccount;
  if (data.amortizationExpenseAccount !== undefined) updateData.amortizationExpenseAccount = data.amortizationExpenseAccount;
  if (data.cashAccount !== undefined) updateData.cashAccount = data.cashAccount;
  if (data.paymentFrequency !== undefined) updateData.paymentFrequency = data.paymentFrequency;
  if (data.paymentTiming !== undefined) updateData.paymentTiming = data.paymentTiming;
  if (data.isShortTerm !== undefined) updateData.isShortTerm = data.isShortTerm;
  if (data.prepaidRent !== undefined) updateData.prepaidRent = data.prepaidRent.toString();
  if (data.initialDirectCosts !== undefined) updateData.initialDirectCosts = data.initialDirectCosts.toString();
  if (data.leaseIncentives !== undefined) updateData.leaseIncentives = data.leaseIncentives.toString();
  if (data.status !== undefined) updateData.status = data.status;

  // Compute regen flags from the parsed body BEFORE any mutation. The
  // posted-period guard must run before the UPDATE so a 400 cannot leave the
  // lease row mutated. (Regression test: previously the lease was updated
  // first, then we 400'd, leaving accounting state inconsistent — posted
  // schedule/journal history tied to pre-change terms while master terms
  // had already moved.)
  const shortTermToggled = data.isShortTerm !== undefined && data.isShortTerm !== existing.isShortTerm;
  const regenerate =
    data.monthlyPayment !== undefined ||
    data.presentValue !== undefined ||
    data.borrowingRate !== undefined ||
    data.termMonths !== undefined ||
    data.commencementDate !== undefined ||
    data.paymentFrequency !== undefined ||
    data.leaseClassification !== undefined ||
    data.paymentTiming !== undefined ||
    shortTermToggled ||
    data.prepaidRent !== undefined ||
    data.initialDirectCosts !== undefined ||
    data.leaseIncentives !== undefined;

  // Posted-period guard. ANY regen-triggering change (payment, rate, term,
  // classification, etc.) is incompatible with already-posted periods.
  // Previously we only deleted drafts and re-inserted a fresh schedule
  // starting at periodNumber=1, which produced two rows sharing
  // period_number=1 alongside the kept posted row — and then collided on the
  // journal_entries idempotency_key (`lease-X-period-1-v1`) on the next post.
  // Accounting-wise you also cannot retroactively change the terms of a
  // lease that already has posted journal entries; the user must unpost first.
  // isShortTerm toggle is the lone exception: it wipes everything (posted
  // included) because the election denies the lease should have a schedule.
  if (regenerate && !shortTermToggled) {
    const postedRows = await db
      .select({ periodNumber: scheduleEntriesTable.periodNumber })
      .from(scheduleEntriesTable)
      .where(
        and(
          eq(scheduleEntriesTable.leaseId, params.data.id),
          eq(scheduleEntriesTable.status, "posted"),
        ),
      )
      .orderBy(scheduleEntriesTable.periodNumber);

    if (postedRows.length > 0) {
      res.status(400).json({
        error:
          "Cannot modify lease terms while posted periods exist. Unpost the affected periods first, then retry.",
        postedPeriods: postedRows.map((r) => r.periodNumber),
      });
      return;
    }
  }

  // UPDATE + schedule delete/regen happen in a single transaction so a partial
  // failure (e.g. insert error after delete) doesn't leave the lease with no
  // schedule rows. The posted-period guard above already ran read-only
  // outside the txn, which is fine — the only race window is concurrent posts
  // happening between the guard and the txn, which would just become a
  // duplicate-key error caught by the surrounding error handler.
  const lease = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(leasesTable)
      .set(updateData)
      .where(eq(leasesTable.id, params.data.id))
      .returning();

    if (!updated) return null;

    if (regenerate) {
      if (shortTermToggled) {
        await tx
          .delete(scheduleEntriesTable)
          .where(eq(scheduleEntriesTable.leaseId, updated.id));
      } else {
        await tx
          .delete(scheduleEntriesTable)
          .where(
            and(
              eq(scheduleEntriesTable.leaseId, updated.id),
              eq(scheduleEntriesTable.status, "draft"),
            ),
          );
      }

      if (!updated.isShortTerm) {
        const rows = buildScheduleRows(updated);

        if (rows.length > 0) {
          await tx.insert(scheduleEntriesTable).values(
            rows.map((r) => ({
              leaseId: updated.id,
              periodNumber: r.periodNumber,
              paymentDate: r.paymentDate,
              beginningBalance: r.beginningBalance,
              payment: r.payment,
              interest: r.interest,
              principal: r.principal,
              endingBalance: r.endingBalance,
              rouAmortization: r.rouAmortization,
              leaseExpense: r.leaseExpense,
              status: "draft" as const,
            })),
          );
        }
      }
    }

    return updated;
  });

  if (!lease) {
    res.status(404).json({ error: "Lease not found" });
    return;
  }

  const mapped = mapLease(lease);
  await attachScheduleSummary(lease.id, mapped);
  res.json(mapped);
});

// DELETE /leases/:id
router.delete("/leases/:id", async (req, res): Promise<void> => {
  const params = DeleteLeaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [lease] = await db
    .delete(leasesTable)
    .where(eq(leasesTable.id, params.data.id))
    .returning();

  if (!lease) {
    res.status(404).json({ error: "Lease not found" });
    return;
  }

  res.sendStatus(204);
});

// GET /leases/:id/schedule
router.get("/leases/:id/schedule", async (req, res): Promise<void> => {
  const params = GetLeaseScheduleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [lease] = await db.select().from(leasesTable).where(eq(leasesTable.id, params.data.id));
  if (!lease) {
    res.status(404).json({ error: "Lease not found" });
    return;
  }

  const entries = await db
    .select()
    .from(scheduleEntriesTable)
    .where(eq(scheduleEntriesTable.leaseId, params.data.id))
    .orderBy(scheduleEntriesTable.periodNumber);

  res.json(entries.map(mapScheduleEntry));
});

function mapScheduleEntry(e: typeof scheduleEntriesTable.$inferSelect) {
  return {
    id: e.id,
    leaseId: e.leaseId,
    periodNumber: e.periodNumber,
    paymentDate: e.paymentDate,
    beginningBalance: toNumber(e.beginningBalance),
    payment: toNumber(e.payment),
    interest: toNumber(e.interest),
    principal: toNumber(e.principal),
    endingBalance: toNumber(e.endingBalance),
    rouAmortization: toNumber(e.rouAmortization),
    leaseExpense: toNumber(e.leaseExpense),
    status: e.status,
  };
}

async function returnSchedule(res: import("express").Response, leaseId: number): Promise<void> {
  const entries = await db
    .select()
    .from(scheduleEntriesTable)
    .where(eq(scheduleEntriesTable.leaseId, leaseId))
    .orderBy(scheduleEntriesTable.periodNumber);
  res.json(entries.map(mapScheduleEntry));
}

// POST /leases/:id/schedule/post — flips draft entries → posted, generates a
// balanced journal entry per newly posted period. Idempotent: any period that
// already has a status="posted" JE is left untouched.
router.post("/leases/:id/schedule/post", async (req, res): Promise<void> => {
  const params = PostLeasePaymentsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = PostLeasePaymentsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const leaseId = params.data.id;
  const throughPeriod = body.data.throughPeriod;

  const [lease] = await db.select().from(leasesTable).where(eq(leasesTable.id, leaseId));
  if (!lease) {
    res.status(404).json({ error: "Lease not found" });
    return;
  }
  if (lease.isShortTerm) {
    res.status(400).json({ error: "Short-term leases have no schedule to post" });
    return;
  }

  const accounts = {
    rouAssetAccount: lease.rouAssetAccount,
    leaseLiabilityAccount: lease.leaseLiabilityAccount,
    interestExpenseAccount: lease.interestExpenseAccount,
    amortizationExpenseAccount: lease.amortizationExpenseAccount,
    cashAccount: lease.cashAccount,
  };

  // Hard validation: refuse to post if any required GL account is missing for
  // this lease's classification. We do NOT silently substitute placeholders.
  const missing = validateAccountsForPost(
    lease.leaseClassification as LeaseClassification,
    accounts,
  );
  if (missing.length > 0) {
    res.status(400).json({
      error: "Cannot post: missing GL account mappings",
      missingAccounts: missing,
    });
    return;
  }

  // Capture the newly-created JEs so we can push them to QBO after commit.
  // QBO sync runs OUTSIDE the transaction because it makes external HTTP calls
  // and we don't want a slow/failed QBO push to roll back a successful local
  // close. Sync state is recorded back on each JE row independently.
  type NewJe = {
    id: number;
    leaseId: number;
    period: string;
    paymentDate: string;
    memo: string | null;
    lines: { accountCode: string; debit: string; credit: string; memo: string | null }[];
  };
  const newJes: NewJe[] = [];

  await db.transaction(async (tx) => {
    // Lock draft rows for the duration of the transaction so concurrent posts
    // can't both observe the same drafts and double-insert JEs.
    const draftRows = await tx
      .select()
      .from(scheduleEntriesTable)
      .where(
        and(
          eq(scheduleEntriesTable.leaseId, leaseId),
          eq(scheduleEntriesTable.status, "draft"),
          lte(scheduleEntriesTable.periodNumber, throughPeriod),
        ),
      )
      .orderBy(scheduleEntriesTable.periodNumber)
      .for("update");

    for (const entry of draftRows) {
      const periodLabel = periodLabelFromDate(entry.paymentDate);
      // The schedule_entries.status filter on the outer query is already our
      // idempotency guard — only "draft" rows reach here. We do NOT also check
      // for an existing posted JE on this scheduleEntry because reversal JEs
      // are themselves status="posted" (they offset the original) and would
      // wrongly suppress re-posting after an unpost cycle.

      const lines = buildJournalLines(
        lease.leaseClassification as LeaseClassification,
        {
          interest: toNumber(entry.interest),
          principal: toNumber(entry.principal),
          payment: toNumber(entry.payment),
          rouAmortization: toNumber(entry.rouAmortization),
          leaseExpense: toNumber(entry.leaseExpense),
        },
        accounts,
        periodLabel,
      );
      assertBalanced(lines);

      // Counter so we can post → unpost → re-post the same period without
      // colliding on the unique idempotency_key constraint.
      const priorCount = await tx.$count(
        journalEntriesTable,
        eq(journalEntriesTable.scheduleEntryId, entry.id),
      );
      const idempotencyKey = `lease-${leaseId}-period-${entry.periodNumber}-v${priorCount + 1}`;

      const [je] = await tx
        .insert(journalEntriesTable)
        .values({
          leaseId,
          scheduleEntryId: entry.id,
          period: periodLabel,
          status: "posted",
          idempotencyKey,
          memo: `Lease ${lease.name} — period ${periodLabel}`,
        })
        .returning();

      await tx.insert(journalEntryLinesTable).values(
        lines.map((l) => ({
          journalEntryId: je.id,
          accountCode: l.accountCode,
          debit: l.debit,
          credit: l.credit,
          memo: l.memo,
        })),
      );

      await tx
        .update(scheduleEntriesTable)
        .set({ status: "posted" })
        .where(eq(scheduleEntriesTable.id, entry.id));

      newJes.push({
        id: je.id,
        leaseId,
        period: periodLabel,
        paymentDate: entry.paymentDate,
        memo: je.memo,
        lines: lines.map((l) => ({
          accountCode: l.accountCode,
          debit: l.debit,
          credit: l.credit,
          memo: l.memo,
        })),
      });
    }
  });

  // Best-effort QBO sync. Each JE updates its own qboSyncStatus row; failures
  // are logged but never fail the request — the local close is already done.
  await syncJesToQbo(req, lease, newJes);

  await returnSchedule(res, leaseId);
});

/**
 * Push each freshly-posted JE to QBO. Marks every row with a sync status:
 *   - skipped: no QBO connection
 *   - synced:  successfully created in QBO (qboId stored)
 *   - failed:  push errored (error message stored)
 *
 * Failures here do NOT roll back the local post — the user can retry from the
 * JE row in the UI via POST /qbo/journal-entries/:id/sync.
 */
async function syncJesToQbo(
  req: import("express").Request,
  lease: typeof leasesTable.$inferSelect,
  jes: Array<{
    id: number;
    leaseId: number;
    period: string;
    paymentDate: string;
    memo: string | null;
    lines: { accountCode: string; debit: string; credit: string; memo: string | null }[];
  }>,
): Promise<void> {
  if (jes.length === 0) return;

  const existing = await getConnection();
  if (!existing) {
    await db
      .update(journalEntriesTable)
      .set({ qboSyncStatus: "skipped" })
      .where(inArray(journalEntriesTable.id, jes.map((j) => j.id)));
    return;
  }

  let conn;
  try {
    conn = await ensureValidConnection();
  } catch (err) {
    const message = (err as Error).message;
    req.log.warn({ err }, "QBO connection unavailable; marking JEs as failed");
    await db
      .update(journalEntriesTable)
      .set({ qboSyncStatus: "failed", qboSyncError: message })
      .where(inArray(journalEntriesTable.id, jes.map((j) => j.id)));
    return;
  }

  for (const je of jes) {
    try {
      const result = await pushJournalEntry(conn, {
        txnDate: je.paymentDate,
        privateMemo: je.memo ?? `Lease ${lease.name} ${je.period}`,
        docNumber: `LSE-${lease.id}-${je.period}`,
        lines: je.lines.map((l) => ({
          accountRefId: l.accountCode,
          amount: parseFloat(l.debit) > 0 ? parseFloat(l.debit) : parseFloat(l.credit),
          posting: parseFloat(l.debit) > 0 ? "Debit" : "Credit",
          memo: l.memo ?? undefined,
        })),
      });
      await db
        .update(journalEntriesTable)
        .set({
          qboId: result.Id,
          qboSyncToken: result.SyncToken,
          qboSyncStatus: "synced",
          qboSyncError: null,
          qboSyncedAt: new Date(),
        })
        .where(eq(journalEntriesTable.id, je.id));
    } catch (err) {
      const message = (err as Error).message;
      req.log.error({ err, journalEntryId: je.id }, "QBO JE push failed");
      await db
        .update(journalEntriesTable)
        .set({ qboSyncStatus: "failed", qboSyncError: message })
        .where(eq(journalEntriesTable.id, je.id));
    }
  }
}

// POST /leases/:id/schedule/unpost/:periodNumber — reverses the posted JE for
// a single period: marks the original "reversed", creates a new offsetting
// "posted" JE with debits/credits swapped, and flips the schedule entry back
// to "draft". Idempotent: a period that isn't currently posted returns 400.
router.post("/leases/:id/schedule/unpost/:periodNumber", async (req, res): Promise<void> => {
  const params = UnpostLeasePaymentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const leaseId = params.data.id;
  const periodNumber = params.data.periodNumber;

  const [lease] = await db.select().from(leasesTable).where(eq(leasesTable.id, leaseId));
  if (!lease) {
    res.status(404).json({ error: "Lease not found" });
    return;
  }

  // Status check + JE lookup happen inside the transaction with FOR UPDATE on
  // the schedule row so two concurrent unpost calls can't both create
  // reversals for the same period.
  type HttpError = { status: number; message: string };
  const errBox: { value: HttpError | null } = { value: null };
  const fail = (status: number, message: string) => { errBox.value = { status, message }; };

  // Captured from the txn so we can perform the QBO leg AFTER commit:
  //   - originalQboId/SyncToken: if set, delete the original JE in QBO
  //   - reversal: push as a brand-new JE in QBO so books stay in sync
  type Captured = {
    originalQboId: string | null;
    originalQboSyncToken: string | null;
    reversal: {
      id: number;
      period: string;
      paymentDate: string;
      memo: string | null;
      lines: { accountCode: string; debit: string; credit: string; memo: string | null }[];
    } | null;
  };
  const captured: Captured = { originalQboId: null, originalQboSyncToken: null, reversal: null };

  await db.transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(scheduleEntriesTable)
      .where(
        and(
          eq(scheduleEntriesTable.leaseId, leaseId),
          eq(scheduleEntriesTable.periodNumber, periodNumber),
        ),
      )
      .for("update");
    if (!entry) {
      fail(404, "Period not found");
      return;
    }
    if (entry.status !== "posted") {
      fail(400, "Period is not currently posted");
      return;
    }

    // Latest non-reversed posted JE for this scheduleEntry. Excluding rows
    // whose reversesEntryId is set ensures we pick the original posting, not
    // an offsetting reversal entry that also carries status="posted".
    const [original] = await tx
      .select()
      .from(journalEntriesTable)
      .where(
        and(
          eq(journalEntriesTable.scheduleEntryId, entry.id),
          eq(journalEntriesTable.status, "posted"),
          sql`${journalEntriesTable.reversesEntryId} IS NULL`,
        ),
      )
      .orderBy(sql`${journalEntriesTable.postedAt} desc`)
      .limit(1);
    if (!original) {
      fail(400, "No posted journal entry found for this period");
      return;
    }

    const periodLabel = periodLabelFromDate(entry.paymentDate);

    const originalLines = await tx
      .select()
      .from(journalEntryLinesTable)
      .where(eq(journalEntryLinesTable.journalEntryId, original.id));

    // If the original JE was somehow posted to placeholder accounts (e.g. from
    // legacy data before validation was tightened), refuse to reverse: the
    // user must fix the lease accounts and we don't want to perpetuate
    // garbage GL codes into another posted JE.
    const stale = originalLines
      .map((l) => l.accountCode)
      .filter((c) => c.startsWith("UNASSIGNED-"));
    if (stale.length > 0) {
      fail(
        400,
        `Original journal entry references placeholder accounts (${[...new Set(stale)].join(", ")}). Edit the lease GL accounts before reversing.`,
      );
      return;
    }

    const reversed = reverseLines(
      originalLines.map((l) => ({
        accountCode: l.accountCode,
        debit: l.debit,
        credit: l.credit,
        memo: l.memo,
      })),
      periodLabel,
    );
    assertBalanced(reversed);

    const priorCount = await tx.$count(
      journalEntriesTable,
      eq(journalEntriesTable.scheduleEntryId, entry.id),
    );
    const idempotencyKey = `lease-${leaseId}-period-${periodNumber}-rev-v${priorCount + 1}`;

    const [reversal] = await tx
      .insert(journalEntriesTable)
      .values({
        leaseId,
        scheduleEntryId: entry.id,
        period: periodLabel,
        status: "posted",
        idempotencyKey,
        reversesEntryId: original.id,
        memo: `Reversal of JE #${original.id} (${periodLabel})`,
      })
      .returning();

    await tx.insert(journalEntryLinesTable).values(
      reversed.map((l) => ({
        journalEntryId: reversal.id,
        accountCode: l.accountCode,
        debit: l.debit,
        credit: l.credit,
        memo: l.memo,
      })),
    );

    await tx
      .update(journalEntriesTable)
      .set({ status: "reversed" })
      .where(eq(journalEntriesTable.id, original.id));

    await tx
      .update(scheduleEntriesTable)
      .set({ status: "draft" })
      .where(eq(scheduleEntriesTable.id, entry.id));

    // Capture for the post-commit QBO sync.
    captured.originalQboId = original.qboId;
    captured.originalQboSyncToken = original.qboSyncToken;
    captured.reversal = {
      id: reversal.id,
      period: periodLabel,
      paymentDate: entry.paymentDate,
      memo: reversal.memo,
      lines: reversed.map((l) => ({
        accountCode: l.accountCode,
        debit: l.debit,
        credit: l.credit,
        memo: l.memo,
      })),
    };
  });

  if (errBox.value) {
    res.status(errBox.value.status).json({ error: errBox.value.message });
    return;
  }

  // Best-effort QBO leg: delete the original JE in QBO (if it was synced) and
  // push the new reversal JE. Failures are logged on the row but never block
  // the local response — the unpost has already committed.
  await syncReversalToQbo(req, lease, captured);

  await returnSchedule(res, leaseId);
});

/**
 * QBO side of an unpost: delete the original JE in QBO if it was synced, then
 * push the new offsetting JE so QBO mirrors our local "reversal entry" model.
 *
 * The original JE is deleted (not voided) because QBO doesn't expose a void
 * concept on JEs and a hard delete + offsetting create most cleanly matches
 * the user's mental model: "I unposted, then re-posted with corrections later".
 */
async function syncReversalToQbo(
  req: import("express").Request,
  lease: typeof leasesTable.$inferSelect,
  captured: {
    originalQboId: string | null;
    originalQboSyncToken: string | null;
    reversal: {
      id: number;
      period: string;
      paymentDate: string;
      memo: string | null;
      lines: { accountCode: string; debit: string; credit: string; memo: string | null }[];
    } | null;
  },
): Promise<void> {
  if (!captured.reversal) return;
  const reversal = captured.reversal;

  const existing = await getConnection();
  if (!existing) {
    await db
      .update(journalEntriesTable)
      .set({ qboSyncStatus: "skipped" })
      .where(eq(journalEntriesTable.id, reversal.id));
    return;
  }

  let conn;
  try {
    conn = await ensureValidConnection();
  } catch (err) {
    const message = (err as Error).message;
    req.log.warn({ err }, "QBO connection unavailable for reversal");
    await db
      .update(journalEntriesTable)
      .set({ qboSyncStatus: "failed", qboSyncError: message })
      .where(eq(journalEntriesTable.id, reversal.id));
    return;
  }

  // 1. Delete the original in QBO. Idempotent: 610/Object Not Found is fine.
  // If this fails for any *other* reason, we MUST NOT push the reversal — doing
  // so would leave QBO with both the original AND a fresh "reversal" JE, which
  // would double-count the lease activity. Mark the reversal row failed and
  // bail; the user can use the manual retry once the QBO state is sorted out
  // (e.g. they delete the original in QBO themselves, or fix permissions).
  if (captured.originalQboId && captured.originalQboSyncToken) {
    try {
      await deleteJournalEntry(conn, captured.originalQboId, captured.originalQboSyncToken);
    } catch (err) {
      const message = `QBO delete of original JE ${captured.originalQboId} failed: ${(err as Error).message}`;
      req.log.error({ err, qboId: captured.originalQboId }, "QBO delete original JE failed");
      await db
        .update(journalEntriesTable)
        .set({ qboSyncStatus: "failed", qboSyncError: message })
        .where(eq(journalEntriesTable.id, reversal.id));
      return;
    }
  }

  // 2. Push the reversal as a fresh JE.
  try {
    const result = await pushJournalEntry(conn, {
      txnDate: reversal.paymentDate,
      privateMemo: reversal.memo ?? `Reversal ${reversal.period}`,
      docNumber: `LSE-${lease.id}-${reversal.period}-REV`,
      lines: reversal.lines.map((l) => ({
        accountRefId: l.accountCode,
        amount: parseFloat(l.debit) > 0 ? parseFloat(l.debit) : parseFloat(l.credit),
        posting: parseFloat(l.debit) > 0 ? "Debit" : "Credit",
        memo: l.memo ?? undefined,
      })),
    });
    await db
      .update(journalEntriesTable)
      .set({
        qboId: result.Id,
        qboSyncToken: result.SyncToken,
        qboSyncStatus: "synced",
        qboSyncError: null,
        qboSyncedAt: new Date(),
      })
      .where(eq(journalEntriesTable.id, reversal.id));
  } catch (err) {
    const message = (err as Error).message;
    req.log.error({ err, journalEntryId: reversal.id }, "QBO reversal JE push failed");
    await db
      .update(journalEntriesTable)
      .set({ qboSyncStatus: "failed", qboSyncError: message })
      .where(eq(journalEntriesTable.id, reversal.id));
  }
}

// GET /leases/:id/journal-entries — all JEs (posted and reversed) for a lease,
// each with its lines. Ordered by postedAt asc.
router.get("/leases/:id/journal-entries", async (req, res): Promise<void> => {
  const params = GetLeaseJournalEntriesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const leaseId = params.data.id;

  const [lease] = await db.select().from(leasesTable).where(eq(leasesTable.id, leaseId));
  if (!lease) {
    res.status(404).json({ error: "Lease not found" });
    return;
  }

  const entries = await db
    .select()
    .from(journalEntriesTable)
    .where(eq(journalEntriesTable.leaseId, leaseId))
    .orderBy(asc(journalEntriesTable.postedAt), asc(journalEntriesTable.id));

  if (entries.length === 0) {
    res.json([]);
    return;
  }

  const allLines = await db
    .select()
    .from(journalEntryLinesTable)
    .where(inArray(journalEntryLinesTable.journalEntryId, entries.map((e) => e.id)))
    .orderBy(asc(journalEntryLinesTable.id));

  const linesByJe = new Map<number, typeof allLines>();
  for (const l of allLines) {
    const arr = linesByJe.get(l.journalEntryId) ?? [];
    arr.push(l);
    linesByJe.set(l.journalEntryId, arr);
  }

  res.json(
    entries.map((e) => ({
      id: e.id,
      leaseId: e.leaseId,
      scheduleEntryId: e.scheduleEntryId,
      period: e.period,
      postedAt: e.postedAt.toISOString(),
      status: e.status,
      idempotencyKey: e.idempotencyKey,
      reversesEntryId: e.reversesEntryId,
      memo: e.memo,
      qboId: e.qboId,
      qboSyncStatus: e.qboSyncStatus,
      qboSyncError: e.qboSyncError,
      qboSyncedAt: e.qboSyncedAt ? e.qboSyncedAt.toISOString() : null,
      lines: (linesByJe.get(e.id) ?? []).map((l) => ({
        id: l.id,
        journalEntryId: l.journalEntryId,
        accountCode: l.accountCode,
        debit: toNumber(l.debit),
        credit: toNumber(l.credit),
        memo: l.memo,
      })),
    })),
  );
});

export default router;
