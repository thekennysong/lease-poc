export interface ScheduleRow {
  periodNumber: number;
  paymentDate: string;
  beginningBalance: string;
  payment: string;
  interest: string;
  principal: string;
  endingBalance: string;
  rouAmortization: string;
}

export type PaymentFrequency = "monthly" | "quarterly" | "annually";
export type LeaseClassification = "operating" | "finance";
export type PaymentTiming = "advance" | "arrears";

export interface OpeningRouAdjustments {
  prepaidRent?: number;
  initialDirectCosts?: number;
  leaseIncentives?: number;
}

function paymentsPerYearFor(frequency: PaymentFrequency): number {
  if (frequency === "monthly") return 12;
  if (frequency === "quarterly") return 4;
  return 1;
}

/** Opening ROU = PV + prepaidRent + initialDirectCosts − leaseIncentives. */
export function computeOpeningRou(
  presentValue: number,
  adjustments: OpeningRouAdjustments = {},
): number {
  const prepaid = adjustments.prepaidRent ?? 0;
  const idc = adjustments.initialDirectCosts ?? 0;
  const incentives = adjustments.leaseIncentives ?? 0;
  return round2(presentValue + prepaid + idc - incentives);
}

/**
 * Generate a lease amortization schedule (ASC 842 / IFRS 16).
 *
 * Classification behaviour:
 *   finance  – ROU amortization is straight-line: openingROU / numPeriods
 *   operating – ROU amortization = totalLeaseExpense / numPeriods − interest
 *               where totalLeaseExpense = sum(payments) + prepaid + IDC − incentives
 *               (keeps total P&L expense flat each period)
 *
 * Payment frequency:
 *   Converts termMonths into numPeriods based on paymentsPerYear.
 *   Throws if termMonths is not evenly divisible by the period length.
 *
 * Payment timing:
 *   "arrears" (default) – first payment one period after commencement; interest
 *                          accrues each period on the prior balance.
 *   "advance"           – first payment on commencement date; period 1 has zero
 *                          interest because the payment hits before any time
 *                          passes. Subsequent periods accrue normally.
 */
export function generateSchedule(
  presentValue: number,
  periodicPayment: number,
  annualBorrowingRate: number,
  termMonths: number,
  commencementDate: string,
  paymentFrequency: PaymentFrequency = "monthly",
  leaseClassification: LeaseClassification = "operating",
  paymentTiming: PaymentTiming = "arrears",
  adjustments: OpeningRouAdjustments = {},
): ScheduleRow[] {
  const ppy = paymentsPerYearFor(paymentFrequency);
  const monthsPerPeriod = 12 / ppy;

  if (termMonths % monthsPerPeriod !== 0) {
    throw new Error(
      `termMonths (${termMonths}) must be divisible by ${monthsPerPeriod} for ${paymentFrequency} frequency`,
    );
  }

  const numPeriods = termMonths / monthsPerPeriod;
  const periodicRate = annualBorrowingRate / 100 / ppy;

  const openingRou = computeOpeningRou(presentValue, adjustments);
  const prepaid = adjustments.prepaidRent ?? 0;
  const idc = adjustments.initialDirectCosts ?? 0;
  const incentives = adjustments.leaseIncentives ?? 0;

  // Operating: straight-line total lease cost includes opening adjustments
  const totalLeaseCost = periodicPayment * numPeriods + prepaid + idc - incentives;
  const straightLineExpense = round2(totalLeaseCost / numPeriods);

  // Finance: flat ROU amortization based on opening ROU
  const financeRouPerPeriod = round2(openingRou / numPeriods);

  const rows: ScheduleRow[] = [];
  let balance = presentValue;

  const startDate = new Date(commencementDate);

  for (let i = 1; i <= numPeriods; i++) {
    const beginningBalance = balance;

    // Advance timing: no interest accrues in period 1 because the payment
    // hits the lease at t=0, before any time has passed.
    const interest =
      paymentTiming === "advance" && i === 1
        ? 0
        : round2(beginningBalance * periodicRate);

    const principal = round2(periodicPayment - interest);
    let endingBalance = round2(beginningBalance - principal);

    // Clamp to zero on final period to absorb rounding drift
    if (i === numPeriods) {
      endingBalance = 0;
    }

    const rouAmortization =
      leaseClassification === "operating"
        ? round2(straightLineExpense - interest)
        : financeRouPerPeriod;

    // Payment date offset depends on timing
    const monthOffset =
      paymentTiming === "advance" ? (i - 1) * monthsPerPeriod : i * monthsPerPeriod;
    const paymentDate = new Date(startDate);
    paymentDate.setMonth(startDate.getMonth() + monthOffset);

    rows.push({
      periodNumber: i,
      paymentDate: formatDate(paymentDate),
      beginningBalance: beginningBalance.toFixed(2),
      payment: periodicPayment.toFixed(2),
      interest: interest.toFixed(2),
      principal: principal.toFixed(2),
      endingBalance: endingBalance.toFixed(2),
      rouAmortization: rouAmortization.toFixed(2),
    });

    balance = endingBalance;
  }

  return rows;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
