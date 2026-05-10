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

function paymentsPerYearFor(frequency: PaymentFrequency): number {
  if (frequency === "monthly") return 12;
  if (frequency === "quarterly") return 4;
  return 1;
}

/**
 * Generate a lease amortization schedule (ASC 842 / IFRS 16).
 *
 * Classification behaviour:
 *   finance  – ROU amortization is straight-line: presentValue / numPeriods
 *   operating – ROU amortization = straightLineLeaseExpense - interest
 *               where straightLineLeaseExpense = totalUndiscountedPayments / numPeriods
 *               (keeps total P&L expense flat each period)
 *
 * Payment frequency:
 *   Converts termMonths into numPeriods based on paymentsPerYear.
 *   Throws if termMonths is not evenly divisible by the period length.
 */
export function generateSchedule(
  presentValue: number,
  periodicPayment: number,
  annualBorrowingRate: number,
  termMonths: number,
  commencementDate: string,
  paymentFrequency: PaymentFrequency = "monthly",
  leaseClassification: LeaseClassification = "operating",
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

  // Straight-line lease expense per period (operating classification)
  const totalUndiscounted = periodicPayment * numPeriods;
  const straightLineExpense = round2(totalUndiscounted / numPeriods);

  // Finance classification: flat ROU amortization
  const financeRouPerPeriod = round2(presentValue / numPeriods);

  const rows: ScheduleRow[] = [];
  let balance = presentValue;

  const startDate = new Date(commencementDate);

  for (let i = 1; i <= numPeriods; i++) {
    const beginningBalance = balance;
    const interest = round2(beginningBalance * periodicRate);
    const principal = round2(periodicPayment - interest);
    let endingBalance = round2(beginningBalance - principal);

    // Clamp to zero on final period to absorb rounding drift
    if (i === numPeriods) {
      endingBalance = 0;
    }

    // ROU amortization depends on classification
    let rouAmortization: number;
    if (leaseClassification === "operating") {
      rouAmortization = round2(straightLineExpense - interest);
    } else {
      rouAmortization = financeRouPerPeriod;
    }

    const paymentDate = new Date(startDate);
    paymentDate.setMonth(startDate.getMonth() + i * monthsPerPeriod);

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
