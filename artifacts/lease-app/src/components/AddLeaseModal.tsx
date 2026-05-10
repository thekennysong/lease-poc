import { useState, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { format } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import { useCreateLease, getListLeasesQueryKey, getGetLeasesSummaryQueryKey } from "@workspace/api-client-react";
import { CalendarIcon, Calculator, AlertTriangle } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatDate, round2 } from "@/lib/format";
import { cn } from "@/lib/utils";

type PaymentFrequency = "monthly" | "quarterly" | "annually";
type LeaseClassification = "operating" | "finance";

function paymentsPerYear(freq: PaymentFrequency): number {
  if (freq === "monthly") return 12;
  if (freq === "quarterly") return 4;
  return 1;
}

function monthsPerPeriod(freq: PaymentFrequency): number {
  return 12 / paymentsPerYear(freq);
}

/** Present value of an ordinary annuity */
function computePV(periodicPayment: number, annualRate: number, termMonths: number, freq: PaymentFrequency): number {
  const ppy = paymentsPerYear(freq);
  const r = annualRate / 100 / ppy;
  const n = termMonths / monthsPerPeriod(freq);
  if (r === 0) return round2(periodicPayment * n);
  return round2(periodicPayment * (1 - Math.pow(1 + r, -n)) / r);
}

const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  lessor: z.string().min(1, "Lessor is required"),
  commencementDate: z.date(),
  termMonths: z.coerce.number().min(1),
  monthlyPayment: z.coerce.number().min(0),
  presentValue: z.coerce.number().min(0),
  borrowingRate: z.coerce.number().min(0),
  leaseClassification: z.enum(["operating", "finance"]).default("operating"),
  rouAssetAccount: z.string().optional(),
  leaseLiabilityAccount: z.string().optional(),
  interestExpenseAccount: z.string().optional(),
  amortizationExpenseAccount: z.string().optional(),
  cashAccount: z.string().optional(),
  paymentFrequency: z.enum(["monthly", "quarterly", "annually"]).default("monthly"),
});

type FormValues = z.infer<typeof formSchema>;

