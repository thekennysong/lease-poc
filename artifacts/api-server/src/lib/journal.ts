/**
 * Journal-entry generation for a posted period.
 *
 * Finance lease, per period:
 *   Dr Interest Expense        interest
 *   Dr Amortization Expense    rouAmortization
 *   Dr Lease Liability         principal
 *   Cr ROU Asset               rouAmortization
 *   Cr Cash                    payment
 *
 * Operating lease, per period:
 *   Dr Lease Expense           straight-line lease expense (= interest + rouAmort)
 *   Dr Lease Liability         principal
 *   Cr ROU Asset               rouAmortization (the plug)
 *   Cr Cash                    payment
 *
 * Both balance to debits = credits.
 */

export type LeaseClassification = "operating" | "finance";

export interface ScheduleAmounts {
  interest: number;
  principal: number;
  payment: number;
  rouAmortization: number;
}

export interface LeaseAccounts {
  rouAssetAccount?: string | null;
  leaseLiabilityAccount?: string | null;
  interestExpenseAccount?: string | null;
  amortizationExpenseAccount?: string | null;
  cashAccount?: string | null;
}

export interface JournalLineDraft {
  accountCode: string;
  debit: string; // numeric(15,2) string
  credit: string;
  memo: string | null;
}

const UNASSIGNED = (role: string) => `UNASSIGNED-${role}`;

function fmt(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function debit(account: string | null | undefined, role: string, amount: number, memo: string): JournalLineDraft {
  return {
    accountCode: account?.trim() || UNASSIGNED(role),
    debit: fmt(amount),
    credit: "0.00",
    memo,
  };
}

function credit(account: string | null | undefined, role: string, amount: number, memo: string): JournalLineDraft {
  return {
    accountCode: account?.trim() || UNASSIGNED(role),
    debit: "0.00",
    credit: fmt(amount),
    memo,
  };
}

export function buildJournalLines(
  classification: LeaseClassification,
  amounts: ScheduleAmounts,
  accounts: LeaseAccounts,
  periodLabel: string,
): JournalLineDraft[] {
  const memo = `Period ${periodLabel}`;

  if (classification === "finance") {
    return [
      debit(accounts.interestExpenseAccount, "INTEREST_EXPENSE", amounts.interest, memo),
      debit(accounts.amortizationExpenseAccount, "AMORTIZATION_EXPENSE", amounts.rouAmortization, memo),
      debit(accounts.leaseLiabilityAccount, "LEASE_LIABILITY", amounts.principal, memo),
      credit(accounts.rouAssetAccount, "ROU_ASSET", amounts.rouAmortization, memo),
      credit(accounts.cashAccount, "CASH", amounts.payment, memo),
    ];
  }

  // Operating: total lease expense = interest + rouAmortization (straight-line).
  // We use amortizationExpenseAccount as the lease-expense account by default.
  const straightLineExpense = amounts.interest + amounts.rouAmortization;
  return [
    debit(accounts.amortizationExpenseAccount, "LEASE_EXPENSE", straightLineExpense, memo),
    debit(accounts.leaseLiabilityAccount, "LEASE_LIABILITY", amounts.principal, memo),
    credit(accounts.rouAssetAccount, "ROU_ASSET", amounts.rouAmortization, memo),
    credit(accounts.cashAccount, "CASH", amounts.payment, memo),
  ];
}

/** Flip debits ↔ credits for a reversal JE. */
export function reverseLines(lines: JournalLineDraft[], periodLabel: string): JournalLineDraft[] {
  return lines.map((l) => ({
    accountCode: l.accountCode,
    debit: l.credit,
    credit: l.debit,
    memo: `Reversal of period ${periodLabel}`,
  }));
}

/** Throws if debits ≠ credits (within rounding). */
export function assertBalanced(lines: JournalLineDraft[]): void {
  const totalDr = lines.reduce((s, l) => s + parseFloat(l.debit), 0);
  const totalCr = lines.reduce((s, l) => s + parseFloat(l.credit), 0);
  if (Math.abs(totalDr - totalCr) > 0.01) {
    throw new Error(`Journal entry not balanced: Dr ${totalDr.toFixed(2)} ≠ Cr ${totalCr.toFixed(2)}`);
  }
}

/** YYYY-MM from a YYYY-MM-DD date string. */
export function periodLabelFromDate(date: string): string {
  return date.slice(0, 7);
}
