import { useState } from "react";
import { Link } from "wouter";
import { useListLeases, useGetLeasesSummary, useDeleteLease, getListLeasesQueryKey, getGetLeasesSummaryQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Search, MoreHorizontal, FileSpreadsheet, Building2, Trash2 } from "lucide-react";

import { Layout } from "@/components/Layout";
import { AddLeaseModal } from "@/components/AddLeaseModal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatPercent, formatDate } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export default function LeasesPage() {
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [leaseToDelete, setLeaseToDelete] = useState<number | null>(null);
  
  const { data: summary, isLoading: loadingSummary } = useGetLeasesSummary();
  const { data: leases, isLoading: loadingLeases } = useListLeases();
  
  const deleteLease = useDeleteLease();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const filteredLeases = leases?.filter(lease => 
    lease.name.toLowerCase().includes(search.toLowerCase()) || 
    lease.lessor.toLowerCase().includes(search.toLowerCase())
  ) || [];

  const handleDelete = () => {
    if (!leaseToDelete) return;
    deleteLease.mutate({ id: leaseToDelete }, {
      onSuccess: () => {
        toast({ title: "Lease deleted" });
        queryClient.invalidateQueries({ queryKey: getListLeasesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetLeasesSummaryQueryKey() });
        setLeaseToDelete(null);
      },
      onError: (err) => {
        toast({ title: "Failed to delete", description: err.error, variant: "destructive" });
      }
    });
  };

  return (
    <Layout>
      <div className="flex flex-col gap-8">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Active Leases</CardTitle>
              <Building2 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {loadingSummary ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                <div className="text-2xl font-bold" data-testid="summary-active">{summary?.activeLeases || 0}</div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Interest Expense (YTD)</CardTitle>
              <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {loadingSummary ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <div className="text-2xl font-bold" data-testid="summary-interest">{formatCurrency(summary?.interestExpenseYtd)}</div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Outstanding Liability</CardTitle>
              <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {loadingSummary ? (
                <Skeleton className="h-8 w-32" />
              ) : (
                <div className="text-2xl font-bold" data-testid="summary-liability">{formatCurrency(summary?.outstandingLeaseLiability)}</div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex items-center justify-between">
          <div className="relative w-72">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search leases..."
              className="pl-8 bg-card"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="input-search"
            />
          </div>
          <Button onClick={() => setModalOpen(true)} data-testid="button-add-lease">
            <Plus className="mr-2 h-4 w-4" />
            Add Lease
          </Button>
        </div>

        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lease Name</TableHead>
                <TableHead>Lessor</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead className="text-right">Term</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="text-right">Next Payment</TableHead>
                <TableHead>Next Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[50px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loadingLeases ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-5 w-32" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-24" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-12 ml-auto" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-8 ml-auto" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-20 ml-auto" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-16 ml-auto" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-20" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-16" /></TableCell>
                    <TableCell></TableCell>
                  </TableRow>
                ))
              ) : filteredLeases.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="h-32 text-center text-muted-foreground">
                    No leases found.
                  </TableCell>
                </TableRow>
              ) : (
                filteredLeases.map((lease) => (
                  <TableRow key={lease.id} data-testid={`row-lease-${lease.id}`}>
                    <TableCell className="font-medium">
                      <Link href={`/leases/${lease.id}`} className="hover:underline">
                        {lease.name}
                      </Link>
                    </TableCell>
                    <TableCell>{lease.lessor}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{formatPercent(lease.borrowingRate)}</TableCell>
                    <TableCell className="text-right">{lease.termMonths} mo</TableCell>
                    <TableCell className="text-right font-mono text-sm">{formatCurrency(lease.currentBalance ?? lease.presentValue)}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{formatCurrency(lease.nextPayment ?? lease.monthlyPayment)}</TableCell>
                    <TableCell>{formatDate(lease.nextPaymentDate ?? lease.commencementDate)}</TableCell>
                    <TableCell>
                      <Badge variant={lease.status === "active" ? "default" : lease.status === "expired" ? "secondary" : "outline"}>
                        {lease.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" className="h-8 w-8 p-0" data-testid={`menu-lease-${lease.id}`}>
                            <span className="sr-only">Open menu</span>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuLabel>Actions</DropdownMenuLabel>
                          <Link href={`/leases/${lease.id}`}>
                            <DropdownMenuItem className="cursor-pointer" data-testid={`menu-view-${lease.id}`}>
                              View lease
                            </DropdownMenuItem>
                          </Link>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem 
                            className="text-destructive focus:text-destructive cursor-pointer"
                            onClick={() => setLeaseToDelete(lease.id)}
                            data-testid={`menu-delete-${lease.id}`}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete lease
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>
      </div>

      <AddLeaseModal open={modalOpen} onOpenChange={setModalOpen} />

      <AlertDialog open={!!leaseToDelete} onOpenChange={(open) => !open && setLeaseToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the lease
              and all of its schedule entries.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90" data-testid="button-confirm-delete">
              {deleteLease.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Layout>
  );
}