interface AddLeaseModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddLeaseModal({ open, onOpenChange }: AddLeaseModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createLease = useCreateLease();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      lessor: "",
      commencementDate: new Date(new Date().getFullYear(), 0, 1),
      termMonths: 12,
      monthlyPayment: 0,
      presentValue: 0,
      borrowingRate: 0,
      leaseClassification: "operating",
      rouAssetAccount: "",
      leaseLiabilityAccount: "",
      interestExpenseAccount: "",
      amortizationExpenseAccount: "",
      cashAccount: "",
      paymentFrequency: "monthly",
    },
  });

  const watchValues = form.watch();

  // Whether termMonths is divisible by the period length for the chosen frequency
  const termValid = useMemo(() => {
    const mpp = monthsPerPeriod(watchValues.paymentFrequency);
    return watchValues.termMonths > 0 && watchValues.termMonths % mpp === 0;
  }, [watchValues.termMonths, watchValues.paymentFrequency]);

  // Computed PV from the annuity formula
  const computedPV = useMemo(() => {
    const { monthlyPayment, borrowingRate, termMonths, paymentFrequency } = watchValues;
    if (!monthlyPayment || borrowingRate == null || !termMonths) return null;
    if (!termValid) return null;
    return computePV(monthlyPayment, borrowingRate, termMonths, paymentFrequency);
  }, [watchValues.monthlyPayment, watchValues.borrowingRate, watchValues.termMonths, watchValues.paymentFrequency, termValid]);

  const pvDrift = computedPV !== null && watchValues.presentValue > 0
    ? Math.abs(watchValues.presentValue - computedPV) > 1
    : false;

  function handleComputePV() {
    if (computedPV !== null) {
      form.setValue("presentValue", computedPV);
    }
  }

  // Live schedule preview — mirrors the server logic exactly
  const previewSchedule = useMemo(() => {
    const { termMonths, presentValue, monthlyPayment, borrowingRate, commencementDate, paymentFrequency, leaseClassification } = watchValues;
    if (!termMonths || !presentValue || !monthlyPayment || borrowingRate == null || !commencementDate) return [];
    if (!termValid) return [];

    const ppy = paymentsPerYear(paymentFrequency);
    const mpp = monthsPerPeriod(paymentFrequency);
    const numPeriods = termMonths / mpp;
    const periodicRate = borrowingRate / 100 / ppy;

    const totalUndiscounted = monthlyPayment * numPeriods;
    const straightLineExpense = round2(totalUndiscounted / numPeriods);
    const financeRouPerPeriod = round2(presentValue / numPeriods);

    const schedule = [];
    let balance = presentValue;

    for (let i = 1; i <= numPeriods; i++) {
      const interest = round2(balance * periodicRate);
      const principal = round2(monthlyPayment - interest);
      let endingBalance = round2(balance - principal);
      if (i === numPeriods) endingBalance = 0;

      const rouAmortization = leaseClassification === "operating"
        ? round2(straightLineExpense - interest)
        : financeRouPerPeriod;

      const pDate = new Date(commencementDate);
      pDate.setMonth(pDate.getMonth() + i * mpp);

      schedule.push({
        period: i,
        paymentDate: format(pDate, "yyyy-MM-dd"),
        beginningBalance: balance,
        payment: monthlyPayment,
        interest,
        principal,
        endingBalance,
        rouAmortization,
      });

      balance = endingBalance;
    }
    return schedule;
  }, [
    watchValues.termMonths,
    watchValues.presentValue,
    watchValues.monthlyPayment,
    watchValues.borrowingRate,
    watchValues.commencementDate,
    watchValues.paymentFrequency,
    watchValues.leaseClassification,
    termValid,
  ]);

  function onSubmit(values: FormValues) {
    createLease.mutate(
      {
        data: {
          ...values,
          commencementDate: format(values.commencementDate, "yyyy-MM-dd"),
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Lease created successfully" });
          queryClient.invalidateQueries({ queryKey: getListLeasesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetLeasesSummaryQueryKey() });
          form.reset();
          onOpenChange(false);
        },
        onError: (err) => {
          toast({
            title: "Error creating lease",
            description: err.data?.error || "An unknown error occurred",
            variant: "destructive",
          });
        },
      }
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90dvh] flex flex-col p-0">
        <DialogHeader className="p-6 pb-4 border-b">
          <DialogTitle>Add Lease</DialogTitle>
          <DialogDescription>
            Enter the lease details to generate the amortization schedule.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 px-6">
          <div className="py-4">
            <Form {...form}>
              <form id="add-lease-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
                <div className="grid grid-cols-2 gap-6">
                  {/* Left column */}
                  <div className="space-y-6">
                    <div className="flex flex-col gap-4">
                      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">General Info</h3>
                      <FormField
                        control={form.control}
                        name="name"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Lease Name</FormLabel>
                            <FormControl>
                              <Input placeholder="e.g. SF Office HQ" data-testid="input-name" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="lessor"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Lessor</FormLabel>
                            <FormControl>
                              <Input placeholder="e.g. Equity Office Properties" data-testid="input-lessor" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <div className="grid grid-cols-2 gap-4">
                        <FormField
                          control={form.control}
                          name="leaseClassification"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Classification</FormLabel>
                              <Select onValueChange={field.onChange} value={field.value}>
                                <FormControl>
                                  <SelectTrigger data-testid="input-classification">
                                    <SelectValue />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  <SelectItem value="operating">Operating</SelectItem>
                                  <SelectItem value="finance">Finance</SelectItem>
                                </SelectContent>
                              </Select>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="paymentFrequency"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Payment Frequency</FormLabel>
                              <Select onValueChange={field.onChange} value={field.value}>
                                <FormControl>
                                  <SelectTrigger data-testid="input-frequency">
                                    <SelectValue />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  <SelectItem value="monthly">Monthly</SelectItem>
                                  <SelectItem value="quarterly">Quarterly</SelectItem>
                                  <SelectItem value="annually">Annually</SelectItem>
                                </SelectContent>
                              </Select>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                    </div>

                    <div className="flex flex-col gap-4">
                      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Financials</h3>
                      <div className="grid grid-cols-2 gap-4">
                        <FormField
                          control={form.control}
                          name="commencementDate"
                          render={({ field }) => (
                            <FormItem className="flex flex-col">
                              <FormLabel>Commencement Date</FormLabel>
                              <Popover>
                                <PopoverTrigger asChild>
                                  <FormControl>
                                    <Button
                                      variant={"outline"}
                                      className={cn(
                                        "pl-3 text-left font-normal",
                                        !field.value && "text-muted-foreground"
                                      )}
                                      data-testid="input-date"
                                    >
                                      {field.value ? format(field.value, "PPP") : <span>Pick a date</span>}
                                      <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                                    </Button>
                                  </FormControl>
                                </PopoverTrigger>
                                <PopoverContent className="w-auto p-0" align="start">
                                  <Calendar mode="single" selected={field.value} onSelect={field.onChange} initialFocus />
                                </PopoverContent>
                              </Popover>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="termMonths"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Term (Months)</FormLabel>
                              <FormControl>
                                <Input type="number" data-testid="input-term" {...field} />
                              </FormControl>
                              {!termValid && watchValues.termMonths > 0 && (
                                <p className="text-xs text-destructive">
                                  Term must be divisible by {monthsPerPeriod(watchValues.paymentFrequency)} for {watchValues.paymentFrequency} frequency
                                </p>
                              )}
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="monthlyPayment"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Periodic Payment</FormLabel>
                              <FormControl>
                                <div className="relative">
                                  <span className="absolute left-3 top-2.5 text-muted-foreground">$</span>
                                  <Input type="number" className="pl-7" data-testid="input-payment" {...field} />
                                </div>
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="borrowingRate"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Borrowing Rate (Annual)</FormLabel>
                              <FormControl>
                                <div className="relative">
                                  <Input type="number" step="0.01" className="pr-8" data-testid="input-rate" {...field} />
                                  <span className="absolute right-3 top-2.5 text-muted-foreground">%</span>
                                </div>
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="presentValue"
                          render={({ field }) => (
                            <FormItem className="col-span-2">
                              <FormLabel>Present Value / ROU Asset</FormLabel>
                              <div className="flex gap-2">
                                <FormControl>
                                  <div className="relative flex-1">
                                    <span className="absolute left-3 top-2.5 text-muted-foreground">$</span>
                                    <Input type="number" className="pl-7" data-testid="input-pv" {...field} />
                                  </div>
                                </FormControl>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={handleComputePV}
                                  disabled={computedPV === null}
                                  data-testid="button-compute-pv"
                                  className="shrink-0 gap-1.5"
                                >
                                  <Calculator className="h-3.5 w-3.5" />
                                  Compute PV
                                </Button>
                              </div>
                              {pvDrift && (
                                <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400 mt-1" data-testid="warning-pv-drift">
                                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                  <span>
                                    Entered PV differs from computed PV ({formatCurrency(computedPV!)}) by more than $1.
                                  </span>
                                </div>
                              )}
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Right column — GL accounts */}
                  <div className="space-y-6">
                    <div className="flex flex-col gap-4">
                      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">GL Accounts</h3>
                      <div className="grid grid-cols-1 gap-4">
                        <FormField
                          control={form.control}
                          name="rouAssetAccount"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>ROU Asset Account</FormLabel>
                              <FormControl>
                                <Input placeholder="15000" data-testid="input-rou-acc" {...field} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="leaseLiabilityAccount"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Lease Liability Account</FormLabel>
                              <FormControl>
                                <Input placeholder="25000" data-testid="input-liability-acc" {...field} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="interestExpenseAccount"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Interest Expense Account</FormLabel>
                              <FormControl>
                                <Input placeholder="71000" data-testid="input-interest-acc" {...field} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="amortizationExpenseAccount"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Amortization Expense Account</FormLabel>
                              <FormControl>
                                <Input placeholder="72000" data-testid="input-amortization-acc" {...field} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="cashAccount"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Cash / Bank Account</FormLabel>
                              <FormControl>
                                <Input placeholder="10000" data-testid="input-cash-acc" {...field} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {previewSchedule.length > 0 && (
                  <div className="mt-8 border-t pt-6">
                    <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">
                      Schedule Preview
                    </h3>
                    <div className="border rounded-md">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-12">#</TableHead>
                            <TableHead>Payment Date</TableHead>
                            <TableHead className="text-right">Beg. Balance</TableHead>
                            <TableHead className="text-right">Payment</TableHead>
                            <TableHead className="text-right">Interest</TableHead>
                            <TableHead className="text-right">Principal</TableHead>
                            <TableHead className="text-right">ROU Amort.</TableHead>
                            <TableHead className="text-right">End. Balance</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {previewSchedule.slice(0, 12).map((row, i) => (
                            <TableRow key={i}>
                              <TableCell className="font-medium text-muted-foreground">{row.period}</TableCell>
                              <TableCell>{formatDate(row.paymentDate)}</TableCell>
                              <TableCell className="text-right font-mono text-sm">{formatCurrency(row.beginningBalance)}</TableCell>
                              <TableCell className="text-right font-mono text-sm">{formatCurrency(row.payment)}</TableCell>
                              <TableCell className="text-right font-mono text-sm">{formatCurrency(row.interest)}</TableCell>
                              <TableCell className="text-right font-mono text-sm">{formatCurrency(row.principal)}</TableCell>
                              <TableCell className="text-right font-mono text-sm">{formatCurrency(row.rouAmortization)}</TableCell>
                              <TableCell className="text-right font-mono text-sm">{formatCurrency(row.endingBalance)}</TableCell>
                            </TableRow>
                          ))}
                          {previewSchedule.length > 12 && (
                            <TableRow>
                              <TableCell colSpan={8} className="text-center text-muted-foreground text-sm italic py-3">
                                ... and {previewSchedule.length - 12} more periods
                              </TableCell>
                            </TableRow>
                          )}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )}
              </form>
            </Form>
          </div>
        </ScrollArea>

        <DialogFooter className="p-6 pt-4 border-t mt-auto">
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel">
            Cancel
          </Button>
          <Button type="submit" form="add-lease-form" disabled={createLease.isPending} data-testid="button-save">
            {createLease.isPending ? "Saving..." : "Save Lease"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
