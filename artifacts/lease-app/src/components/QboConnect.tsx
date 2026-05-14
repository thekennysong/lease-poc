import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link2, Link2Off, RefreshCw, CheckCircle2, AlertCircle } from "lucide-react";
import {
  useGetQboStatus,
  getGetQboStatusQueryKey,
  disconnectQbo,
  refreshQboAccounts,
  getGetQboAccountsQueryKey,
} from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

/**
 * Header chip for QuickBooks Online. Shows the current connection state and
 * exposes Connect / Disconnect / Refresh COA actions.
 *
 * The OAuth flow runs in a popup window. Intuit redirects back to
 * `/api/qbo/callback`, which renders a small page that posts a message to
 * `window.opener` and then calls `window.close()`. We listen for that message
 * to re-fetch status without reloading the app.
 */
export function QboConnect() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const popupRef = useRef<Window | null>(null);
  const [busy, setBusy] = useState<"connect" | "disconnect" | "refresh" | null>(null);

  const { data: status, refetch } = useGetQboStatus({
    query: { queryKey: getGetQboStatusQueryKey(), refetchOnWindowFocus: true },
  });

  // Listen for the postMessage from the callback page.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const data = e.data as { source?: string; ok?: boolean } | null;
      if (!data || data.source !== "qbo-callback") return;
      setBusy(null);
      qc.invalidateQueries({ queryKey: getGetQboStatusQueryKey() });
      qc.invalidateQueries({ queryKey: getGetQboAccountsQueryKey() });
      if (data.ok) {
        toast({ title: "QuickBooks connected", description: "You can now select accounts and sync journal entries." });
      } else {
        toast({ title: "QuickBooks connection failed", variant: "destructive" });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [qc, toast]);

  function handleConnect() {
    setBusy("connect");
    // Open the connect endpoint directly — the server redirects to Intuit.
    const url = `/api/qbo/connect?environment=sandbox`;
    const w = window.open(url, "qbo-oauth", "width=620,height=760");
    popupRef.current = w;
    // If the user closes the popup without finishing, clear busy after a bit.
    const interval = setInterval(() => {
      if (!popupRef.current || popupRef.current.closed) {
        clearInterval(interval);
        setBusy((cur) => (cur === "connect" ? null : cur));
        refetch();
      }
    }, 1000);
  }

  async function handleDisconnect() {
    if (!confirm("Disconnect from QuickBooks? Posted journal entries already in QBO will remain there.")) return;
    setBusy("disconnect");
    try {
      await disconnectQbo();
      qc.invalidateQueries({ queryKey: getGetQboStatusQueryKey() });
      qc.invalidateQueries({ queryKey: getGetQboAccountsQueryKey() });
      toast({ title: "Disconnected from QuickBooks" });
    } catch (err) {
      toast({ title: "Disconnect failed", description: (err as Error).message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function handleRefresh() {
    setBusy("refresh");
    try {
      const res = await refreshQboAccounts();
      qc.invalidateQueries({ queryKey: getGetQboAccountsQueryKey() });
      toast({ title: "Chart of accounts refreshed", description: `${res.count ?? res.accounts.length} accounts cached.` });
    } catch (err) {
      const message = (err as { data?: { error?: string }; message?: string }).data?.error
        ?? (err as Error).message;
      toast({ title: "Refresh failed", description: message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  if (!status) {
    return null;
  }

  if (!status.configured) {
    return (
      <Badge variant="outline" className="gap-1.5 text-xs" title={status.message}>
        <AlertCircle className="h-3 w-3" />
        QBO not configured
      </Badge>
    );
  }

  if (!status.connected) {
    return (
      <Button
        size="sm"
        variant="outline"
        onClick={handleConnect}
        disabled={busy !== null}
        data-testid="button-qbo-connect"
        className="gap-1.5"
      >
        <Link2 className="h-4 w-4" />
        {busy === "connect" ? "Connecting…" : "Connect to QuickBooks"}
      </Button>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5" data-testid="button-qbo-status">
          <CheckCircle2 className="h-4 w-4 text-green-600" />
          QuickBooks
          <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0">
            {status.environment}
          </Badge>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium">Connected to QuickBooks</p>
            <p className="text-xs text-muted-foreground">
              Realm <span className="font-mono">{status.realmId}</span> · {status.environment}
            </p>
          </div>
          <div className="text-xs text-muted-foreground space-y-0.5">
            {status.connectedAt && <div>Connected {new Date(status.connectedAt).toLocaleString()}</div>}
            {status.refreshTokenExpiresAt && (
              <div>Refresh token expires {new Date(status.refreshTokenExpiresAt).toLocaleDateString()}</div>
            )}
          </div>
          <div className="flex flex-col gap-2 pt-1">
            <Button
              size="sm"
              variant="outline"
              onClick={handleRefresh}
              disabled={busy !== null}
              data-testid="button-qbo-refresh-coa"
              className="gap-1.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${busy === "refresh" ? "animate-spin" : ""}`} />
              {busy === "refresh" ? "Refreshing…" : "Refresh chart of accounts"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleDisconnect}
              disabled={busy !== null}
              data-testid="button-qbo-disconnect"
              className="gap-1.5 text-destructive hover:text-destructive"
            >
              <Link2Off className="h-3.5 w-3.5" />
              Disconnect
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
