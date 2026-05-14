/**
 * QBO integration routes.
 *
 *   GET  /qbo/status           — connection state
 *   GET  /qbo/connect          — redirect to Intuit OAuth consent screen
 *   GET  /qbo/callback         — OAuth code exchange + persist tokens
 *   POST /qbo/disconnect       — wipe stored connection + cached COA
 *   GET  /qbo/accounts         — cached chart of accounts (auto-refresh if stale)
 *   POST /qbo/accounts/refresh — force re-pull COA from QBO
 *   POST /qbo/journal-entries/:id/sync — manual retry of a failed JE push
 *   POST /qbo/journal-entries/sync-all — backfill: push every posted-but-unsynced JE
 */

import { Router, type IRouter } from "express";
import { eq, asc, and, or, isNull, ne } from "drizzle-orm";
import {
  db,
  qboAccountsTable,
  journalEntriesTable,
  journalEntryLinesTable,
  leasesTable,
} from "@workspace/db";
import {
  buildAuthUrl,
  consumeOauthState,
  createOauthState,
  deleteConnection,
  ensureValidConnection,
  exchangeCode,
  fetchAllAccounts,
  getConnection,
  isQboConfigured,
  saveConnection,
  syncAccountsToCache,
  pushJournalEntry,
  type QboEnvironment,
} from "../lib/qbo";

const router: IRouter = Router();

/**
 * Build the redirect_uri the way Intuit will see it. Intuit requires an EXACT
 * match against one of the URIs registered in the developer dashboard, so we
 * must derive it from request headers and not rely on env vars (the URL
 * differs between dev preview, deployed `.replit.app`, and a custom domain).
 *
 * `X-Forwarded-Proto` / `X-Forwarded-Host` are set by Replit's proxy.
 */
function buildRedirectUri(req: import("express").Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0].trim()
    || req.protocol
    || "https";
  const host = (req.headers["x-forwarded-host"] as string)?.split(",")[0].trim()
    || req.get("host")
    || "";
  return `${proto}://${host}/api/qbo/callback`;
}

// ───────── Status ─────────

router.get("/qbo/status", async (req, res): Promise<void> => {
  if (!isQboConfigured()) {
    res.json({
      configured: false,
      connected: false,
      message: "QBO_CLIENT_ID / QBO_CLIENT_SECRET are not set on the server",
    });
    return;
  }
  const conn = await getConnection();
  if (!conn) {
    res.json({ configured: true, connected: false });
    return;
  }
  res.json({
    configured: true,
    connected: true,
    realmId: conn.realmId,
    environment: conn.environment,
    accessTokenExpiresAt: conn.accessTokenExpiresAt.toISOString(),
    refreshTokenExpiresAt: conn.refreshTokenExpiresAt.toISOString(),
    connectedAt: conn.createdAt.toISOString(),
  });
});

// ───────── Connect (redirect to Intuit) ─────────

router.get("/qbo/connect", async (req, res): Promise<void> => {
  if (!isQboConfigured()) {
    res.status(400).json({ error: "QBO is not configured on this server" });
    return;
  }
  const envParam = (req.query.environment as string | undefined) ?? "sandbox";
  if (envParam !== "sandbox" && envParam !== "production") {
    res.status(400).json({ error: "environment must be 'sandbox' or 'production'" });
    return;
  }
  const environment = envParam as QboEnvironment;
  const redirectUri = buildRedirectUri(req);
  const state = await createOauthState({ environment, redirectUri });
  const url = buildAuthUrl({ state, redirectUri });
  res.redirect(url);
});

// ───────── OAuth callback ─────────

