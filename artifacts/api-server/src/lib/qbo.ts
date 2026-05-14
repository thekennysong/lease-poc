/**
 * QuickBooks Online integration helpers.
 *
 * Auth: OAuth 2.0 (authorization code grant). The access token lives ~1h, the
 * refresh token 100 days and is rotated on every refresh response.
 *
 * Persistence: a single row in `qbo_connections` holds the active connection
 * (we only support one QBO realm at a time). Writes here always operate on
 * `id = 1`.
 *
 * Sync model: when a journal entry is posted locally we attempt a best-effort
 * push to QBO. Failures DO NOT roll back the local post — the close still
 * completes. The user can retry sync from the JE row.
 */

import { eq, lt } from "drizzle-orm";
import {
  db,
  qboConnectionsTable,
  qboAccountsTable,
  qboOauthStatesTable,
  type QboConnection,
} from "@workspace/db";
import { logger } from "./logger";
import crypto from "node:crypto";

// ───────── Config ─────────

const QBO_CLIENT_ID = process.env.QBO_CLIENT_ID ?? "";
const QBO_CLIENT_SECRET = process.env.QBO_CLIENT_SECRET ?? "";

/** Default OAuth scope — minimum needed to push journal entries. */
export const QBO_SCOPE = "com.intuit.quickbooks.accounting";

const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

export type QboEnvironment = "sandbox" | "production";

function apiBase(env: QboEnvironment): string {
  return env === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}

export function isQboConfigured(): boolean {
  return !!(QBO_CLIENT_ID && QBO_CLIENT_SECRET);
}

// ───────── OAuth handshake ─────────

/** Random state token; URL-safe. */
export function randomState(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function buildAuthUrl(opts: {
  state: string;
  redirectUri: string;
  scope?: string;
}): string {
  const params = new URLSearchParams({
    client_id: QBO_CLIENT_ID,
    response_type: "code",
    scope: opts.scope ?? QBO_SCOPE,
    redirect_uri: opts.redirectUri,
    state: opts.state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;            // seconds — typically 3600
  x_refresh_token_expires_in: number; // seconds — typically 8726400 (~100 days)
  token_type: string;
  scope?: string;
}

async function postTokenRequest(body: URLSearchParams): Promise<TokenResponse> {
  const basic = Buffer.from(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`QBO token request failed (${res.status}): ${text}`);
  }
  return JSON.parse(text) as TokenResponse;
}

export async function exchangeCode(opts: {
  code: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  return postTokenRequest(new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
  }));
}

export async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  return postTokenRequest(new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  }));
}

// ───────── Connection persistence ─────────

export async function getConnection(): Promise<QboConnection | null> {
  const [row] = await db.select().from(qboConnectionsTable).limit(1);
  return row ?? null;
}

export async function saveConnection(opts: {
  realmId: string;
  environment: QboEnvironment;
  tokens: TokenResponse;
}): Promise<QboConnection> {
  const now = Date.now();
  const accessExp = new Date(now + opts.tokens.expires_in * 1000);
  const refreshExp = new Date(now + opts.tokens.x_refresh_token_expires_in * 1000);

  const existing = await getConnection();
  const values = {
    realmId: opts.realmId,
    accessToken: opts.tokens.access_token,
    refreshToken: opts.tokens.refresh_token,
    accessTokenExpiresAt: accessExp,
    refreshTokenExpiresAt: refreshExp,
    environment: opts.environment,
    scope: opts.tokens.scope ?? QBO_SCOPE,
  };

  if (existing) {
    const [updated] = await db
      .update(qboConnectionsTable)
      .set(values)
      .where(eq(qboConnectionsTable.id, existing.id))
      .returning();
    return updated;
  }
  const [inserted] = await db
    .insert(qboConnectionsTable)
    .values(values)
    .returning();
  return inserted;
}

export async function deleteConnection(): Promise<void> {
  await db.delete(qboConnectionsTable);
  // Also wipe cached COA — it was tied to that realm.
  await db.delete(qboAccountsTable);
}

/**
 * Returns a connection with a guaranteed-fresh access token. If the access
 * token expires within the next 5 minutes we refresh proactively. Throws if
 * the refresh token itself has expired (user must reconnect).
 */
