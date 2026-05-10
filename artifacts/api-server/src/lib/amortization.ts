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

/**
 * Generate a lease amortization schedule (ASC 842 / IFRS 16 style).
 * Uses the monthly incremental borrowing rate applied to the beginning balance.
 */
export function generateSchedule(
  presentValue: number,
  monthlyPayment: number,
  annualBorrowingRate: number,
  termMonths: number,
  commencementDate: string,
): ScheduleRow[] {
  const monthlyRate = annualBorrowingRate / 100 / 12;
  const rouAmortizationPerPeriod = round2(presentValue / termMonths);

  const rows: ScheduleRow[] = [];
  let balance = presentValue;

  const startDate = new Date(commencementDate);
  // First payment is one month after commencement
  startDate.setMonth(startDate.getMonth() + 1);

  for (let i = 1; i <= termMonths; i++) {
    const beginningBalance = balance;
    const interest = round2(beginningBalance * monthlyRate);
    const principal = round2(monthlyPayment - interest);
    let endingBalance = round2(beginningBalance - principal);

    // Clamp to zero on final period due to rounding
    if (i === termMonths) {
      endingBalance = 0;
    }

    const paymentDate = new Date(startDate);
    paymentDate.setMonth(startDate.getMonth() + (i - 1));

    rows.push({
      periodNumber: i,
      paymentDate: formatDate(paymentDate),
      beginningBalance: beginningBalance.toFixed(2),
      payment: monthlyPayment.toFixed(2),
      interest: interest.toFixed(2),
      principal: principal.toFixed(2),
      endingBalance: endingBalance.toFixed(2),
      rouAmortization: rouAmortizationPerPeriod.toFixed(2),
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