router.get("/qbo/callback", async (req, res): Promise<void> => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const realmId = req.query.realmId as string | undefined;
  const errorParam = req.query.error as string | undefined;

  // Render a small HTML page that closes the popup (or redirects the parent
  // window if it's a same-tab flow). The parent app polls /qbo/status to
  // pick up the new state.
  function close(html: string): void {
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  }

  if (errorParam) {
    close(callbackHtml({ ok: false, message: `Intuit returned error: ${errorParam}` }));
    return;
  }
  if (!code || !state || !realmId) {
    close(callbackHtml({ ok: false, message: "Missing code/state/realmId from Intuit callback" }));
    return;
  }

  const stateRow = await consumeOauthState(state);
  if (!stateRow) {
    close(callbackHtml({ ok: false, message: "Invalid or expired OAuth state — please retry connect" }));
    return;
  }

  try {
    const tokens = await exchangeCode({ code, redirectUri: stateRow.redirectUri });
    await saveConnection({ realmId, environment: stateRow.environment, tokens });
    req.log.info({ realmId, environment: stateRow.environment }, "QBO connected");
    close(callbackHtml({ ok: true, message: "QuickBooks connected successfully." }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "QBO token exchange failed");
    close(callbackHtml({ ok: false, message }));
  }
});

function callbackHtml(opts: { ok: boolean; message: string }): string {
  const color = opts.ok ? "#16a34a" : "#dc2626";
  const safeMessage = opts.message.replace(/[<>"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c),
  );
  return `<!doctype html><html><head><meta charset="utf-8"><title>QuickBooks Connection</title><style>
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;color:#0f172a}
.card{max-width:420px;padding:32px;background:white;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.08);text-align:center}
.dot{width:48px;height:48px;border-radius:999px;background:${color};color:white;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:24px;font-weight:bold}
h1{margin:0 0 8px;font-size:18px}p{color:#64748b;font-size:14px;line-height:1.5;margin:0 0 16px}
button{background:#0f172a;color:white;border:0;border-radius:8px;padding:8px 16px;font-size:14px;cursor:pointer}
</style></head><body><div class="card">
<div class="dot">${opts.ok ? "✓" : "!"}</div>
<h1>${opts.ok ? "Connected to QuickBooks" : "Connection failed"}</h1>
<p>${safeMessage}</p>
<button onclick="window.opener && window.opener.postMessage({source:'qbo-callback',ok:${opts.ok}},'*');window.close();window.location.href='/'">Continue</button>
</div></body></html>`;
}

// ───────── Disconnect ─────────

router.post("/qbo/disconnect", async (req, res): Promise<void> => {
  await deleteConnection();
  res.json({ disconnected: true });
});

// ───────── Chart of Accounts ─────────

router.get("/qbo/accounts", async (req, res): Promise<void> => {
  const conn = await getConnection();
  if (!conn) {
    res.status(400).json({ error: "QBO not connected" });
    return;
  }
  const cached = await db
    .select()
    .from(qboAccountsTable)
    .where(eq(qboAccountsTable.realmId, conn.realmId))
    .orderBy(asc(qboAccountsTable.acctNum), asc(qboAccountsTable.name));

  res.json({
    realmId: conn.realmId,
    syncedAt: cached[0]?.syncedAt.toISOString() ?? null,
    accounts: cached.map(mapAccount),
  });
});

router.post("/qbo/accounts/refresh", async (req, res): Promise<void> => {
  const conn = await ensureValidConnection().catch((err) => {
    res.status(400).json({ error: (err as Error).message });
    return null;
  });
  if (!conn) return;

  try {
    const apiAccounts = await fetchAllAccounts(conn);
    const count = await syncAccountsToCache(conn, apiAccounts);
    const cached = await db
      .select()
      .from(qboAccountsTable)
      .where(eq(qboAccountsTable.realmId, conn.realmId))
      .orderBy(asc(qboAccountsTable.acctNum), asc(qboAccountsTable.name));
    res.json({
      realmId: conn.realmId,
      count,
      syncedAt: cached[0]?.syncedAt.toISOString() ?? new Date().toISOString(),
      accounts: cached.map(mapAccount),
    });
  } catch (err) {
    req.log.error({ err }, "QBO COA refresh failed");
    res.status(502).json({ error: (err as Error).message });
  }
});

function mapAccount(a: typeof qboAccountsTable.$inferSelect) {
  return {
    qboId: a.qboId,
    acctNum: a.acctNum,
    name: a.name,
    fullyQualifiedName: a.fullyQualifiedName,
    accountType: a.accountType,
    accountSubType: a.accountSubType,
    classification: a.classification,
    active: a.active,
  };
}

// ───────── Manual JE sync retry ─────────

router.post("/qbo/journal-entries/:id/sync", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid journal entry id" });
    return;
  }

  const [je] = await db
    .select()
    .from(journalEntriesTable)
    .where(eq(journalEntriesTable.id, id));
  if (!je) {
    res.status(404).json({ error: "Journal entry not found" });
    return;
  }
  if (je.status !== "posted") {
    res.status(400).json({ error: "Only posted entries can be synced" });
    return;
  }
  if (je.qboId) {
    res.status(400).json({ error: "Already synced", qboId: je.qboId });
    return;
  }

  // Atomic compare-and-set claim. We can't trust the row we just SELECTed —
  // a concurrent retry from another tab could push between our SELECT and the
  // upcoming pushJournalEntry call, creating a duplicate JE in QBO. Flip the
  // status to "syncing" only if it is currently null/failed/skipped/pending
  // AND qboId is still NULL. The row this UPDATE returns is the one we own;
  // if zero rows return, somebody else is already pushing.
  //
  // The `or(isNull(...), ne(...))` is required because in SQL three-valued
  // logic `qbo_sync_status != 'syncing'` evaluates to NULL (not TRUE) when
  // the column is NULL, which would silently exclude every never-attempted JE.
  const [claimed] = await db
    .update(journalEntriesTable)
    .set({ qboSyncStatus: "syncing", qboSyncError: null })
    .where(
      and(
        eq(journalEntriesTable.id, id),
        isNull(journalEntriesTable.qboId),
        or(
          isNull(journalEntriesTable.qboSyncStatus),
          ne(journalEntriesTable.qboSyncStatus, "syncing"),
        ),
      ),
    )
    .returning();
  if (!claimed) {
    res.status(409).json({ error: "Sync already in progress or completed for this entry" });
    return;
  }

  const conn = await ensureValidConnection().catch((err) => {
    // Release the claim so the user can retry once the connection is fixed.
    void db
      .update(journalEntriesTable)
      .set({ qboSyncStatus: "failed", qboSyncError: (err as Error).message })
      .where(eq(journalEntriesTable.id, id));
    res.status(400).json({ error: (err as Error).message });
    return null;
  });
  if (!conn) return;

  const lines = await db
    .select()
    .from(journalEntryLinesTable)
    .where(eq(journalEntryLinesTable.journalEntryId, je.id));

  const [lease] = await db
    .select()
    .from(leasesTable)
    .where(eq(leasesTable.id, je.leaseId));

  // Build txnDate from the period (YYYY-MM → YYYY-MM-01) — we don't have the
  // schedule entry's payment date in scope here. The post-time push uses the
  // actual payment date; this manual retry is good enough.
  const txnDate = `${je.period}-01`;

  try {
    const result = await pushJournalEntry(conn, {
      txnDate,
      privateMemo: je.memo ?? `Lease ${lease?.name ?? je.leaseId} ${je.period}`,
      docNumber: `LSE-${je.leaseId}-${je.period}`,
      lines: lines.map((l) => ({
        accountRefId: l.accountCode,
        amount: parseFloat(l.debit) > 0 ? parseFloat(l.debit) : parseFloat(l.credit),
        posting: parseFloat(l.debit) > 0 ? "Debit" : "Credit",
        memo: l.memo ?? undefined,
      })),
    });
    const [updated] = await db
      .update(journalEntriesTable)
      .set({
        qboId: result.Id,
        qboSyncToken: result.SyncToken,
        qboSyncStatus: "synced",
        qboSyncError: null,
        qboSyncedAt: new Date(),
      })
      .where(eq(journalEntriesTable.id, je.id))
      .returning();
    res.json({ qboId: updated.qboId, qboSyncStatus: updated.qboSyncStatus });
  } catch (err) {
    const message = (err as Error).message;
    await db
      .update(journalEntriesTable)
      .set({ qboSyncStatus: "failed", qboSyncError: message })
      .where(eq(journalEntriesTable.id, je.id));
    req.log.error({ err, journalEntryId: id }, "QBO JE sync retry failed");
    res.status(502).json({ error: message });
  }
});

