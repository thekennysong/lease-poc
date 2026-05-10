import { Router, type IRouter } from "express";
import { eq, and, lte, gte, sql } from "drizzle-orm";
import { db, leasesTable, scheduleEntriesTable, appSettingsTable } from "@workspace/db";
import {
  CreateLeaseBody,
  UpdateLeaseBody,
  GetLeaseParams,
  UpdateLeaseParams,
  DeleteLeaseParams,
  GetLeaseScheduleParams,
  PostLeasePaymentsParams,
  PostLeasePaymentsBody,
  GetLeasesSummaryQueryParams,
} from "@workspace/api-zod";
import {
  generateSchedule,
  computeOpeningRou,
  type PaymentFrequency,
  type LeaseClassification,
  type PaymentTiming,
} from "../lib/amortization";

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
    schedule: entries.map((e) => ({
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
      status: e.status,
    })),
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

  res.json(
    entries.map((e) => ({
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
      status: e.status,
    })),
  );
});

// POST /leases/:id/schedule/post
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

  const [lease] = await db.select().from(leasesTable).where(eq(leasesTable.id, params.data.id));
  if (!lease) {
    res.status(404).json({ error: "Lease not found" });
    return;
  }

  await db
    .update(scheduleEntriesTable)
    .set({ status: "posted" })
    .where(
      and(
        eq(scheduleEntriesTable.leaseId, params.data.id),
        eq(scheduleEntriesTable.status, "draft"),
        lte(scheduleEntriesTable.periodNumber, body.data.throughPeriod),
      ),
    );

  const entries = await db
    .select()
    .from(scheduleEntriesTable)
    .where(eq(scheduleEntriesTable.leaseId, params.data.id))
    .orderBy(scheduleEntriesTable.periodNumber);

  res.json(
    entries.map((e) => ({
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
      status: e.status,
    })),
  );
});

export default router;
