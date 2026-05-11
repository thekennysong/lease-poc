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

  const [lease] = await db
    .update(leasesTable)
    .set(updateData)
    .where(eq(leasesTable.id, params.data.id))
    .returning();

  if (!lease) {
    res.status(404).json({ error: "Lease not found" });
    return;
  }

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

  if (regenerate) {
    // Toggling isShortTerm changes whether ANY schedule rows should exist for
    // this lease. We must wipe posted rows too; otherwise the lease would carry
    // historical interest/liability artifacts that the new election denies.
    // Other regenerations (payment, rate, etc.) only clear drafts.
    if (shortTermToggled) {
      await db
        .delete(scheduleEntriesTable)
        .where(eq(scheduleEntriesTable.leaseId, lease.id));
    } else {
      await db
        .delete(scheduleEntriesTable)
        .where(
          and(
            eq(scheduleEntriesTable.leaseId, lease.id),
            eq(scheduleEntriesTable.status, "draft"),
          ),
        );
    }

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
    }
  });

  await returnSchedule(res, leaseId);
});

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
  });

  if (errBox.value) {
    res.status(errBox.value.status).json({ error: errBox.value.message });
    return;
  }

  await returnSchedule(res, leaseId);
});

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
