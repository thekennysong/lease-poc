import { useState } from "react";
import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, ArrowLeft } from "lucide-react";
import { 
  useGetLease, 
  getGetLeaseQueryKey, 
  usePostLeasePayments,
  getListLeasesQueryKey,
  getGetLeasesSummaryQueryKey
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
  
  const postPayments = usePostLeasePayments();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handlePost = () => {
    if (!throughPeriod) return;
    postPayments.mutate({ id: leaseId, data: { throughPeriod: Number(throughPeriod) } }, {
      onSuccess: () => {
        toast({ title: "Payments posted successfully" });
        queryClient.invalidateQueries({ queryKey: getGetLeaseQueryKey(leaseId) });
        queryClient.invalidateQueries({ queryKey: getListLeasesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetLeasesSummaryQueryKey() });
        setPostModalOpen(false);
        setThroughPeriod("");
      },
      onError: (err) => {
        toast({ title: "Error posting payments", description: err.data?.error, variant: "destructive" });
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
          </div>
          <Button onClick={() => setPostModalOpen(true)} data-testid="button-post-payments">
            Post Payments
          </Button>
        </div>

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
            </div>
            
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

        <Card>
          <CardHeader className="pb-3 border-b">
            <CardTitle className="text-lg">Amortization Schedule</CardTitle>
          </CardHeader>
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
                <TableHead className="text-right pr-6">End. Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lease.schedule?.map((entry) => (
                <TableRow key={entry.id} className={entry.status === 'posted' ? 'bg-muted/20' : ''}>
                  <TableCell className="font-medium text-muted-foreground">{entry.periodNumber}</TableCell>
                  <TableCell>
                    <Badge variant={entry.status === 'posted' ? "secondary" : "outline"} className="text-[10px]">
                      {entry.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{formatDate(entry.paymentDate)}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{formatCurrency(entry.beginningBalance)}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{formatCurrency(entry.payment)}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{formatCurrency(entry.interest)}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{formatCurrency(entry.principal)}</TableCell>
                  <TableCell className="text-right font-mono text-sm text-muted-foreground">{formatCurrency(entry.rouAmortization)}</TableCell>
                  <TableCell className="text-right font-mono text-sm pr-6">{formatCurrency(entry.endingBalance)}</TableCell>
                </TableRow>
              ))}
              {!lease.schedule?.length && (
                <TableRow>
                  <TableCell colSpan={9} className="h-32 text-center text-muted-foreground">
                    No schedule entries found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
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
