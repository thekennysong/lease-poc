export function formatCurrency(value: number | undefined | null): string {
  if (value == null) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

export function formatDate(dateString: string | undefined | null): string {
  if (!dateString) return "";
  // Assume dateString is YYYY-MM-DD or full ISO
  const date = new Date(dateString);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC" // Prevents timezone shift if it's YYYY-MM-DD
  }).format(date);
}

export function formatPercent(value: number | undefined | null): string {
  if (value == null) return "0%";
  return `${value}%`;
}

export function round2(num: number): number {
  return Math.round(num * 100) / 100;
}