export async function ensureValidConnection(): Promise<QboConnection> {
  const conn = await getConnection();
  if (!conn) throw new Error("QBO not connected");

  const now = Date.now();
  const skewMs = 5 * 60 * 1000;
  if (conn.accessTokenExpiresAt.getTime() > now + skewMs) {
    return conn;
  }
  if (conn.refreshTokenExpiresAt.getTime() <= now) {
    throw new Error("QBO refresh token expired; reconnect required");
  }

  const fresh = await refreshTokens(conn.refreshToken);
  return saveConnection({
    realmId: conn.realmId,
    environment: conn.environment as QboEnvironment,
    tokens: fresh,
  });
}

// ───────── OAuth state (CSRF) ─────────

const STATE_TTL_MS = 10 * 60 * 1000;

export async function createOauthState(opts: {
  environment: QboEnvironment;
  redirectUri: string;
}): Promise<string> {
  const state = randomState();
  const expiresAt = new Date(Date.now() + STATE_TTL_MS);
  // Opportunistic cleanup of stale rows.
  await db.delete(qboOauthStatesTable).where(lt(qboOauthStatesTable.expiresAt, new Date()));
  await db.insert(qboOauthStatesTable).values({
    state,
    environment: opts.environment,
    redirectUri: opts.redirectUri,
    expiresAt,
  });
  return state;
}

export async function consumeOauthState(state: string): Promise<{
  environment: QboEnvironment;
  redirectUri: string;
} | null> {
  const [row] = await db
    .select()
    .from(qboOauthStatesTable)
    .where(eq(qboOauthStatesTable.state, state))
    .limit(1);
  if (!row) return null;
  // Single-use — delete regardless of expiry.
  await db.delete(qboOauthStatesTable).where(eq(qboOauthStatesTable.id, row.id));
  if (row.expiresAt.getTime() < Date.now()) return null;
  return {
    environment: row.environment as QboEnvironment,
    redirectUri: row.redirectUri,
  };
}

// ───────── Accounting API ─────────

async function qboFetch(
  conn: QboConnection,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = `${apiBase(conn.environment as QboEnvironment)}/v3/company/${conn.realmId}${path}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${conn.accessToken}`);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(url, { ...init, headers });
}

/** Pull every Account in the realm. QBO paginates at 1000 per page by default. */
export async function fetchAllAccounts(conn: QboConnection): Promise<QboApiAccount[]> {
  const accounts: QboApiAccount[] = [];
  let startPosition = 1;
  const pageSize = 1000;
  // Loop until QBO returns fewer rows than requested.
  for (let i = 0; i < 50; i++) {
    const q = encodeURIComponent(
      `select * from Account startposition ${startPosition} maxresults ${pageSize}`,
    );
    const res = await qboFetch(conn, `/query?query=${q}&minorversion=70`);
    const text = await res.text();
    if (!res.ok) throw new Error(`QBO query failed (${res.status}): ${text}`);
    const json = JSON.parse(text) as {
      QueryResponse?: { Account?: QboApiAccount[] };
    };
    const batch = json.QueryResponse?.Account ?? [];
    accounts.push(...batch);
    if (batch.length < pageSize) break;
    startPosition += pageSize;
  }
  return accounts;
}

export interface QboApiAccount {
  Id: string;
  Name: string;
  FullyQualifiedName?: string;
  AcctNum?: string;
  AccountType?: string;
  AccountSubType?: string;
  Classification?: string;
  Active?: boolean;
}

/** Replace the cached COA for this realm with the latest pull. */
export async function syncAccountsToCache(
  conn: QboConnection,
  apiAccounts: QboApiAccount[],
): Promise<number> {
  await db.delete(qboAccountsTable).where(eq(qboAccountsTable.realmId, conn.realmId));
  if (apiAccounts.length === 0) return 0;
  await db.insert(qboAccountsTable).values(
    apiAccounts.map((a) => ({
      realmId: conn.realmId,
      qboId: a.Id,
      acctNum: a.AcctNum ?? null,
      name: a.Name,
      fullyQualifiedName: a.FullyQualifiedName ?? null,
      accountType: a.AccountType ?? null,
      accountSubType: a.AccountSubType ?? null,
      classification: a.Classification ?? null,
      active: a.Active ?? true,
    })),
  );
  return apiAccounts.length;
}

// ───────── Journal entry push / void ─────────

