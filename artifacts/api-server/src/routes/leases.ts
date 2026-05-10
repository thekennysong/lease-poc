import { Router, type IRouter } from "express";
import { eq, and, lte, gte, sql } from "drizzle-orm";
import { db, leasesTable, scheduleEntriesTable } from "@workspace/db";
import {
  CreateLeaseBody,
  UpdateLeaseBody,
  GetLeaseParams,
  UpdateLeaseParams,
  DeleteLeaseParams,
  GetLeaseScheduleParams,
  PostLeasePaymentsParams,
  PostLeasePaymentsBody,
} from "@workspace/api-zod";
import { generateSchedule } from "../lib/amortization";

const router: IRouter = Router();

function toNumber(v: string | null | undefined): number {
  return v == null ? 0 : parseFloat(v);
}

function mapLease(lease: typeof leasesTable.$inferSelect) {
  return {
    id: lease.id,
    name: lease.name,
    lessor: lease.lessor,
    commencementDate: lease.commencementDate,
    termMonths: lease.termMonths,
    monthlyPayment: toNumber(lease.monthlyPayment),
    presentValue: toNumber(lease.presentValue),
    borrowingRate: toNumber(lease.borrowingRate),
    rouAssetAccount: lease.rouAssetAccount,
    leaseLiabilityAccount: lease.leaseLiabilityAccount,
    interestExpenseAccount: lease.interestExpenseAccount,
    amortizationExpenseAccount: lease.amortizationExpenseAccount,
    cashAccount: lease.cashAccount,
    paymentFrequency: lease.paymentFrequency,
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
    // Current balance = ending balance of the last posted entry, or beginning of first draft
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
  const leases = await db.select().from(leasesTable);

  const activeLeases = leases.filter((l) => l.status === "active").length;

  // YTD interest = sum of interest on posted schedule entries this calendar year
  const currentYear = new Date().getFullYear();
  const ytdStart = `${currentYear}-01-01`;
  const ytdEnd = `${currentYear}-12-31`;

  const ytdRows = await db
    .select({ interest: scheduleEntriesTable.interest })
    .from(scheduleEntriesTable)
    .where(
      and(
        eq(scheduleEntriesTable.status, "posted"),
        gte(scheduleEntriesTable.paymentDate, ytdStart),
        lte(scheduleEntriesTable.paymentDate, ytdEnd),
      ),
    );

  const interestExpenseYtd = ytdRows.reduce((sum, r) => sum + toNumber(r.interest), 0);

  // Outstanding balance = sum of ending balances of last posted entry per lease
  let outstandingLeaseLiability = 0;
  for (const lease of leases) {
    const lastPosted = await db
      .select({ endingBalance: scheduleEntriesTable.endingBalance })
      .from(scheduleEntriesTable)
      .where(
        and(
          eq(scheduleEntriesTable.leaseId, lease.id),
          eq(scheduleEntriesTable.status, "posted"),
        ),
      )
      .orderBy(sql`${scheduleEntriesTable.periodNumber} DESC`)
      .limit(1);

    if (lastPosted.length > 0) {
      outstandingLeaseLiability += toNumber(lastPosted[0].endingBalance);
    } else {
      outstandingLeaseLiability += toNumber(lease.presentValue);
    }
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

  const [lease] = await db
    .insert(leasesTable)
    .values({
      name: data.name,
      lessor: data.lessor,
      commencementDate: data.commencementDate,
      termMonths: data.termMonths,
      monthlyPayment: data.monthlyPayment.toString(),
      presentValue: data.presentValue.toString(),
      borrowingRate: data.borrowingRate.toString(),
      rouAssetAccount: data.rouAssetAccount,
      leaseLiabilityAccount: data.leaseLiabilityAccount,
      interestExpenseAccount: data.interestExpenseAccount,
      amortizationExpenseAccount: data.amortizationExpenseAccount,
      cashAccount: data.cashAccount,
      paymentFrequency: (data.paymentFrequency as "monthly" | "quarterly" | "annually") ?? "monthly",
      status: "active",
    })
    .returning();

  // Generate amortization schedule
  const rows = generateSchedule(
    data.presentValue,
    data.monthlyPayment,
    data.borrowingRate,
    data.termMonths,
    data.commencementDate,
  );

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
  const updateData: Record<string, unknown> = {};

  if (data.name !== undefined) updateData.name = data.name;
  if (data.lessor !== undefined) updateData.lessor = data.lessor;
  if (data.commencementDate !== undefined) updateData.commencementDate = data.commencementDate;
  if (data.termMonths !== undefined) updateData.termMonths = data.termMonths;
  if (data.monthlyPayment !== undefined) updateData.monthlyPayment = data.monthlyPayment.toString();
  if (data.presentValue !== undefined) updateData.presentValue = data.presentValue.toString();
  if (data.borrowingRate !== undefined) updateData.borrowingRate = data.borrowingRate.toString();
  if (data.rouAssetAccount !== undefined) updateData.rouAssetAccount = data.rouAssetAccount;
  if (data.leaseLiabilityAccount !== undefined) updateData.leaseLiabilityAccount = data.leaseLiabilityAccount;
  if (data.interestExpenseAccount !== undefined) updateData.interestExpenseAccount = data.interestExpenseAccount;
  if (data.amortizationExpenseAccount !== undefined) updateData.amortizationExpenseAccount = data.amortizationExpenseAccount;
  if (data.cashAccount !== undefined) updateData.cashAccount = data.cashAccount;
  if (data.paymentFrequency !== undefined) updateData.paymentFrequency = data.paymentFrequency;
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

  // If key financial fields changed, regenerate the schedule (only draft entries)
  const regenerate =
    data.monthlyPayment !== undefined ||
    data.presentValue !== undefined ||
    data.borrowingRate !== undefined ||
    data.termMonths !== undefined ||
    data.commencementDate !== undefined;

  if (regenerate) {
    await db
      .delete(scheduleEntriesTable)
      .where(
        and(
          eq(scheduleEntriesTable.leaseId, lease.id),
          eq(scheduleEntriesTable.status, "draft"),
        ),
      );

    const rows = generateSchedule(
      toNumber(lease.monthlyPayment),
      toNumber(lease.monthlyPayment),
      toNumber(lease.borrowingRate),
      lease.termMonths,
      lease.commencementDate,
    );

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

  // Post all draft entries up through the given period
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
