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
 *   Dr Lease Expense           leaseExpense (straight-line, persisted on the
 *                              schedule entry — NOT reconstructed here)
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
  /**
   * The period's P&L expense. For operating leases this is the straight-line
   * lease expense and is the SOLE source for the Dr Lease Expense line — the
   * JE builder never falls back to `interest + rouAmortization`.
   * For finance leases this field is unused (kept for symmetry).
   */
  leaseExpense: number;
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

function fmt(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function requireAccount(account: string | null | undefined, role: string): string {
  const trimmed = account?.trim();
  if (!trimmed) {
    // Defensive: validateAccountsForPost should have caught this before we
    // ever reach buildJournalLines. If it didn't, fail loud rather than
    // silently posting to an UNASSIGNED-* placeholder.
    throw new Error(`Missing GL account for role ${role}; call validateAccountsForPost first`);
  }
  return trimmed;
}

function debit(account: string | null | undefined, role: string, amount: number, memo: string): JournalLineDraft {
  return {
    accountCode: requireAccount(account, role),
    debit: fmt(amount),
    credit: "0.00",
    memo,
  };
}

function credit(account: string | null | undefined, role: string, amount: number, memo: string): JournalLineDraft {
  return {
    accountCode: requireAccount(account, role),
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

  // Operating: use the persisted straight-line lease expense directly. We do
  // NOT compute it as interest + rouAmortization here — that equivalence is
  // an invariant of the generator, not of the JE layer.
  return [
    debit(accounts.amortizationExpenseAccount, "LEASE_EXPENSE", amounts.leaseExpense, memo),
    debit(accounts.leaseLiabilityAccount, "LEASE_LIABILITY", amounts.principal, memo),
    credit(accounts.rouAssetAccount, "ROU_ASSET", amounts.rouAmortization, memo),
    credit(accounts.cashAccount, "CASH", amounts.payment, memo),
  ];
}

/**
 * Mapping of which lease GL accounts must be filled in to post a JE for each
 * classification. Returned as `{field, label}[]` so the API can echo the
 * camelCase field names back to the client for inline form errors.
 */
export interface MissingAccount {
  field: keyof LeaseAccounts;
  label: string;
}

const REQUIRED_BY_CLASSIFICATION: Record<LeaseClassification, MissingAccount[]> = {
  operating: [
    { field: "amortizationExpenseAccount", label: "Lease Expense Account" },
    { field: "leaseLiabilityAccount", label: "Lease Liability Account" },
    { field: "rouAssetAccount", label: "ROU Asset Account" },
    { field: "cashAccount", label: "Cash Account" },
  ],
  finance: [
    { field: "interestExpenseAccount", label: "Interest Expense Account" },
    { field: "amortizationExpenseAccount", label: "Amortization Expense Account" },
    { field: "leaseLiabilityAccount", label: "Lease Liability Account" },
    { field: "rouAssetAccount", label: "ROU Asset Account" },
    { field: "cashAccount", label: "Cash Account" },
  ],
};

/**
 * Returns the list of required lease-level GL account fields that are missing
 * (null, undefined, or whitespace-only) for the given classification. An empty
 * array means the lease is OK to post.
 *
 * Validation lives at post time (not lease creation) so users can save lease
 * drafts without account mappings during onboarding. They just can't post.
 */
export function validateAccountsForPost(
  classification: LeaseClassification,
  accounts: LeaseAccounts,
): MissingAccount[] {
  const required = REQUIRED_BY_CLASSIFICATION[classification];
  return required.filter((req) => {
    const value = accounts[req.field];
    return !value || value.trim() === "";
  });
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
