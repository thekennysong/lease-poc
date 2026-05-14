import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useUpdateLease,
  useGetQboAccounts,
  getGetQboAccountsQueryKey,
  getGetLeaseQueryKey,
  getListLeasesQueryKey,
  getGetLeasesSummaryQueryKey,
  type Lease,
} from "@workspace/api-client-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { AccountPicker } from "@/components/AccountPicker";
import { useToast } from "@/hooks/use-toast";

type AccountField =
  | "rouAssetAccount"
  | "leaseLiabilityAccount"
  | "interestExpenseAccount"
  | "amortizationExpenseAccount"
  | "cashAccount";

const FIELDS: Array<{ key: AccountField; label: string }> = [
  { key: "rouAssetAccount", label: "ROU Asset Account" },
  { key: "leaseLiabilityAccount", label: "Lease Liability Account" },
  { key: "interestExpenseAccount", label: "Interest Expense Account" },
  { key: "amortizationExpenseAccount", label: "Amortization / Lease Expense Account" },
  { key: "cashAccount", label: "Cash / Bank Account" },
];

export function EditAccountsDialog({
  lease,
  open,
  onOpenChange,
}: {
  lease: Lease;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateLease = useUpdateLease();

  const { data: qboAccountsData } = useGetQboAccounts({
    query: { queryKey: getGetQboAccountsQueryKey(), retry: false, throwOnError: false },
  });
  const qboAccounts = qboAccountsData?.accounts ?? [];

  // If the stored value is a QBO account number (the human-readable code,
  // e.g. "1800") rather than the QBO internal Id (e.g. "33"), look it up by
  // AcctNum. Falls back to a case-insensitive name match so manually-typed
  // account names also resolve. Returns the original value if nothing matches.
  function resolveToQboId(stored: string): string {
    if (!stored) return stored;
    if (qboAccounts.some((a) => a.qboId === stored)) return stored;
    const byNum = qboAccounts.find((a) => a.acctNum && a.acctNum === stored);
    if (byNum) return byNum.qboId;
    const lc = stored.toLowerCase();
    const byName = qboAccounts.find((a) => a.name.toLowerCase() === lc);
    if (byName) return byName.qboId;
    return stored;
  }

  const [values, setValues] = useState<Record<AccountField, string>>({
    rouAssetAccount: lease.rouAssetAccount ?? "",
    leaseLiabilityAccount: lease.leaseLiabilityAccount ?? "",
    interestExpenseAccount: lease.interestExpenseAccount ?? "",
    amortizationExpenseAccount: lease.amortizationExpenseAccount ?? "",
    cashAccount: lease.cashAccount ?? "",
  });
  // Track which fields we auto-resolved from a legacy code so we can show a
  // hint banner. Cleared on every reseed.
  const [autoResolved, setAutoResolved] = useState<AccountField[]>([]);

  // Re-seed when the lease prop changes or COA finishes loading. The
  // resolution depends on `qboAccounts`, so we re-run it once accounts are
  // available — otherwise the first render (with an empty COA) would leave
  // every value untouched and the user would still see "Legacy: 1800".
  useEffect(() => {
    if (!open) return;
    const raw: Record<AccountField, string> = {
      rouAssetAccount: lease.rouAssetAccount ?? "",
      leaseLiabilityAccount: lease.leaseLiabilityAccount ?? "",
      interestExpenseAccount: lease.interestExpenseAccount ?? "",
      amortizationExpenseAccount: lease.amortizationExpenseAccount ?? "",
      cashAccount: lease.cashAccount ?? "",
    };
    const resolved: Record<AccountField, string> = { ...raw };
    const changed: AccountField[] = [];
    for (const f of FIELDS) {
      const next = resolveToQboId(raw[f.key]);
      if (next !== raw[f.key]) {
        resolved[f.key] = next;
        changed.push(f.key);
      }
    }
    setValues(resolved);
    setAutoResolved(changed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lease, qboAccounts.length]);

  function handleSave() {
    updateLease.mutate(
      { id: lease.id, data: values },
      {
        onSuccess: () => {
          toast({
            title: "GL accounts updated",
            description:
              qboAccounts.length > 0
                ? "Unsynced journal entries were updated. You can re-run “Sync all posted JEs”."
                : "Saved.",
          });
          queryClient.invalidateQueries({ queryKey: getGetLeaseQueryKey(lease.id) });
          queryClient.invalidateQueries({ queryKey: getListLeasesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetLeasesSummaryQueryKey() });
          onOpenChange(false);
        },
        onError: (err) => {
          toast({
            title: "Failed to update GL accounts",
            description: err.data?.error || "An unknown error occurred",
            variant: "destructive",
          });
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit GL Accounts</DialogTitle>
          <DialogDescription>
            {qboAccounts.length > 0
              ? `Pick from your synced QuickBooks chart of accounts (${qboAccounts.length} active accounts).`
              : "Connect QuickBooks to pick accounts from your chart of accounts."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {autoResolved.length > 0 && (
            <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100">
              Matched {autoResolved.length} field{autoResolved.length === 1 ? "" : "s"} to your QuickBooks chart of accounts by account number. Click <strong>Save</strong> to apply.
            </div>
          )}
          {qboAccounts.length > 0 && qboAccounts.every((a) => !a.acctNum) && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
              Your QuickBooks company doesn&apos;t have account numbers enabled, so legacy codes like <code>1800</code> can&apos;t be auto-matched. Pick the right account from each dropdown below, or enable account numbers in QuickBooks (Settings → Account and Settings → Advanced) and re-sync the chart of accounts.
            </div>
          )}
          {FIELDS.map((f) => (
            <div key={f.key} className="space-y-2">
              <Label>{f.label}</Label>
              <AccountPicker
                value={values[f.key]}
                onChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))}
                accounts={qboAccounts}
                testId={`edit-${f.key}`}
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={updateLease.isPending}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={updateLease.isPending} data-testid="button-save-accounts">
            {updateLease.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