export interface QboJournalLineInput {
  accountRefId: string; // QBO Account.Id
  amount: number;
  posting: "Debit" | "Credit";
  memo?: string;
}

export interface QboJournalEntryInput {
  txnDate: string; // YYYY-MM-DD
  privateMemo?: string;
  docNumber?: string;
  lines: QboJournalLineInput[];
}

export interface QboJournalEntryResult {
  Id: string;
  SyncToken: string;
}

/** QBO DocNumber is constrained to 21 chars; longer values are silently rejected. */
const QBO_DOC_NUMBER_MAX_LENGTH = 21;

/**
 * Extract the most useful human-readable message from a QBO Fault response.
 * QBO nests the actionable text under `Fault.Error[0].Detail`; falling back to
 * Message (and finally the raw body) keeps logs informative when the shape
 * doesn't match (rate-limit responses, gateway errors, etc.).
 */
function extractQboError(text: string): string {
  try {
    const json = JSON.parse(text) as {
      Fault?: { Error?: Array<{ Detail?: string; Message?: string }> };
    };
    const e = json.Fault?.Error?.[0];
    if (e?.Detail) return e.Detail;
    if (e?.Message) return e.Message;
  } catch {
    // not JSON — fall through
  }
  return text;
}

/**
 * Push a journal entry to QBO. Each Line includes a JournalEntryLineDetail
 * with PostingType and AccountRef. QBO requires Dr = Cr to within rounding.
 */
export async function pushJournalEntry(
  conn: QboConnection,
  je: QboJournalEntryInput,
): Promise<QboJournalEntryResult> {
  // Defensive validation. The local journal builder already enforces balance
  // and our schedule generator only emits dates in the supported range, but
  // these checks fail fast (with a useful message) before round-tripping to
  // QBO if some upstream caller forgets to do the work.
  if (je.txnDate < "1900-01-01" || je.txnDate > "2100-12-31") {
    throw new Error(`QBO rejects TxnDate outside 1900–2100: ${je.txnDate}`);
  }
  if (je.lines.length < 2) {
    throw new Error(`QBO journal entry needs at least two lines, got ${je.lines.length}`);
  }
  const Line = je.lines.map((l) => ({
    DetailType: "JournalEntryLineDetail",
    Amount: Math.round(Math.abs(l.amount) * 100) / 100,
    Description: l.memo,
    JournalEntryLineDetail: {
      PostingType: l.posting,
      AccountRef: { value: l.accountRefId },
    },
  }));
  const body: Record<string, unknown> = {
    TxnDate: je.txnDate,
    Line,
  };
  if (je.privateMemo) body.PrivateNote = je.privateMemo;
  if (je.docNumber) body.DocNumber = je.docNumber.slice(0, QBO_DOC_NUMBER_MAX_LENGTH);

  const res = await qboFetch(conn, `/journalentry?minorversion=70`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // Surface QBO's `Fault.Error[0].Detail` as the headline message; keep the
    // raw body in parentheses for debugging.
    throw new Error(`QBO push JE failed (${res.status}): ${extractQboError(text)} — ${text}`);
  }
  const json = JSON.parse(text) as { JournalEntry?: QboJournalEntryResult };
  if (!json.JournalEntry) throw new Error(`QBO push JE returned no entry: ${text}`);
  return json.JournalEntry;
}

/**
 * Void/delete a previously-pushed journal entry in QBO. We use the `delete`
 * operation, which removes the JE entirely. Reversals are handled at the
 * application layer by a) deleting the original in QBO, then b) pushing the
 * new offsetting JE — keeping QBO and our local "reversal entry" model in sync.
 */
export async function deleteJournalEntry(
  conn: QboConnection,
  qboId: string,
  syncToken: string,
): Promise<void> {
  const res = await qboFetch(conn, `/journalentry?operation=delete&minorversion=70`, {
    method: "POST",
    body: JSON.stringify({ Id: qboId, SyncToken: syncToken }),
  });
  if (!res.ok) {
    const text = await res.text();
    // 400 with QBO error code 610 (object not found) is treated as already-deleted
    // — we want delete to be idempotent for our retry/cleanup flows.
    if (res.status === 400 && /Object Not Found|610/i.test(text)) {
      logger.warn({ qboId }, "QBO JE already deleted; treating as success");
      return;
    }
    throw new Error(`QBO delete JE failed (${res.status}): ${text}`);
  }
}
