import { useState } from "react";
import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, ArrowLeft, Info, Undo2, AlertTriangle, CheckCircle2, RefreshCw, CloudOff, XCircle } from "lucide-react";
import {
  useGetLease,
  getGetLeaseQueryKey,
  usePostLeasePayments,
  useUnpostLeasePayment,
  useGetLeaseJournalEntries,
  getGetLeaseJournalEntriesQueryKey,
  getListLeasesQueryKey,
  getGetLeasesSummaryQueryKey,
  syncQboJournalEntry,
  useGetQboStatus,
  getGetQboStatusQueryKey,
} from "@workspace/api-client-react";

import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatPercent, formatDate } from "@/lib/format";

export default function LeaseDetailPage() {
  const { id } = useParams<{ id: string }>();
  const leaseId = parseInt(id, 10);
  
  const { data: lease, isLoading } = useGetLease(leaseId, {
    query: {
      enabled: !isNaN(leaseId),
      queryKey: getGetLeaseQueryKey(leaseId)
    }
  });

  const [postModalOpen, setPostModalOpen] = useState(false);
  const [throughPeriod, setThroughPeriod] = useState<number | "">("");
  // Captured from a 400 { missingAccounts: [...] } response — surfaces inline
  // on the lease detail page rather than only as a transient toast.
  const [postMissingAccounts, setPostMissingAccounts] = useState<
    Array<{ field: string; label: string }> | null
  >(null);

  const postPayments = usePostLeasePayments();
  const unpostPayment = useUnpostLeasePayment();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: journalEntries } = useGetLeaseJournalEntries(leaseId, {
    query: {
      enabled: !isNaN(leaseId),
      queryKey: getGetLeaseJournalEntriesQueryKey(leaseId),
    },
  });

  const { data: qboStatus } = useGetQboStatus({
    query: { queryKey: getGetQboStatusQueryKey() },
  });
  // QBO transaction deep-link base. Sandbox and production use different hosts.
  const qboBase = qboStatus?.connected
    ? (qboStatus.environment === "production"
        ? "https://qbo.intuit.com"
        : "https://sandbox.qbo.intuit.com")
    : null;
  function qboJeUrl(qboId: string): string | null {
    if (!qboBase) return null;
    return `${qboBase}/app/journalentry?txnId=${encodeURIComponent(qboId)}`;
  }
  // Map of schedule entry id → the qboId of the latest non-reversed JE for
  // that schedule row. Used to deep-link the "posted" status badge in the
  // schedule table directly to the journal entry inside QuickBooks. Keyed by
  // scheduleEntryId (not period) because period strings like "2025-01" can
  // recur across leases and we want a precise 1:1 mapping.
  const scheduleEntryToQboId = new Map<number, string>();
  for (const je of journalEntries ?? []) {
    if (je.status === "reversed") continue;
    if (!je.qboId) continue;
    scheduleEntryToQboId.set(je.scheduleEntryId, je.qboId);
  }

  const [syncingJeId, setSyncingJeId] = useState<number | null>(null);

  async function handleRetryQboSync(jeId: number) {
    setSyncingJeId(jeId);
    try {
      await syncQboJournalEntry(jeId);
      toast({ title: "Synced to QuickBooks" });
      queryClient.invalidateQueries({ queryKey: getGetLeaseJournalEntriesQueryKey(leaseId) });
    } catch (err) {
      const message = (err as { data?: { error?: string }; message?: string }).data?.error
        ?? (err as Error).message;
      toast({ title: "QuickBooks sync failed", description: message, variant: "destructive" });
    } finally {
      setSyncingJeId(null);
    }
  }

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: getGetLeaseQueryKey(leaseId) });
    queryClient.invalidateQueries({ queryKey: getGetLeaseJournalEntriesQueryKey(leaseId) });
    queryClient.invalidateQueries({ queryKey: getListLeasesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetLeasesSummaryQueryKey() });
  };

  const handlePost = () => {
    if (!throughPeriod) return;
    postPayments.mutate({ id: leaseId, data: { throughPeriod: Number(throughPeriod) } }, {
      onSuccess: () => {
        toast({ title: "Payments posted successfully" });
        setPostMissingAccounts(null);
        invalidateAll();
        setPostModalOpen(false);
        setThroughPeriod("");
      },
      onError: (err) => {
        // The post endpoint returns { error, missingAccounts? } — surface the
        // typed payload as an inline panel so users know exactly which lease
        // fields to fill in. The narrowing through `unknown` is needed because
        // the generated ApiError<T> only knows about the success-shape data.
        const data = err.data as { error?: string; missingAccounts?: Array<{ field: string; label: string }> } | undefined;
        if (data?.missingAccounts && data.missingAccounts.length > 0) {
          setPostMissingAccounts(data.missingAccounts);
          setPostModalOpen(false);
        } else {
          toast({ title: "Error posting payments", description: data?.error, variant: "destructive" });
        }
      }
    });
  };

  const handleUnpost = (periodNumber: number) => {
    unpostPayment.mutate({ id: leaseId, periodNumber }, {
      onSuccess: () => {
        toast({ title: `Period ${periodNumber} reversed`, description: "An offsetting journal entry has been recorded." });
        invalidateAll();
      },
      onError: (err) => {
        toast({ title: "Error reversing period", description: err.data?.error, variant: "destructive" });
      }
    });
  };

  if (isLoading) {
    return (
      <Layout>
        <div className="space-y-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-[200px] w-full" />
          <Skeleton className="h-[400px] w-full" />
        </div>
      </Layout>
    );
  }

  if (!lease) {
    return (
      <Layout>
        <div className="text-center py-12">
          <h2 className="text-xl font-semibold">Lease not found</h2>
          <Button variant="link" asChild className="mt-4">
            <Link href="/">Back to leases</Link>
          </Button>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="flex flex-col gap-6">
        <div className="flex items-center text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors flex items-center gap-1">
            <ArrowLeft className="w-4 h-4" />
            Leases
          </Link>
          <ChevronRight className="w-4 h-4 mx-1" />
          <span className="text-foreground font-medium" data-testid="breadcrumb-lease-name">{lease.name}</span>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-3xl font-bold tracking-tight">{lease.name}</h1>
            <Badge variant={lease.status === "active" ? "default" : lease.status === "expired" ? "secondary" : "outline"}>
              {lease.status}
            </Badge>
            {lease.isShortTerm && (
              <Badge variant="outline" className="border-blue-300 text-blue-700 dark:border-blue-800 dark:text-blue-300" data-testid="badge-shortterm">
                Short-term
              </Badge>
            )}
          </div>
          {!lease.isShortTerm && (() => {
            // Mirror the server's validateAccountsForPost so we can disable the
            // button and explain why before the user even clicks it. Source of
            // truth lives in artifacts/api-server/src/lib/journal.ts; we only
            // duplicate the field list here for UX (the server still enforces).
            const required: Array<{ field: keyof typeof lease; label: string }> =
              lease.leaseClassification === "finance"
                ? [
                    { field: "interestExpenseAccount", label: "Interest Expense Account" },
                    { field: "amortizationExpenseAccount", label: "Amortization Expense Account" },
                    { field: "leaseLiabilityAccount", label: "Lease Liability Account" },
                    { field: "rouAssetAccount", label: "ROU Asset Account" },
                    { field: "cashAccount", label: "Cash Account" },
                  ]
                : [
                    { field: "amortizationExpenseAccount", label: "Lease Expense Account" },
                    { field: "leaseLiabilityAccount", label: "Lease Liability Account" },
                    { field: "rouAssetAccount", label: "ROU Asset Account" },
                    { field: "cashAccount", label: "Cash Account" },
                  ];
            const missing = required.filter((r) => {
              const v = lease[r.field];
              return typeof v !== "string" || v.trim() === "";
            });
            const button = (
              <Button
                onClick={() => setPostModalOpen(true)}
                disabled={missing.length > 0}
                data-testid="button-post-payments"
              >
                Post Payments
              </Button>
            );
            if (missing.length === 0) return button;
            return (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={0}>{button}</span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <p className="font-medium mb-1">Missing GL accounts:</p>
                    <ul className="list-disc pl-4 text-xs">
                      {missing.map((m) => <li key={m.field}>{m.label}</li>)}
                    </ul>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            );
          })()}
        </div>

        {postMissingAccounts && postMissingAccounts.length > 0 && (
          <div
            className="flex items-start gap-3 p-4 rounded-md border border-destructive/30 bg-destructive/5"
            data-testid="alert-missing-accounts"
          >
            <AlertTriangle className="h-5 w-5 shrink-0 text-destructive mt-0.5" />
            <div className="flex-1 space-y-1 text-sm">
              <p className="font-medium text-destructive">Cannot post: missing GL account mappings</p>
              <p className="text-muted-foreground">
                Fill in the following accounts on the lease before posting:
              </p>
              <ul className="list-disc pl-5 text-foreground">
                {postMissingAccounts.map((m) => (
                  <li key={m.field}>{m.label}</li>
                ))}
              </ul>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPostMissingAccounts(null)}
              data-testid="button-dismiss-missing-accounts"
            >
              Dismiss
            </Button>
          </div>
        )}

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Lease Details</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-y-6 gap-x-8">
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Lessor</span>
                <p className="font-medium">{lease.lessor}</p>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Commencement</span>
                <p className="font-medium">{formatDate(lease.commencementDate)}</p>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Term</span>
                <p className="font-medium">{lease.termMonths} Months</p>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Frequency</span>
                <p className="font-medium capitalize">{lease.paymentFrequency}</p>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Monthly Payment</span>
                <p className="font-medium font-mono">{formatCurrency(lease.monthlyPayment)}</p>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Present Value</span>
                <p className="font-medium font-mono">{formatCurrency(lease.presentValue)}</p>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Borrowing Rate</span>
                <p className="font-medium font-mono">{formatPercent(lease.borrowingRate)}</p>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Classification</span>
                <p className="font-medium capitalize">{lease.leaseClassification}</p>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Payment Timing</span>
                <p className="font-medium capitalize">{lease.paymentTiming}</p>
              </div>
            </div>

            {((lease.prepaidRent ?? 0) > 0 ||
              (lease.initialDirectCosts ?? 0) > 0 ||
              (lease.leaseIncentives ?? 0) > 0) && (
              <div className="mt-8 pt-6 border-t" data-testid="section-rou-adjustments">
                <h3 className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-4">
                  Opening ROU Adjustments
                </h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-y-6 gap-x-8">
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Prepaid Rent</span>
                    <p className="font-medium font-mono">{formatCurrency(lease.prepaidRent ?? 0)}</p>
                  </div>
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Initial Direct Costs</span>
                    <p className="font-medium font-mono">{formatCurrency(lease.initialDirectCosts ?? 0)}</p>
                  </div>
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Lease Incentives</span>
                    <p className="font-medium font-mono">−{formatCurrency(lease.leaseIncentives ?? 0)}</p>
                  </div>
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Opening ROU Asset</span>
                    <p className="font-medium font-mono text-foreground">{formatCurrency(lease.openingRouAsset ?? lease.presentValue)}</p>
                  </div>
                </div>
              </div>
            )}
            
            {(lease.rouAssetAccount || lease.leaseLiabilityAccount) && (
              <div className="mt-8 pt-6 border-t grid grid-cols-2 md:grid-cols-4 gap-y-6 gap-x-8">
                {lease.rouAssetAccount && (
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">ROU Asset</span>
                    <p className="font-mono">{lease.rouAssetAccount}</p>
                  </div>
                )}
                {lease.leaseLiabilityAccount && (
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Liability</span>
                    <p className="font-mono">{lease.leaseLiabilityAccount}</p>
                  </div>
                )}
                {lease.interestExpenseAccount && (
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Interest Exp</span>
                    <p className="font-mono">{lease.interestExpenseAccount}</p>
                  </div>
                )}
                {lease.amortizationExpenseAccount && (
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Amort Exp</span>
                    <p className="font-mono">{lease.amortizationExpenseAccount}</p>
                  </div>
                )}
                {lease.cashAccount && (
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Cash Acct</span>
                    <p className="font-mono">{lease.cashAccount}</p>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {lease.isShortTerm ? (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-start gap-3 p-4 rounded-md border border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30" data-testid="note-shortterm">
                <Info className="h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400 mt-0.5" />
                <div className="space-y-1 text-sm">
                  <p className="font-medium text-blue-900 dark:text-blue-100">Short-term lease election (ASC 842 §842-20-25-2)</p>
                  <p className="text-blue-700 dark:text-blue-300">
                    No amortization schedule, ROU asset, or lease liability is recorded.
                    Recognize the periodic payment of {formatCurrency(lease.monthlyPayment)} as
                    straight-line expense each {lease.paymentFrequency?.replace(/ly$/, "") ?? "month"}
                    {" "}for {lease.termMonths} months.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : (
        <Tabs defaultValue="schedule" className="w-full">
          <TabsList>
            <TabsTrigger value="schedule" data-testid="tab-schedule">Amortization Schedule</TabsTrigger>
            <TabsTrigger value="journal" data-testid="tab-journal">
              Journal Entries{journalEntries ? ` (${journalEntries.length})` : ""}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="schedule" className="mt-4">
            <Card>
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead className="w-12">#</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Payment Date</TableHead>
                    <TableHead className="text-right">Beg. Balance</TableHead>
                    <TableHead className="text-right">Payment</TableHead>
                    <TableHead className="text-right">Interest</TableHead>
                    <TableHead className="text-right">Principal</TableHead>
                    <TableHead className="text-right">ROU Amort.</TableHead>
                    <TableHead className="text-right">End. Balance</TableHead>
                    <TableHead className="w-20 pr-6 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lease.schedule?.map((entry) => (
                    <TableRow key={entry.id} className={entry.status === 'posted' ? 'bg-muted/20' : ''}>
                      <TableCell className="font-medium text-muted-foreground">{entry.periodNumber}</TableCell>
                      <TableCell>
                        {(() => {
                          const qboId = scheduleEntryToQboId.get(entry.id);
                          const url = qboId ? qboJeUrl(qboId) : null;
                          const badge = (
                            <Badge
                              variant={entry.status === 'posted' ? "secondary" : "outline"}
                              className={`text-[10px] ${url ? "cursor-pointer hover:underline" : ""}`}
                            >
                              {entry.status}
                              {url && <span className="ml-1 opacity-70">↗</span>}
                            </Badge>
                          );
                          return url ? (
                            <a
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={`Open JE ${qboId} in QuickBooks`}
                              data-testid={`link-qbo-period-${entry.periodNumber}`}
                            >
                              {badge}
                            </a>
                          ) : (
                            badge
                          );
                        })()}
                      </TableCell>
                      <TableCell>{formatDate(entry.paymentDate)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{formatCurrency(entry.beginningBalance)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{formatCurrency(entry.payment)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{formatCurrency(entry.interest)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{formatCurrency(entry.principal)}</TableCell>
                      <TableCell className="text-right font-mono text-sm text-muted-foreground">{formatCurrency(entry.rouAmortization)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{formatCurrency(entry.endingBalance)}</TableCell>
                      <TableCell className="text-right pr-6">
                        {entry.status === 'posted' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleUnpost(entry.periodNumber)}
                            disabled={unpostPayment.isPending}
                            data-testid={`button-unpost-${entry.periodNumber}`}
                            title="Reverse this posting"
                          >
                            <Undo2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {!lease.schedule?.length && (
                    <TableRow>
                      <TableCell colSpan={10} className="h-32 text-center text-muted-foreground">
                        No schedule entries found.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>

          <TabsContent value="journal" className="mt-4">
            <Card>
              <CardContent className="pt-6">
                {!journalEntries?.length ? (
                  <div className="text-center text-muted-foreground py-12 text-sm" data-testid="empty-journal">
                    No journal entries yet. Post a payment to generate one.
                  </div>
                ) : (
                  <div className="space-y-6">
                    {journalEntries.map((je) => {
                      const totalDr = je.lines.reduce((s, l) => s + l.debit, 0);
                      const totalCr = je.lines.reduce((s, l) => s + l.credit, 0);
                      return (
                        <div
                          key={je.id}
                          className="border rounded-md overflow-hidden"
                          data-testid={`je-${je.id}`}
                        >
                          <div className="flex items-center justify-between px-4 py-3 bg-muted/40 border-b gap-3">
                            <div className="flex items-center gap-3 flex-wrap">
                              <span className="text-sm font-mono text-muted-foreground">JE #{je.id}</span>
                              <span className="text-sm font-medium">{je.period}</span>
                              <Badge
                                variant={je.status === 'posted' ? "secondary" : "outline"}
                                className={je.status === 'reversed' ? "border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300" : ""}
                              >
                                {je.status}
                              </Badge>
                              {je.reversesEntryId && (
                                <span className="text-xs text-muted-foreground">
                                  reverses JE #{je.reversesEntryId}
                                </span>
                              )}
                              <QboJeBadge je={je} onRetry={handleRetryQboSync} qboBase={qboBase} />
                            </div>
                            <span className="text-xs text-muted-foreground">
                              {formatDate(je.postedAt)}
                            </span>
                          </div>
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Account</TableHead>
                                <TableHead>Memo</TableHead>
                                <TableHead className="text-right">Debit</TableHead>
                                <TableHead className="text-right pr-6">Credit</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {je.lines.map((l) => (
                                <TableRow key={l.id}>
                                  <TableCell className="font-mono text-sm">{l.accountCode}</TableCell>
                                  <TableCell className="text-sm text-muted-foreground">{l.memo ?? ""}</TableCell>
                                  <TableCell className="text-right font-mono text-sm">
                                    {l.debit > 0 ? formatCurrency(l.debit) : ""}
                                  </TableCell>
                                  <TableCell className="text-right font-mono text-sm pr-6">
                                    {l.credit > 0 ? formatCurrency(l.credit) : ""}
                                  </TableCell>
                                </TableRow>
                              ))}
                              <TableRow className="border-t-2 font-semibold">
                                <TableCell colSpan={2} className="text-right text-xs uppercase tracking-wider text-muted-foreground">
                                  Totals
                                </TableCell>
                                <TableCell className="text-right font-mono text-sm">{formatCurrency(totalDr)}</TableCell>
                                <TableCell className="text-right font-mono text-sm pr-6">{formatCurrency(totalCr)}</TableCell>
                              </TableRow>
                            </TableBody>
                          </Table>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
        )}
      </div>

      <Dialog open={postModalOpen} onOpenChange={setPostModalOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Post Payments</DialogTitle>
            <DialogDescription>
              This will update the status of schedule entries to "posted".
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="period" className="text-right">
                Through Period
              </Label>
              <Input
                id="period"
                type="number"
                min="1"
                max={lease.termMonths}
                value={throughPeriod}
                onChange={(e) => setThroughPeriod(e.target.value ? parseInt(e.target.value) : "")}
                className="col-span-3"
                data-testid="input-post-period"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPostModalOpen(false)}>Cancel</Button>
            <Button onClick={handlePost} disabled={!throughPeriod || postPayments.isPending} data-testid="button-confirm-post">
              {postPayments.isPending ? "Posting..." : "Post"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}

/**
 * Visual indicator of where a JE stands with QuickBooks. The four meaningful
 * states map to:
 *   - synced  → green check + QBO Id
 *   - failed  → red badge with retry button (tooltip carries the error text)
 *   - skipped → muted "QBO off" chip (no connection at the time of post)
 *   - null    → nothing (legacy JE created before integration existed)
 */
function QboJeBadge(props: {
  je: {
    id: number;
    qboId?: string | null;
    qboSyncStatus?: string | null;
    qboSyncError?: string | null;
  };
  onRetry: (id: number) => void;
  qboBase: string | null;
}) {
  const { je, qboBase } = props;
  const status = je.qboSyncStatus;
  if (!status) return null;

  if (status === "synced") {
    const badge = (
      <Badge variant="outline" className={`gap-1 border-green-300 text-green-700 dark:border-green-800 dark:text-green-300 ${qboBase ? "cursor-pointer hover:underline" : ""}`} title={`QBO Id ${je.qboId ?? ""}`}>
        <CheckCircle2 className="h-3 w-3" />
        QBO #{je.qboId}
        {qboBase && <span className="ml-0.5 opacity-70">↗</span>}
      </Badge>
    );
    if (qboBase && je.qboId) {
      return (
        <a
          href={`${qboBase}/app/journalentry?txnId=${encodeURIComponent(je.qboId)}`}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`link-qbo-je-${je.id}`}
        >
          {badge}
        </a>
      );
    }
    return badge;
  }
  if (status === "skipped") {
    return (
      <Badge variant="outline" className="gap-1 text-muted-foreground" title="QuickBooks was not connected when this JE was posted">
        <CloudOff className="h-3 w-3" />
        QBO off
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex items-center gap-1.5">
        <Badge variant="outline" className="gap-1 border-red-300 text-red-700 dark:border-red-800 dark:text-red-300" title={je.qboSyncError ?? "QBO sync failed"}>
          <XCircle className="h-3 w-3" />
          QBO failed
        </Badge>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs gap-1"
          onClick={() => props.onRetry(je.id)}
          data-testid={`button-qbo-retry-${je.id}`}
        >
          <RefreshCw className="h-3 w-3" />
          Retry
        </Button>
      </span>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      QBO {status}
    </Badge>
  );
}
