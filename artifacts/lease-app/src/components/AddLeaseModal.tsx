import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { format } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateLease,
  getListLeasesQueryKey,
  getGetLeasesSummaryQueryKey,
  useGetQboAccounts,
  getGetQboAccountsQueryKey,
} from "@workspace/api-client-react";
import { CalendarIcon, Calculator, AlertTriangle, ChevronDown, Info } from "lucide-react";

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
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatDate, round2 } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AccountPicker } from "@/components/AccountPicker";

type PaymentFrequency = "monthly" | "quarterly" | "annually";
type LeaseClassification = "operating" | "finance";
type PaymentTiming = "advance" | "arrears";

function paymentsPerYear(freq: PaymentFrequency): number {
  if (freq === "monthly") return 12;
  if (freq === "quarterly") return 4;
  return 1;
}

function monthsPerPeriod(freq: PaymentFrequency): number {
  return 12 / paymentsPerYear(freq);
}

/**
 * Present value of an annuity. For "advance" timing (annuity-due) the result is
 * multiplied by (1 + r) because each cashflow occurs one period earlier.
 */
function computePV(
  periodicPayment: number,
  annualRate: number,
  termMonths: number,
  freq: PaymentFrequency,
  timing: PaymentTiming,
): number {
  const ppy = paymentsPerYear(freq);
  const r = annualRate / 100 / ppy;
  const n = termMonths / monthsPerPeriod(freq);
  if (r === 0) return round2(periodicPayment * n);
  const ordinary = periodicPayment * (1 - Math.pow(1 + r, -n)) / r;
  return round2(timing === "advance" ? ordinary * (1 + r) : ordinary);
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
  paymentTiming: z.enum(["advance", "arrears"]).default("arrears"),
  isShortTerm: z.boolean().default(false),
  prepaidRent: z.coerce.number().min(0).default(0),
  initialDirectCosts: z.coerce.number().min(0).default(0),
  leaseIncentives: z.coerce.number().min(0).default(0),
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
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Pulled lazily — fails silently with `undefined` when QBO isn't connected
  // (the GET returns 400). The form falls back to plain text inputs in that
  // case, so the modal is still fully usable.
  const { data: qboAccountsData } = useGetQboAccounts({
    query: { queryKey: getGetQboAccountsQueryKey(), retry: false, throwOnError: false },
  });
  const qboAccounts = qboAccountsData?.accounts ?? [];

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
      paymentTiming: "arrears",
      isShortTerm: false,
      prepaidRent: 0,
      initialDirectCosts: 0,
      leaseIncentives: 0,
    },
  });

  const watchValues = form.watch();
  const shortTermEligible = watchValues.termMonths > 0 && watchValues.termMonths <= 12;

  // If user makes term > 12, force isShortTerm off
  if (!shortTermEligible && watchValues.isShortTerm) {
    form.setValue("isShortTerm", false);
  }

  const termValid = useMemo(() => {
    const mpp = monthsPerPeriod(watchValues.paymentFrequency);
    return watchValues.termMonths > 0 && watchValues.termMonths % mpp === 0;
  }, [watchValues.termMonths, watchValues.paymentFrequency]);

  const computedPV = useMemo(() => {
    const { monthlyPayment, borrowingRate, termMonths, paymentFrequency, paymentTiming } = watchValues;
    if (!monthlyPayment || borrowingRate == null || !termMonths) return null;
    if (!termValid) return null;
    return computePV(monthlyPayment, borrowingRate, termMonths, paymentFrequency, paymentTiming);
  }, [
    watchValues.monthlyPayment,
    watchValues.borrowingRate,
    watchValues.termMonths,
    watchValues.paymentFrequency,
    watchValues.paymentTiming,
    termValid,
  ]);

  const pvDrift = computedPV !== null && watchValues.presentValue > 0
    ? Math.abs(watchValues.presentValue - computedPV) > 1
    : false;

  function handleComputePV() {
    if (computedPV !== null) {
      form.setValue("presentValue", computedPV);
    }
  }

  // Computed opening ROU = PV + prepaid + IDC − incentives
  const openingRou = useMemo(
    () =>
      round2(
        watchValues.presentValue +
          (watchValues.prepaidRent ?? 0) +
          (watchValues.initialDirectCosts ?? 0) -
          (watchValues.leaseIncentives ?? 0),
      ),
    [
      watchValues.presentValue,
      watchValues.prepaidRent,
      watchValues.initialDirectCosts,
      watchValues.leaseIncentives,
    ],
  );

  // Live schedule preview — mirrors the server logic exactly. Skipped for short-term leases.
  const previewSchedule = useMemo(() => {
    const {
      termMonths,
      presentValue,
      monthlyPayment,
      borrowingRate,
      commencementDate,
      paymentFrequency,
      leaseClassification,
      paymentTiming,
      isShortTerm,
      prepaidRent,
      initialDirectCosts,
      leaseIncentives,
    } = watchValues;
    if (isShortTerm) return [];
    if (!termMonths || !presentValue || !monthlyPayment || borrowingRate == null || !commencementDate) return [];
    if (!termValid) return [];

    const ppy = paymentsPerYear(paymentFrequency);
    const mpp = monthsPerPeriod(paymentFrequency);
    const numPeriods = termMonths / mpp;
    const periodicRate = borrowingRate / 100 / ppy;

    const totalLeaseCost =
      monthlyPayment * numPeriods + (prepaidRent ?? 0) + (initialDirectCosts ?? 0) - (leaseIncentives ?? 0);
    const straightLineExpense = round2(totalLeaseCost / numPeriods);

    const opening = round2(
      presentValue + (prepaidRent ?? 0) + (initialDirectCosts ?? 0) - (leaseIncentives ?? 0),
    );
    const financeRouPerPeriod = round2(opening / numPeriods);

    const schedule = [];
    let balance = presentValue;

    for (let i = 1; i <= numPeriods; i++) {
      const interest = paymentTiming === "advance" && i === 1 ? 0 : round2(balance * periodicRate);
      const principal = round2(monthlyPayment - interest);
      let endingBalance = round2(balance - principal);
      if (i === numPeriods) endingBalance = 0;

      const rouAmortization = leaseClassification === "operating"
        ? round2(straightLineExpense - interest)
        : financeRouPerPeriod;

      const offset = paymentTiming === "advance" ? (i - 1) * mpp : i * mpp;
      const pDate = new Date(commencementDate);
      pDate.setMonth(pDate.getMonth() + offset);

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
    watchValues.paymentTiming,
    watchValues.isShortTerm,
    watchValues.prepaidRent,
    watchValues.initialDirectCosts,
    watchValues.leaseIncentives,
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
                        <FormField
                          control={form.control}
                          name="paymentTiming"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Payment Timing</FormLabel>
                              <Select onValueChange={field.onChange} value={field.value}>
                                <FormControl>
                                  <SelectTrigger data-testid="input-timing">
                                    <SelectValue />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  <SelectItem value="arrears">Arrears (period-end)</SelectItem>
                                  <SelectItem value="advance">Advance (period-start)</SelectItem>
                                </SelectContent>
                              </Select>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="isShortTerm"
                          render={({ field }) => (
                            <FormItem className="flex flex-col">
                              <FormLabel>Short-Term Election</FormLabel>
                              <div className="flex items-center gap-3 h-10 px-3 rounded-md border bg-background">
                                <FormControl>
                                  <Switch
                                    checked={field.value}
                                    onCheckedChange={field.onChange}
                                    disabled={!shortTermEligible}
                                    data-testid="input-shortterm"
                                  />
                                </FormControl>
                                <span className="text-sm text-muted-foreground">
                                  {shortTermEligible
                                    ? "Skip schedule (≤12 mo)"
                                    : "Term > 12 mo (ineligible)"}
                                </span>
                              </div>
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
                              <FormLabel>Present Value / Lease Liability</FormLabel>
                              <div className="flex gap-2">
                                <FormControl>
                                  <div className="relative flex-1">
                                    <span className="absolute left-3 top-2.5 text-muted-foreground">$</span>
                                    <Input
                                      type="number"
                                      className="pl-7"
                                      data-testid="input-pv"
                                      disabled={watchValues.isShortTerm}
                                      {...field}
                                    />
                                  </div>
                                </FormControl>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={handleComputePV}
                                  disabled={computedPV === null || watchValues.isShortTerm}
                                  data-testid="button-compute-pv"
                                  className="shrink-0 gap-1.5"
                                >
                                  <Calculator className="h-3.5 w-3.5" />
                                  Compute PV
                                </Button>
                              </div>
                              {pvDrift && !watchValues.isShortTerm && (
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

                    {/* Advanced — opening ROU adjustments */}
                    <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
                      <CollapsibleTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          className="flex w-full justify-between p-2 -mx-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground hover-elevate"
                          data-testid="button-advanced"
                        >
                          <span>Advanced — Opening ROU Adjustments</span>
                          <ChevronDown className={cn("h-4 w-4 transition-transform", advancedOpen && "rotate-180")} />
                        </Button>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="pt-4">
                        <div className="grid grid-cols-2 gap-4">
                          <FormField
                            control={form.control}
                            name="prepaidRent"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Prepaid Rent</FormLabel>
                                <FormControl>
                                  <div className="relative">
                                    <span className="absolute left-3 top-2.5 text-muted-foreground">$</span>
                                    <Input type="number" className="pl-7" data-testid="input-prepaid" {...field} />
                                  </div>
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={form.control}
                            name="initialDirectCosts"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Initial Direct Costs</FormLabel>
                                <FormControl>
                                  <div className="relative">
                                    <span className="absolute left-3 top-2.5 text-muted-foreground">$</span>
                                    <Input type="number" className="pl-7" data-testid="input-idc" {...field} />
                                  </div>
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={form.control}
                            name="leaseIncentives"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Lease Incentives</FormLabel>
                                <FormControl>
                                  <div className="relative">
                                    <span className="absolute left-3 top-2.5 text-muted-foreground">$</span>
                                    <Input type="number" className="pl-7" data-testid="input-incentives" {...field} />
                                  </div>
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <div className="flex flex-col">
                            <span className="text-sm font-medium leading-none mb-2">Opening ROU Asset</span>
                            <div className="h-10 px-3 flex items-center rounded-md border bg-muted/30 font-mono text-sm" data-testid="text-opening-rou">
                              {formatCurrency(openingRou)}
                            </div>
                            <p className="text-xs text-muted-foreground mt-1">PV + Prepaid + IDC − Incentives</p>
                          </div>
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  </div>

                  {/* Right column — GL accounts */}
                  <div className="space-y-6">
                    <div className="flex flex-col gap-4">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">GL Accounts</h3>
                        {qboAccounts.length > 0 && (
                          <span className="text-xs text-muted-foreground">From QuickBooks ({qboAccounts.length})</span>
                        )}
                      </div>
                      <div className="grid grid-cols-1 gap-4">
                        {(
                          [
                            { name: "rouAssetAccount", label: "ROU Asset Account", placeholder: "15000", testId: "input-rou-acc" },
                            { name: "leaseLiabilityAccount", label: "Lease Liability Account", placeholder: "25000", testId: "input-liability-acc" },
                            { name: "interestExpenseAccount", label: "Interest Expense Account", placeholder: "71000", testId: "input-interest-acc" },
                            { name: "amortizationExpenseAccount", label: "Amortization Expense Account", placeholder: "72000", testId: "input-amortization-acc" },
                            { name: "cashAccount", label: "Cash / Bank Account", placeholder: "10000", testId: "input-cash-acc" },
                          ] as const
                        ).map((cfg) => (
                          <FormField
                            key={cfg.name}
                            control={form.control}
                            name={cfg.name}
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>{cfg.label}</FormLabel>
                                <FormControl>
                                  <AccountPicker
                                    value={field.value ?? ""}
                                    onChange={field.onChange}
                                    placeholder={cfg.placeholder}
                                    testId={cfg.testId}
                                    accounts={qboAccounts}
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                {watchValues.isShortTerm ? (
                  <div className="mt-8 border-t pt-6">
                    <div className="flex items-start gap-3 p-4 rounded-md border border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30" data-testid="note-shortterm">
                      <Info className="h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400 mt-0.5" />
                      <div className="space-y-1 text-sm">
                        <p className="font-medium text-blue-900 dark:text-blue-100">Short-term lease election</p>
                        <p className="text-blue-700 dark:text-blue-300">
                          No amortization schedule, ROU asset, or lease liability will be recorded.
                          Recognize the periodic payment of {formatCurrency(watchValues.monthlyPayment)} as
                          straight-line expense each {watchValues.paymentFrequency.replace(/ly$/, "")}.
                        </p>
                      </div>
                    </div>
                  </div>
                ) : previewSchedule.length > 0 ? (
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
                ) : null}
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
