import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export type QboAccount = {
  qboId: string;
  acctNum?: string | null;
  name: string;
  accountType?: string | null;
  active: boolean;
};

function formatAccount(a: QboAccount): string {
  return a.acctNum ? `${a.acctNum} — ${a.name}` : a.name;
}

/**
 * Searchable combobox over the QBO chart of accounts. Type to filter by
 * account number, name, or type. Falls back to a plain text input when no
 * accounts are available (QBO not connected) so users can still record a
 * legacy code manually.
 */
export function AccountPicker(props: {
  value: string;
  onChange: (v: string) => void;
  accounts: QboAccount[];
  testId: string;
  placeholder?: string;
}) {
  const { value, onChange, accounts, testId } = props;
  const placeholder = props.placeholder ?? "Select QBO account…";
  const [open, setOpen] = useState(false);

  if (accounts.length === 0) {
    return (
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Account code"
        data-testid={testId}
      />
    );
  }

  const activeAccounts = accounts.filter((a) => a.active);
  const selected = accounts.find((a) => a.qboId === value);
  // Stored value is something we can't resolve in the cached COA — surface it
  // so the user knows to re-pick. This covers both legacy text codes and any
  // QBO Id that's been deactivated since it was assigned.
  const isLegacy = !selected && !!value;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "w-full justify-between font-normal",
            !selected && !isLegacy && "text-muted-foreground",
          )}
          data-testid={testId}
        >
          <span className="truncate">
            {selected
              ? formatAccount(selected)
              : isLegacy
                ? `⚠ Legacy: ${value}`
                : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command
          // Filter on number, name, type — cmdk lowercases both sides.
          filter={(itemValue, search) => {
            return itemValue.includes(search.toLowerCase()) ? 1 : 0;
          }}
        >
          <CommandInput placeholder="Search accounts…" />
          <CommandList>
            <CommandEmpty>No matching account.</CommandEmpty>
            <CommandGroup>
              {activeAccounts.map((a) => {
                const label = formatAccount(a);
                const haystack = [a.acctNum ?? "", a.name, a.accountType ?? ""]
                  .filter(Boolean)
                  .join(" ")
                  .toLowerCase();
                return (
                  <CommandItem
                    key={a.qboId}
                    value={haystack}
                    onSelect={() => {
                      onChange(a.qboId);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        value === a.qboId ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="truncate">{label}</span>
                    {a.accountType && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {a.accountType}
                      </span>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
