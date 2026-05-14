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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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

function AccountPicker(props: {
  value: string;
  onChange: (v: string) => void;
  accounts: Array<{ qboId: string; acctNum?: string | null; name: string; accountType?: string | null; active: boolean }>;
  testId: string;
}) {
  if (props.accounts.length === 0) {
    return (
      <Input
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder="Account code"
        data-testid={props.testId}
      />
    );
  }
  const known = props.accounts.some((a) => a.qboId === props.value);
  return (
    <Select onValueChange={props.onChange} value={props.value || ""}>
      <SelectTrigger data-testid={props.testId}>
        <SelectValue placeholder="Select QBO account…" />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {!known && props.value && (
          <SelectItem value={props.value} disabled>
            ⚠ Legacy: {props.value}
          </SelectItem>
        )}
        {props.accounts
          .filter((a) => a.active)
          .map((a) => (
            <SelectItem key={a.qboId} value={a.qboId}>
              {a.acctNum ? `${a.acctNum} — ${a.name}` : a.name}
              {a.accountType ? ` (${a.accountType})` : ""}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}

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

  const [values, setValues] = useState<Record<AccountField, string>>({
    rouAssetAccount: lease.rouAssetAccount ?? "",
    leaseLiabilityAccount: lease.leaseLiabilityAccount ?? "",
    interestExpenseAccount: lease.interestExpenseAccount ?? "",
    amortizationExpenseAccount: lease.amortizationExpenseAccount ?? "",
    cashAccount: lease.cashAccount ?? "",
  });

  // Re-seed when the lease prop changes (e.g. after another edit refetches it).
  useEffect(() => {
    if (open) {
      setValues({
        rouAssetAccount: lease.rouAssetAccount ?? "",
        leaseLiabilityAccount: lease.leaseLiabilityAccount ?? "",
        interestExpenseAccount: lease.interestExpenseAccount ?? "",
        amortizationExpenseAccount: lease.amortizationExpenseAccount ?? "",
        cashAccount: lease.cashAccount ?? "",
      });
    }
  }, [open, lease]);

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