// ───────── Bulk backfill ─────────

/**
 * Push every locally-posted JE that doesn't yet have a `qboId` to QuickBooks.
 *
 * Use case: the user posted a bunch of months locally before connecting QBO
 * (so their JEs are `skipped`), then connects QBO and wants the historical
 * close mirrored. Also picks up anything currently `failed` for one-click
 * recovery, and `pending`/null for safety.
 *
 * Per-JE result is returned so the UI can summarize. Failures on individual
 * entries don't abort the rest; they're recorded on the row as `failed` and
 * counted in `failed`.
 */
router.post("/qbo/journal-entries/sync-all", async (req, res): Promise<void> => {
  const conn = await ensureValidConnection().catch((err) => {
    res.status(400).json({ error: (err as Error).message });
    return null;
  });
  if (!conn) return;

  // Candidates: any JE in `posted` status without a qboId. We deliberately
  // exclude `reversed` rows (they were superseded by an offsetting JE) and
  // anything currently `syncing` (another worker has the claim).
  // `or(isNull(...), ne(...))` rather than a bare `ne(...)` because in SQL
  // three-valued logic `qbo_sync_status != 'syncing'` is NULL (not TRUE) when
  // the column is NULL — which would silently filter out every JE that has
  // never been attempted (the entire backfill scenario).
  const candidates = await db
    .select()
    .from(journalEntriesTable)
    .where(
      and(
        eq(journalEntriesTable.status, "posted"),
        isNull(journalEntriesTable.qboId),
        or(
          isNull(journalEntriesTable.qboSyncStatus),
          ne(journalEntriesTable.qboSyncStatus, "syncing"),
        ),
      ),
    )
    .orderBy(asc(journalEntriesTable.postedAt));

  let synced = 0;
  let failed = 0;
  const errors: Array<{ id: number; error: string }> = [];

  for (const je of candidates) {
    // Atomic claim per row so a concurrent retry can't double-push.
    const [claimed] = await db
      .update(journalEntriesTable)
      .set({ qboSyncStatus: "syncing", qboSyncError: null })
      .where(
        and(
          eq(journalEntriesTable.id, je.id),
          isNull(journalEntriesTable.qboId),
          or(
            isNull(journalEntriesTable.qboSyncStatus),
            ne(journalEntriesTable.qboSyncStatus, "syncing"),
          ),
        ),
      )
      .returning();
    if (!claimed) continue;

    const lines = await db
      .select()
      .from(journalEntryLinesTable)
      .where(eq(journalEntryLinesTable.journalEntryId, je.id));
    const [lease] = await db
      .select()
      .from(leasesTable)
      .where(eq(leasesTable.id, je.leaseId));

    try {
      const result = await pushJournalEntry(conn, {
        // We don't have the schedule entry's payment date in scope (would
        // require an extra join per JE). Period-first-of-month is accurate
        // enough for backfill — the user can correct in QBO if needed.
        txnDate: `${je.period}-01`,
        privateMemo: je.memo ?? `Lease ${lease?.name ?? je.leaseId} ${je.period}`,
        docNumber: `LSE-${je.leaseId}-${je.period}`,
        lines: lines.map((l) => ({
          accountRefId: l.accountCode,
          amount: parseFloat(l.debit) > 0 ? parseFloat(l.debit) : parseFloat(l.credit),
          posting: parseFloat(l.debit) > 0 ? "Debit" : "Credit",
          memo: l.memo ?? undefined,
        })),
      });
      await db
        .update(journalEntriesTable)
        .set({
          qboId: result.Id,
          qboSyncToken: result.SyncToken,
          qboSyncStatus: "synced",
          qboSyncError: null,
          qboSyncedAt: new Date(),
        })
        .where(eq(journalEntriesTable.id, je.id));
      synced++;
    } catch (err) {
      const message = (err as Error).message;
      req.log.error({ err, journalEntryId: je.id }, "QBO bulk sync JE push failed");
      await db
        .update(journalEntriesTable)
        .set({ qboSyncStatus: "failed", qboSyncError: message })
        .where(eq(journalEntriesTable.id, je.id));
      failed++;
      errors.push({ id: je.id, error: message });
    }
  }

  res.json({
    candidates: candidates.length,
    synced,
    failed,
    errors: errors.slice(0, 20),
  });
});

export default router;
