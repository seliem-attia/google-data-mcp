#!/usr/bin/env node
// google-data-mcp — MCP server for Google Analytics 4 (Data + Admin API) and
// Google Tag Manager (v2), read AND write. Uses your own Google OAuth client.
//
// Two refresh tokens (see README.md):
//   • GOOGLE_OAUTH_REFRESH_TOKEN        read-only (webmasters/analytics/tagmanager.readonly),
//                                       meant for analysis/automation setups.
//   • GOOGLE_OAUTH_REFRESH_TOKEN_WRITE  additionally analytics.edit + tagmanager.edit.containers
//                                       + tagmanager.edit.containerversions + tagmanager.publish.
//                                       Create it with: npm run auth -- --write
// If the WRITE token is present, the MCP uses it for everything; otherwise the read-only token
// (write tools then return a clear scope hint). GOOGLE_DATA_MCP_READONLY=1
// hides the write tools completely (e.g. for automated runs).
//
// Backups: GA4 does not version its configuration (only a change history, no rollback),
// GTM only keeps created versions. So every write tool FIRST saves the affected state
// as JSON under ~/.config/google-data-mcp/backups/ (or $GOOGLE_DATA_MCP_BACKUP_DIR);
// if the backup fails, nothing is written.
//
// Auth: client_id/secret/refresh_token are loaded from (in this order):
//   1. process.env  GOOGLE_OAUTH_CLIENT_ID / _SECRET / _REFRESH_TOKEN[_WRITE]
//   2. file from $GOOGLE_DATA_MCP_ENV
//   3. ~/.config/google-data-mcp/.env
//   4. .env next to index.mjs
//
// Modes: node index.mjs            → MCP server over stdio
//        node index.mjs --selftest → one-off live check against the APIs (read-only)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative, sep } from "node:path";
import { validateEntityCode, referencedVariables, unknownVariables } from "./gtm-validate.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Credentials ──────────────────────────────────────────────────────────────
function parseEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const VERSION = "0.6.0";
const READONLY_MODE = /^(1|true|yes)$/i.test(process.env.GOOGLE_DATA_MCP_READONLY || "");

// Prefers the write token; in READONLY mode always uses the read-only token.
function pickCreds(e) {
  const refresh = (!READONLY_MODE && e.GOOGLE_OAUTH_REFRESH_TOKEN_WRITE) || e.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!e.GOOGLE_OAUTH_CLIENT_ID || !e.GOOGLE_OAUTH_CLIENT_SECRET || !refresh) return null;
  return {
    client_id: e.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: e.GOOGLE_OAUTH_CLIENT_SECRET,
    refresh_token: refresh,
    token: refresh === e.GOOGLE_OAUTH_REFRESH_TOKEN_WRITE ? "write" : "read-only",
  };
}

function loadCreds() {
  const fromEnv = pickCreds(process.env);
  if (fromEnv) return fromEnv;

  const candidates = [
    process.env.GOOGLE_DATA_MCP_ENV,
    resolve(homedir(), ".config/google-data-mcp/.env"),
    resolve(__dirname, ".env"),
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const c = pickCreds(parseEnvFile(p));
      if (c) return c;
    } catch {
      /* ignore unreadable candidate */
    }
  }
  throw new Error(
    "No OAuth credentials found. Expected GOOGLE_OAUTH_CLIENT_ID/_SECRET + _REFRESH_TOKEN(_WRITE) " +
      "in the environment, in $GOOGLE_DATA_MCP_ENV, in ~/.config/google-data-mcp/.env or in a .env next to index.mjs.",
  );
}

// ── Access token (cached) ────────────────────────────────────────────────────
let _tok = { value: null, exp: 0 };
async function getAccessToken() {
  const now = Date.now();
  if (_tok.value && now < _tok.exp - 60_000) return _tok.value;
  const c = loadCreds();
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.client_id,
      client_secret: c.client_secret,
      refresh_token: c.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error("Token refresh failed: " + JSON.stringify(j));
  _tok = { value: j.access_token, exp: now + (j.expires_in ?? 3600) * 1000 };
  return _tok.value;
}

async function tokenInfo() {
  const t = await getAccessToken();
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(t)}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("tokeninfo failed: " + JSON.stringify(j));
  const scopes = String(j.scope || "").split(" ").filter(Boolean);
  const has = (s) => scopes.includes(`https://www.googleapis.com/auth/${s}`);
  return {
    token: loadCreds().token,
    readonlyMode: READONLY_MODE,
    scopes,
    canWrite: {
      ga4Admin: has("analytics.edit"),
      gtmWorkspaces: has("tagmanager.edit.containers"),
      gtmVersions: has("tagmanager.edit.containerversions"),
      gtmPublish: has("tagmanager.publish"),
    },
  };
}

function apiError(status, j) {
  const msg = j?.error?.message || JSON.stringify(j);
  if (status === 403 && /not been used|disabled|enable it|SERVICE_DISABLED/i.test(msg)) {
    return new Error(`Google API ${status}: ${msg}\nHint: enable the corresponding API in the Cloud project.`);
  }
  if (status === 403 && /insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(JSON.stringify(j))) {
    return new Error(
      `Google API ${status}: ${msg}\nHint: the token has no write scopes. Create a write token with ` +
        "`npm run auth -- --write` and set it as GOOGLE_OAUTH_REFRESH_TOKEN_WRITE (see README).",
    );
  }
  if (status === 403 && /permission/i.test(msg)) {
    return new Error(
      `Google API ${status}: ${msg}\nHint: The Google account needs the GA4 role Editor, ` +
        "or GTM container permissions Edit/Publish.",
    );
  }
  if (status === 401) return new Error(`Google API 401 (Token/Scope): ${msg}`);
  return new Error(`Google API ${status}: ${msg}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function googleRequest(method, url, body, attempt = 0) {
  const t = await getAccessToken();
  const init = { method, headers: { Authorization: `Bearer ${t}` } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await fetch(url, init);
  // Rate limit / temporarily unavailable → backoff 2s, 4s, 8s, 16s.
  if ((r.status === 429 || r.status === 503) && attempt < 4) {
    await sleep(2000 * 2 ** attempt);
    return googleRequest(method, url, body, attempt + 1);
  }
  const text = await r.text();
  let j = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    j = { raw: text };
  }
  if (!r.ok) throw apiError(r.status, j);
  return j;
}

const googleGet = (url) => googleRequest("GET", url);
const googlePost = (url, body) => googleRequest("POST", url, body ?? {});

// Relative API path for the generic tools — no host switching possible.
function cleanPath(path) {
  const p = String(path).trim().replace(/^\/+/, "");
  if (!p || /^[a-z]+:\/\//i.test(p) || p.includes("..")) throw new Error(`Invalid API path: ${path}`);
  return p;
}
const apiUrl = (base, path) => `${base}/${cleanPath(path)}`;

// Deleting whole accounts, properties or containers is not possible through the MCP (not recoverable).
function guardDelete(method, path, patterns) {
  const p = cleanPath(path).split("?")[0];
  if (method === "DELETE" && patterns.some((re) => re.test(p))) {
    throw new Error(`Blocked: DELETE ${p} — delete accounts/properties/containers manually in the Google UI only.`);
  }
}

// ── Backups (local) ──────────────────────────────────────────────────────────
const BACKUP_DIR = resolve(process.env.GOOGLE_DATA_MCP_BACKUP_DIR || resolve(homedir(), ".config/google-data-mcp/backups"));
const slug = (x) => String(x).replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80);

// Writes <platform>/<id>/<timestamp>_<label>.json (0600) and returns the relative path.
function saveSnapshot(platform, id, label, snapshot) {
  const dir = resolve(BACKUP_DIR, platform, slug(id));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const createdAt = new Date().toISOString();
  const file = resolve(dir, `${createdAt.replace(/[:.]/g, "-")}_${slug(label)}.json`);
  const doc = { meta: { platform, id: String(id), label, createdAt, mcpVersion: VERSION }, ...snapshot };
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
  return relative(BACKUP_DIR, file);
}

// Best-effort part of a snapshot: errors end up in errors instead of aborting the export.
const collector = () => {
  const errors = {};
  const opt = async (key, fn) => {
    try {
      return await fn();
    } catch (e) {
      errors[key] = e.message;
      return undefined;
    }
  };
  return { errors, opt };
};

function listBackups({ platform, id, limit = 50 }) {
  const root = resolve(BACKUP_DIR, ...[platform, id && slug(id)].filter(Boolean));
  const files = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = resolve(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".json")) files.push({ path: relative(BACKUP_DIR, p), bytes: statSync(p).size });
    }
  };
  walk(root);
  files.sort((a, b) => (a.path.split(sep).pop() < b.path.split(sep).pop() ? 1 : -1));
  return { backupDir: BACKUP_DIR, count: files.length, backups: files.slice(0, limit) };
}

function readBackup({ path, select }) {
  const file = resolve(BACKUP_DIR, String(path));
  if (!file.startsWith(BACKUP_DIR + sep) || !file.endsWith(".json")) throw new Error(`Invalid backup path: ${path}`);
  const doc = JSON.parse(readFileSync(file, "utf8"));
  if (!select) return doc;
  // Subtree via dot path, e.g. "data.tags" or "data.dataStreams.0"
  return String(select)
    .split(".")
    .reduce((o, k) => {
      if (o == null || !(k in Object(o))) throw new Error(`select: '${k}' not found (available: ${Object.keys(Object(o)).join(", ")})`);
      return o[k];
    }, doc);
}

// ── GA4 ──────────────────────────────────────────────────────────────────────
// All IDs are numeric. Validate strictly because they end up in URLs (no '../', '?', ':' can be smuggled in).
function num(v, name) {
  const s = String(v ?? "").trim();
  if (!/^\d+$/.test(s)) throw new Error(`Invalid ${name}: '${v}' (digits only)`);
  return s;
}
const propId = (p) => num(String(p).trim().replace(/^properties\//, ""), "property ID");
const propPath = (p) => `properties/${propId(p)}`;

async function ga4ListProperties() {
  const j = await googleGet("https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200");
  const properties = [];
  for (const acc of j.accountSummaries || []) {
    for (const p of acc.propertySummaries || []) {
      properties.push({
        property: p.property,
        propertyId: propId(p.property),
        displayName: p.displayName,
        account: acc.account,
        accountName: acc.displayName,
      });
    }
  }
  return { count: properties.length, properties };
}

function formatGa4(j) {
  const dimHeaders = (j.dimensionHeaders || []).map((d) => d.name);
  const metHeaders = (j.metricHeaders || []).map((m) => m.name);
  const rows = (j.rows || []).map((r) => {
    const o = {};
    (r.dimensionValues || []).forEach((v, i) => (o[dimHeaders[i]] = v.value));
    (r.metricValues || []).forEach((v, i) => (o[metHeaders[i]] = v.value));
    return o;
  });
  return { rowCount: j.rowCount ?? rows.length, dimensions: dimHeaders, metrics: metHeaders, rows };
}

async function ga4RunReport({
  property,
  metrics,
  dimensions = [],
  startDate = "28daysAgo",
  endDate = "yesterday",
  limit = 50,
  orderByMetric,
  orderByDimension,
  dimensionFilter,
  metricFilter,
}) {
  const body = {
    dateRanges: [{ startDate, endDate }],
    metrics: metrics.map((name) => ({ name })),
    dimensions: dimensions.map((name) => ({ name })),
    limit: String(limit),
  };
  const orderBys = [];
  if (orderByMetric) orderBys.push({ metric: { metricName: orderByMetric }, desc: true });
  if (orderByDimension) orderBys.push({ dimension: { dimensionName: orderByDimension } });
  if (orderBys.length) body.orderBys = orderBys;
  if (dimensionFilter) body.dimensionFilter = dimensionFilter;
  if (metricFilter) body.metricFilter = metricFilter;
  return formatGa4(await googlePost(`https://analyticsdata.googleapis.com/v1beta/${propPath(property)}:runReport`, body));
}

async function ga4RealtimeReport({ property, metrics, dimensions = [], limit = 50, dimensionFilter }) {
  const body = {
    metrics: metrics.map((name) => ({ name })),
    dimensions: dimensions.map((name) => ({ name })),
    limit: String(limit),
  };
  if (dimensionFilter) body.dimensionFilter = dimensionFilter;
  return formatGa4(
    await googlePost(`https://analyticsdata.googleapis.com/v1beta/${propPath(property)}:runRealtimeReport`, body),
  );
}

// ── GA4 Admin (write) ───────────────────────────────────────────────────────
const ADMIN = "https://analyticsadmin.googleapis.com/v1beta";

async function listAll(url, key) {
  const out = [];
  let pageToken;
  do {
    const sep = url.includes("?") ? "&" : "?";
    const j = await googleGet(`${url}${sep}pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
    out.push(...(j[key] || []));
    pageToken = j.nextPageToken;
  } while (pageToken);
  return out;
}

async function ga4ListDataStreams({ property }) {
  const streams = await listAll(`${ADMIN}/${propPath(property)}/dataStreams`, "dataStreams");
  return {
    count: streams.length,
    dataStreams: streams.map((s) => ({
      name: s.name,
      type: s.type,
      displayName: s.displayName,
      measurementId: s.webStreamData?.measurementId,
      defaultUri: s.webStreamData?.defaultUri,
    })),
  };
}

async function ga4ListKeyEvents({ property }) {
  const keyEvents = await listAll(`${ADMIN}/${propPath(property)}/keyEvents`, "keyEvents");
  return { count: keyEvents.length, keyEvents };
}

const ga4CreateKeyEvent = ({ property, eventName, countingMethod = "ONCE_PER_EVENT" }) =>
  googlePost(`${ADMIN}/${propPath(property)}/keyEvents`, { eventName, countingMethod });

async function ga4ListCustomDefinitions({ property }) {
  const [customDimensions, customMetrics] = await Promise.all([
    listAll(`${ADMIN}/${propPath(property)}/customDimensions`, "customDimensions"),
    listAll(`${ADMIN}/${propPath(property)}/customMetrics`, "customMetrics"),
  ]);
  return { customDimensions, customMetrics };
}

const ga4CreateCustomDimension = ({ property, parameterName, displayName, scope = "EVENT", description }) =>
  googlePost(`${ADMIN}/${propPath(property)}/customDimensions`, { parameterName, displayName, scope, description });

const ga4CreateCustomMetric = ({ property, parameterName, displayName, measurementUnit = "STANDARD", description }) =>
  googlePost(`${ADMIN}/${propPath(property)}/customMetrics`, {
    parameterName,
    displayName,
    measurementUnit,
    scope: "EVENT",
    description,
  });

const ga4Guard = ({ method, path }) => guardDelete(method, path, [/^accounts\/[^/]+$/, /^properties\/[^/]+$/]);
const ga4AdminRequest = (a) => {
  ga4Guard(a);
  return googleRequest(a.method, apiUrl(`https://analyticsadmin.googleapis.com/${a.apiVersion || "v1beta"}`, a.path), a.body);
};

// ── GA4 Export / Backup ──────────────────────────────────────────────────────
// Complete, restorable configuration of a property. Core resources must succeed,
// alpha/link resources are best-effort. Measurement Protocol secrets without the secret value.
const ADMIN_ALPHA = "https://analyticsadmin.googleapis.com/v1alpha";

async function ga4CollectConfig(property) {
  const p = propPath(property);
  const { errors, opt } = collector();
  const [prop, dataStreams, keyEvents, customDimensions, customMetrics, dataRetentionSettings] = await Promise.all([
    googleGet(`${ADMIN}/${p}`),
    listAll(`${ADMIN}/${p}/dataStreams`, "dataStreams"),
    listAll(`${ADMIN}/${p}/keyEvents`, "keyEvents"),
    listAll(`${ADMIN}/${p}/customDimensions`, "customDimensions"),
    listAll(`${ADMIN}/${p}/customMetrics`, "customMetrics"),
    googleGet(`${ADMIN}/${p}/dataRetentionSettings`),
  ]);
  const [googleAdsLinks, firebaseLinks, attributionSettings, googleSignalsSettings, reportingDataAnnotations] = await Promise.all([
    opt("googleAdsLinks", () => listAll(`${ADMIN}/${p}/googleAdsLinks`, "googleAdsLinks")),
    opt("firebaseLinks", () => listAll(`${ADMIN}/${p}/firebaseLinks`, "firebaseLinks")),
    opt("attributionSettings", () => googleGet(`${ADMIN_ALPHA}/${p}/attributionSettings`)),
    opt("googleSignalsSettings", () => googleGet(`${ADMIN_ALPHA}/${p}/googleSignalsSettings`)),
    opt("reportingDataAnnotations", () => listAll(`${ADMIN_ALPHA}/${p}/reportingDataAnnotations`, "reportingDataAnnotations")),
  ]);
  const streams = await Promise.all(
    dataStreams.map(async (s) => ({
      ...s,
      enhancedMeasurementSettings:
        s.type === "WEB_DATA_STREAM"
          ? await opt(`${s.name}/enhancedMeasurementSettings`, () => googleGet(`${ADMIN_ALPHA}/${s.name}/enhancedMeasurementSettings`))
          : undefined,
      dataRedactionSettings:
        s.type === "WEB_DATA_STREAM"
          ? await opt(`${s.name}/dataRedactionSettings`, () => googleGet(`${ADMIN_ALPHA}/${s.name}/dataRedactionSettings`))
          : undefined,
      measurementProtocolSecrets: (
        await opt(`${s.name}/measurementProtocolSecrets`, () =>
          listAll(`${ADMIN}/${s.name}/measurementProtocolSecrets`, "measurementProtocolSecrets"),
        )
      )?.map(({ secretValue, ...rest }) => ({ ...rest, secretValue: secretValue ? "[removed]" : undefined })),
    })),
  );
  return {
    data: {
      property: prop,
      dataStreams: streams,
      keyEvents,
      customDimensions,
      customMetrics,
      dataRetentionSettings,
      googleAdsLinks,
      firebaseLinks,
      attributionSettings,
      googleSignalsSettings,
      reportingDataAnnotations,
    },
    errors,
  };
}

const ga4Snapshot = async (property, label) => saveSnapshot("ga4", propId(property), label, await ga4CollectConfig(property));

async function ga4ExportConfig({ property, label = "manual" }) {
  const snap = await ga4CollectConfig(property);
  const backup = saveSnapshot("ga4", propId(property), label, snap);
  const d = snap.data;
  return {
    backup,
    property: d.property.displayName,
    counts: {
      dataStreams: d.dataStreams.length,
      keyEvents: d.keyEvents.length,
      customDimensions: d.customDimensions.length,
      customMetrics: d.customMetrics.length,
    },
    incomplete: snap.errors,
  };
}

async function ga4ChangeHistory({ property, earliestChangeTime, latestChangeTime, resourceTypes, actions, actorEmails, pageSize = 25, pageToken }) {
  const p = propPath(property);
  const { parent } = await googleGet(`${ADMIN}/${p}`); // accounts/123
  const body = { property: p, pageSize, pageToken, earliestChangeTime, latestChangeTime };
  if (resourceTypes?.length) body.resourceType = resourceTypes;
  if (actions?.length) body.action = actions;
  if (actorEmails?.length) body.actorEmail = actorEmails;
  return googlePost(`${ADMIN}/${parent}:searchChangeHistoryEvents`, body);
}

// ── GA4 data redaction (v1alpha) ─────────────────────────────────────────────
// Redacts email addresses and freely chosen URL parameters before GA4 stores them (web streams only).
const streamPath = (property, dataStreamId) => `${propPath(property)}/dataStreams/${num(dataStreamId, "dataStreamId")}`;

// Google omits fields with the default value (false, empty list) from the response (proto3 JSON). Add them
// explicitly here so that "missing" does not look like a data error.
const redactionDefaults = (r) => ({
  dataStreamId: r.name?.split("/")[3],
  emailRedactionEnabled: false,
  queryParameterRedactionEnabled: false,
  queryParameterKeys: [],
  ...r,
});

async function ga4GetDataRedaction({ property, dataStreamId }) {
  const ids = dataStreamId
    ? [dataStreamId]
    : (await listAll(`${ADMIN}/${propPath(property)}/dataStreams`, "dataStreams"))
        .filter((s) => s.type === "WEB_DATA_STREAM")
        .map((s) => s.name.split("/").pop());
  const settings = [];
  for (const id of ids) {
    settings.push(redactionDefaults(await googleGet(`${ADMIN_ALPHA}/${streamPath(property, id)}/dataRedactionSettings`)));
  }
  return { count: settings.length, settings };
}

async function ga4UpdateDataRedaction({ property, dataStreamId, emailRedactionEnabled, queryParameterRedactionEnabled, queryParameterKeys }) {
  const body = { emailRedactionEnabled, queryParameterRedactionEnabled, queryParameterKeys };
  const mask = Object.keys(body).filter((k) => body[k] !== undefined);
  if (!mask.length) throw new Error("Nothing to change: specify at least one field.");
  return redactionDefaults(await googleRequest(
    "PATCH",
    `${ADMIN_ALPHA}/${streamPath(property, dataStreamId)}/dataRedactionSettings?updateMask=${mask.join(",")}`,
    body,
  ));
}

// ── GTM ──────────────────────────────────────────────────────────────────────
async function gtmListAccounts() {
  const j = await googleGet("https://www.googleapis.com/tagmanager/v2/accounts");
  const accounts = [];
  for (const a of j.account || []) {
    const cj = await googleGet(`https://www.googleapis.com/tagmanager/v2/accounts/${a.accountId}/containers`);
    accounts.push({
      accountId: a.accountId,
      name: a.name,
      containers: (cj.container || []).map((c) => ({
        containerId: c.containerId,
        name: c.name,
        publicId: c.publicId,
        usageContext: c.usageContext,
      })),
    });
  }
  return { count: accounts.length, accounts };
}

async function gtmExportContainer({ accountId, containerId, containerVersionId }) {
  const base = `https://www.googleapis.com/tagmanager/v2/accounts/${num(accountId, "accountId")}/containers/${num(containerId, "containerId")}`;
  const live = await googleGet(
    containerVersionId ? `${base}/versions/${num(containerVersionId, "containerVersionId")}` : `${base}/versions:live`,
  );
  const pick = (arr, fields) => (arr || []).map((x) => Object.fromEntries(fields.map((f) => [f, x[f]])));
  return {
    container: live.container
      ? { name: live.container.name, publicId: live.container.publicId, usageContext: live.container.usageContext }
      : null,
    versionId: live.containerVersionId,
    name: live.name,
    counts: {
      tags: (live.tag || []).length,
      triggers: (live.trigger || []).length,
      variables: (live.variable || []).length,
      builtInVariables: (live.builtInVariable || []).length,
      folders: (live.folder || []).length,
    },
    tags: pick(live.tag, ["tagId", "name", "type", "firingTriggerId", "blockingTriggerId", "paused"]),
    triggers: pick(live.trigger, ["triggerId", "name", "type"]),
    variables: pick(live.variable, ["variableId", "name", "type"]),
  };
}

// ── GTM (schreibend) ─────────────────────────────────────────────────────────
// Flow: workspace → create/change tags/triggers/variables → create version → (after approval) publish.
const GTM = "https://www.googleapis.com/tagmanager/v2";
const ctr = ({ accountId, containerId }) => `${GTM}/accounts/${num(accountId, "accountId")}/containers/${num(containerId, "containerId")}`;
const ws = (a) => `${ctr(a)}/workspaces/${num(a.workspaceId, "workspaceId")}`;
const GTM_ENTITY_TYPES = ["tags", "triggers", "variables", "folders", "templates", "clients", "transformations", "zones"];
const entityKey = (t) => t.replace(/s$/, ""); // tags → tag (list key of the API)

async function gtmPaged(url, key) {
  const out = [];
  let pageToken;
  do {
    const sep = url.includes("?") ? "&" : "?";
    const j = await googleGet(pageToken ? `${url}${sep}pageToken=${encodeURIComponent(pageToken)}` : url);
    out.push(...(j[key] || []));
    pageToken = j.nextPageToken;
  } while (pageToken);
  return out;
}

async function gtmListWorkspaces(a) {
  const workspaces = await gtmPaged(`${ctr(a)}/workspaces`, "workspace");
  return { count: workspaces.length, workspaces: workspaces.map(({ workspaceId, name, description }) => ({ workspaceId, name, description })) };
}

const gtmCreateWorkspace = ({ accountId, containerId, name, description }) =>
  googlePost(`${ctr({ accountId, containerId })}/workspaces`, { name, description });

// Which entity is in a WorkspaceChange/MergeConflict? (exactly one of the fields is set)
const CHANGE_ENTITIES = {
  tag: "tagId",
  trigger: "triggerId",
  variable: "variableId",
  folder: "folderId",
  client: "clientId",
  transformation: "transformationId",
  zone: "zoneId",
  customTemplate: "templateId",
  builtInVariable: "type",
  gtagConfig: "gtagConfigId",
};
function describeEntity(e) {
  for (const [key, idKey] of Object.entries(CHANGE_ENTITIES)) {
    if (e?.[key]) return { type: key, id: e[key][idKey], name: e[key].name, ...(e[key].type && key !== "builtInVariable" ? { kind: e[key].type } : {}) };
  }
  return { type: "unknown" };
}

// Compact (default): only kind of change, type, ID, name. full=true returns the complete API response incl. code.
async function gtmWorkspaceStatus(a) {
  const j = await googleGet(`${ws(a)}/status`);
  if (a.full) return j;
  const changes = (j.workspaceChange || []).map((c) => ({ change: c.changeStatus, ...describeEntity(c) }));
  return {
    count: changes.length,
    changes,
    mergeConflicts: (j.mergeConflict || []).map((m) => ({
      workspace: describeEntity(m.entityInWorkspace),
      base: describeEntity(m.entityInBaseVersion),
    })),
  };
}

async function gtmListEntities(a) {
  const items = await gtmPaged(`${ws(a)}/${a.entityType}`, entityKey(a.entityType));
  return { count: items.length, [a.entityType]: items };
}

// Without entityId → create (POST), with entityId → replace completely (PUT, optionally with fingerprint check).
function gtmSaveEntity(a) {
  const base = `${ws(a)}/${a.entityType}`;
  if (!a.entityId) return googlePost(base, a.entity);
  const fp = a.entity?.fingerprint ? `?fingerprint=${encodeURIComponent(a.entity.fingerprint)}` : "";
  return googleRequest("PUT", `${base}/${num(a.entityId, "entityId")}${fp}`, a.entity);
}

async function gtmDeleteEntity(a) {
  await googleRequest("DELETE", `${ws(a)}/${a.entityType}/${num(a.entityId, "entityId")}`);
  return { deleted: `${a.entityType}/${a.entityId}` };
}

const gtmEnableBuiltInVariables = (a) =>
  googlePost(`${ws(a)}/built_in_variables?${a.types.map((t) => `type=${encodeURIComponent(t)}`).join("&")}`);

// ── GTM pre-check ────────────────────────────────────────────────────────────
async function gtmKnownVariableNames(a) {
  const [vars, builtIns] = await Promise.all([
    gtmPaged(`${ws(a)}/variables`, "variable"),
    gtmPaged(`${ws(a)}/built_in_variables`, "builtInVariable"),
  ]);
  return [...vars, ...builtIns].map((v) => v.name);
}

// Before gtm_save_entity: JS syntax (ES5 strict) + do all {{variables}} exist? Error → do not save.
async function gtmValidateEntity(a) {
  if (a.entityId) num(a.entityId, "entityId");
  if (a.skipValidation) return;
  const errors = validateEntityCode(a.entity);
  if (referencedVariables(a.entity).length) {
    const missing = unknownVariables(a.entity, await gtmKnownVariableNames(a));
    if (missing.length) {
      errors.push(
        `Unknown variable(s): ${missing.map((n) => `{{${n}}}`).join(", ")}. ` +
          "Create it first (gtm_save_entity, entityType variables) or enable the built-in variable (gtm_enable_built_in_variables).",
      );
    }
  }
  if (errors.length) {
    throw new Error(
      "Pre-check failed, nothing saved:\n- " + errors.join("\n- ") +
        "\n(Only for a false positive: skipValidation=true.)",
    );
  }
}

// Checks all tags, triggers and variables of a workspace — finds the cause behind "compilerError".
async function gtmValidateWorkspace(a) {
  const [tags, triggers, variables, builtIns] = await Promise.all([
    gtmPaged(`${ws(a)}/tags`, "tag"),
    gtmPaged(`${ws(a)}/triggers`, "trigger"),
    gtmPaged(`${ws(a)}/variables`, "variable"),
    gtmPaged(`${ws(a)}/built_in_variables`, "builtInVariable"),
  ]);
  const known = [...variables, ...builtIns].map((v) => v.name);
  const problems = [];
  for (const [kind, list] of [["tag", tags], ["trigger", triggers], ["variable", variables]]) {
    for (const e of list) {
      const errors = validateEntityCode(e);
      const missing = unknownVariables(e, known);
      if (missing.length) errors.push(`Unknown variable(s): ${missing.map((n) => `{{${n}}}`).join(", ")}`);
      if (errors.length) problems.push({ type: kind, id: e[`${kind}Id`], name: e.name, errors });
    }
  }
  return {
    ok: problems.length === 0,
    checked: { tags: tags.length, triggers: triggers.length, variables: variables.length },
    problems,
  };
}

// Test run without a version: compiles the workspace but returns only the result instead of ~180k characters of container.
async function gtmQuickPreview(a) {
  const j = await googlePost(`${ws(a)}:quick_preview`);
  const v = j.containerVersion || {};
  const out = {
    compilerError: j.compilerError || false,
    syncStatus: j.syncStatus,
    counts: {
      tags: (v.tag || []).length,
      triggers: (v.trigger || []).length,
      variables: (v.variable || []).length,
      builtInVariables: (v.builtInVariable || []).length,
    },
  };
  // GTM gives no details — so search for the cause ourselves.
  if (out.compilerError) out.likelyCauses = await gtmValidateWorkspace(a);
  return out;
}

// Resets an entity in the workspace to the state of the live version (newly created ones are removed).
async function gtmRevertEntity(a) {
  const fp = a.fingerprint ? `?fingerprint=${encodeURIComponent(a.fingerprint)}` : "";
  const j = await googlePost(`${ws(a)}/${a.entityType}/${num(a.entityId, "entityId")}:revert${fp}`);
  const e = j[entityKey(a.entityType)];
  return { reverted: `${a.entityType}/${a.entityId}`, state: e ? { name: e.name, type: e.type } : "removed (was new in the workspace)" };
}

async function gtmCreateVersion(a) {
  const j = await googlePost(`${ws(a)}:create_version`, { name: a.name, notes: a.notes });
  const v = j.containerVersion || {};
  return {
    containerVersionId: v.containerVersionId,
    name: v.name,
    compilerError: j.compilerError || false,
    syncStatus: j.syncStatus,
    newWorkspacePath: j.newWorkspacePath,
    counts: { tags: (v.tag || []).length, triggers: (v.trigger || []).length, variables: (v.variable || []).length },
  };
}

async function gtmPublishVersion({ accountId, containerId, containerVersionId }) {
  const j = await googlePost(`${ctr({ accountId, containerId })}/versions/${num(containerVersionId, "containerVersionId")}:publish`);
  return {
    published: j.containerVersion?.containerVersionId,
    name: j.containerVersion?.name,
    compilerError: j.compilerError || false,
  };
}

const gtmGuard = ({ method, path }) => guardDelete(method, path, [/^accounts\/[^/]+$/, /^accounts\/[^/]+\/containers\/[^/]+$/]);
// Publishing only via gtm_publish_version (preview + confirm), never bypassing the approval step.
function gtmGuardPublish({ method, path }) {
  if (method !== "GET" && /:publish$/.test(cleanPath(path).split("?")[0])) {
    throw new Error("Blocked: publishing only via gtm_publish_version (with preview and confirm).");
  }
}
const gtmRequest = (a) => {
  gtmGuard(a);
  gtmGuardPublish(a);
  return googleRequest(a.method, apiUrl(GTM, a.path), a.body);
};

// ── GTM export / backup ──────────────────────────────────────────────────────
// GTM only stores created versions — not unsaved workspace changes. So before
// every workspace change, back up the complete workspace; before publishing, the live version.
// Sequential, because the GTM API quota per user is tight.
const gtmId = (a) => `${a.accountId}-${a.containerId}`;

async function gtmCollectWorkspace(a) {
  const { errors, opt } = collector();
  const container = await googleGet(ctr(a));
  const isServer = (container.usageContext || []).includes("server");
  const types = ["tags", "triggers", "variables", "folders", "templates", ...(isServer ? ["clients", "transformations"] : ["zones"])];
  const data = { container, workspace: await googleGet(ws(a)) };
  for (const t of types) data[t] = await opt(t, () => gtmPaged(`${ws(a)}/${t}`, entityKey(t)));
  data.builtInVariables = await opt("builtInVariables", () => gtmPaged(`${ws(a)}/built_in_variables`, "builtInVariable"));
  return { data, errors };
}

async function gtmCollectVersion(a, containerVersionId = "live") {
  const url = containerVersionId === "live" ? `${ctr(a)}/versions:live` : `${ctr(a)}/versions/${num(containerVersionId, "containerVersionId")}`;
  return { data: { containerVersion: await googleGet(url) }, errors: {} };
}

const gtmSnapshotWorkspace = async (a, label) => saveSnapshot("gtm", gtmId(a), `${label}_ws${a.workspaceId}`, await gtmCollectWorkspace(a));

async function gtmSnapshotLive(a, label) {
  try {
    return saveSnapshot("gtm", gtmId(a), `${label}_live`, await gtmCollectVersion(a));
  } catch (e) {
    if (/Google API 404/.test(e.message)) return "no backup: container was never published";
    throw e;
  }
}

async function gtmExportWorkspace(a) {
  const snap = await gtmCollectWorkspace(a);
  const backup = saveSnapshot("gtm", gtmId(a), `${a.label || "manual"}_ws${a.workspaceId}`, snap);
  const counts = Object.fromEntries(
    Object.entries(snap.data).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]),
  );
  return { backup, workspace: snap.data.workspace.name, counts, incomplete: snap.errors };
}

async function gtmExportVersion(a) {
  const snap = await gtmCollectVersion(a, a.containerVersionId || "live");
  const v = snap.data.containerVersion;
  const backup = saveSnapshot("gtm", gtmId(a), `${a.label || "manual"}_v${v.containerVersionId}`, snap);
  return {
    backup,
    containerVersionId: v.containerVersionId,
    name: v.name,
    counts: { tags: (v.tag || []).length, triggers: (v.trigger || []).length, variables: (v.variable || []).length },
  };
}

// Backup for the free-form request tools, based on the path.
async function ga4SnapshotForPath(path, label) {
  const m = cleanPath(path).match(/^properties\/(\d+)/);
  return m ? ga4Snapshot(m[1], label) : "no backup: path without properties/<id>";
}

async function gtmSnapshotForPath(path, label) {
  const m = cleanPath(path).match(/^accounts\/([^/]+)\/containers\/([^/:?]+)(?:\/workspaces\/([^/:?]+))?/);
  if (!m) return "no backup: path without accounts/<id>/containers/<id>";
  const a = { accountId: m[1], containerId: m[2], workspaceId: m[3] };
  return a.workspaceId ? gtmSnapshotWorkspace(a, label) : gtmSnapshotLive(a, label);
}

// ── GA4 Data API: metadata, compatibility, funnel ───────────────────────────
const DATA = "https://analyticsdata.googleapis.com/v1beta";
const DATA_ALPHA = "https://analyticsdata.googleapis.com/v1alpha";

// All dimensions/metrics of the property incl. custom ones. Without a filter only the apiNames,
// because the full list (500+ entries with descriptions) would blow up the context.
async function ga4GetMetadata({ property, search, kind = "all", customOnly = false, category, details = false }) {
  const j = await googleGet(`${DATA}/${propPath(property)}/metadata`);
  const q = search ? String(search).toLowerCase() : null;
  const cat = category ? String(category).toLowerCase() : null;
  const match = (x) =>
    (!customOnly || x.customDefinition) &&
    (!cat || String(x.category || "").toLowerCase().includes(cat)) &&
    (!q || [x.apiName, x.uiName, x.description, ...(x.deprecatedApiNames || [])].some((s) => String(s || "").toLowerCase().includes(q)));
  const dims = kind === "metrics" ? [] : (j.dimensions || []).filter(match);
  const mets = kind === "dimensions" ? [] : (j.metrics || []).filter(match);
  const counts = { dimensions: dims.length, metrics: mets.length };
  if (!q && !cat && !customOnly && !details) {
    return {
      counts,
      note: "apiNames only. Narrow down with search, category or customOnly to get uiName, category and type.",
      dimensions: dims.map((d) => d.apiName),
      metrics: mets.map((m) => m.apiName),
    };
  }
  const base = (x) => ({
    apiName: x.apiName,
    uiName: x.uiName,
    category: x.category,
    ...(x.customDefinition ? { custom: true } : {}),
    ...(x.deprecatedApiNames?.length ? { deprecatedApiNames: x.deprecatedApiNames } : {}),
    ...(details ? { description: x.description } : {}),
  });
  return {
    counts,
    dimensions: dims.map(base),
    metrics: mets.map((m) => ({
      ...base(m),
      type: m.type,
      ...(m.expression ? { expression: m.expression } : {}),
      ...(m.blockedReasons?.length ? { blockedReasons: m.blockedReasons } : {}),
    })),
  };
}

// Do these dimensions/metrics fit into a shared report? Optionally: what else could be added.
async function ga4CheckCompatibility({ property, dimensions = [], metrics = [], dimensionFilter, metricFilter, listAddable = false }) {
  if (!dimensions.length && !metrics.length) throw new Error("Specify at least one dimension or metric.");
  const body = { dimensions: dimensions.map((name) => ({ name })), metrics: metrics.map((name) => ({ name })) };
  if (dimensionFilter) body.dimensionFilter = dimensionFilter;
  if (metricFilter) body.metricFilter = metricFilter;
  const j = await googlePost(`${DATA}/${propPath(property)}:checkCompatibility`, body);
  const dc = (j.dimensionCompatibilities || []).map((c) => ({ name: c.dimensionMetadata?.apiName, compatibility: c.compatibility }));
  const mc = (j.metricCompatibilities || []).map((c) => ({ name: c.metricMetadata?.apiName, compatibility: c.compatibility }));
  const status = (list, names) =>
    names.map((name) => ({
      name,
      compatibility: list.find((c) => c.name === name)?.compatibility ?? "UNKNOWN (check the name with ga4_get_metadata)",
    }));
  const requested = { dimensions: status(dc, dimensions), metrics: status(mc, metrics) };
  const out = {
    compatible: [...requested.dimensions, ...requested.metrics].every((x) => x.compatibility === "COMPATIBLE"),
    requested,
  };
  if (listAddable) {
    out.addable = {
      dimensions: dc.filter((c) => c.compatibility === "COMPATIBLE" && !dimensions.includes(c.name)).map((c) => c.name),
      metrics: mc.filter((c) => c.compatibility === "COMPATIBLE" && !metrics.includes(c.name)).map((c) => c.name),
    };
  }
  return out;
}

// One funnel step: event (optionally with a URL part) or a raw FunnelFilterExpression.
function funnelStepFilter(s, i) {
  if (s.filterExpression) return s.filterExpression;
  if (!s.eventName) throw new Error(`Step ${i + 1} (${s.name}): specify eventName or filterExpression.`);
  const f = { eventName: s.eventName };
  if (s.urlContains) {
    f.funnelParameterFilterExpression = {
      funnelParameterFilter: { eventParameterName: "page_location", stringFilter: { matchType: "CONTAINS", value: s.urlContains } },
    };
  }
  return { funnelEventFilter: f };
}

async function ga4RunFunnelReport({
  property,
  steps,
  startDate = "28daysAgo",
  endDate = "yesterday",
  isOpenFunnel = false,
  breakdownDimension,
  breakdownLimit,
  dimensionFilter,
  limit,
}) {
  const body = {
    dateRanges: [{ startDate, endDate }],
    funnel: {
      isOpenFunnel,
      steps: steps.map((s, i) => ({
        name: s.name,
        ...(s.isDirectlyFollowedBy ? { isDirectlyFollowedBy: true } : {}),
        ...(s.withinDurationFromPriorStep ? { withinDurationFromPriorStep: s.withinDurationFromPriorStep } : {}),
        filterExpression: funnelStepFilter(s, i),
      })),
    },
  };
  if (breakdownDimension) {
    body.funnelBreakdown = { breakdownDimension: { name: breakdownDimension }, ...(breakdownLimit ? { limit: String(breakdownLimit) } : {}) };
  }
  if (dimensionFilter) body.dimensionFilter = dimensionFilter;
  if (limit) body.limit = String(limit);
  const j = await googlePost(`${DATA_ALPHA}/${propPath(property)}:runFunnelReport`, body);
  const t = j.funnelTable || {};
  return { ...formatGa4(t), ...(t.metadata?.samplingMetadatas ? { sampling: t.metadata.samplingMetadatas } : {}) };
}

// ── GA4 annotations (reporting data annotations, v1alpha) ───────────────────
function parseDate(s, name) {
  const m = String(s ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`${name}: specify the date as YYYY-MM-DD, got '${s}'`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}
const fmtDate = (d) => (d ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` : undefined);

async function ga4ListAnnotations({ property }) {
  const items = await listAll(`${ADMIN_ALPHA}/${propPath(property)}/reportingDataAnnotations`, "reportingDataAnnotations");
  const annotations = items
    .map((x) => ({
      id: x.name?.split("/").pop(),
      title: x.title,
      description: x.description,
      color: x.color,
      date: fmtDate(x.annotationDate),
      from: fmtDate(x.annotationDateRange?.startDate),
      to: fmtDate(x.annotationDateRange?.endDate),
      ...(x.systemGenerated ? { systemGenerated: true } : {}),
    }))
    .sort((a, b) => ((a.date || a.from || "") < (b.date || b.from || "") ? 1 : -1));
  return { count: annotations.length, annotations };
}

function ga4CreateAnnotation({ property, title, description, date, endDate, color = "BLUE" }) {
  const body = { title, color, ...(description ? { description } : {}) };
  if (endDate) body.annotationDateRange = { startDate: parseDate(date, "date"), endDate: parseDate(endDate, "endDate") };
  else body.annotationDate = parseDate(date, "date");
  return googlePost(`${ADMIN_ALPHA}/${propPath(property)}/reportingDataAnnotations`, body);
}

// ── GTM: versions, sync, conflicts, gallery, snippet ────────────────────────
const versionCounts = (v) => ({
  tags: Number(v.numTags ?? (v.tag || []).length) || 0,
  triggers: Number(v.numTriggers ?? (v.trigger || []).length) || 0,
  variables: Number(v.numVariables ?? (v.variable || []).length) || 0,
  templates: Number(v.numCustomTemplates ?? (v.customTemplate || []).length) || 0,
});

async function gtmLiveVersionId(a) {
  try {
    return (await googleGet(`${ctr(a)}/versions:live?fields=containerVersionId`)).containerVersionId;
  } catch (e) {
    if (/Google API 404/.test(e.message)) return null; // never published
    throw e;
  }
}

async function gtmListVersions(a) {
  const [headers, liveId] = await Promise.all([
    gtmPaged(`${ctr(a)}/version_headers${a.includeDeleted ? "?includeDeleted=true" : ""}`, "containerVersionHeader"),
    gtmLiveVersionId(a),
  ]);
  const versions = headers
    .sort((x, y) => Number(y.containerVersionId) - Number(x.containerVersionId))
    .slice(0, a.limit || 20)
    .map((v) => ({
      containerVersionId: v.containerVersionId,
      name: v.name,
      ...(v.containerVersionId === liveId ? { live: true } : {}),
      ...(v.deleted ? { deleted: true } : {}),
      counts: versionCounts(v),
    }));
  return { liveVersionId: liveId, count: headers.length, versions };
}

// What changes between two versions? (comparison via ID + fingerprint)
function diffVersions(from, to) {
  const out = {};
  for (const [k, idKey] of [["tag", "tagId"], ["trigger", "triggerId"], ["variable", "variableId"], ["customTemplate", "templateId"]]) {
    const before = new Map((from[k] || []).map((e) => [e[idKey], e]));
    const after = new Map((to[k] || []).map((e) => [e[idKey], e]));
    const added = [...after.values()].filter((e) => !before.has(e[idKey])).map((e) => e.name);
    const removed = [...before.values()].filter((e) => !after.has(e[idKey])).map((e) => e.name);
    const changed = [...after.values()]
      .filter((e) => before.has(e[idKey]) && before.get(e[idKey]).fingerprint !== e.fingerprint)
      .map((e) => e.name);
    if (added.length || removed.length || changed.length) out[k] = { added, removed, changed };
  }
  return out;
}

async function gtmPublishPreview(a) {
  const target = await googleGet(`${ctr(a)}/versions/${num(a.containerVersionId, "containerVersionId")}`);
  const liveId = await gtmLiveVersionId(a);
  const live = liveId ? await googleGet(`${ctr(a)}/versions/${liveId}`) : null;
  return {
    action: "Publish version, goes live on the website immediately",
    container: target.container?.publicId,
    target: { containerVersionId: target.containerVersionId, name: target.name, ...(target.deleted ? { deleted: true } : {}), counts: versionCounts(target) },
    live: live ? { containerVersionId: live.containerVersionId, name: live.name, counts: versionCounts(live) } : "never published",
    ...(live && target.containerVersionId === live.containerVersionId ? { note: "This version is already live." } : {}),
    ...(live && Number(target.containerVersionId) < Number(live.containerVersionId) ? { rollback: true } : {}),
    ...(live ? { changesVsLive: diffVersions(live, target) } : {}),
  };
}

// Before deleting: what is it, and who still references it?
async function gtmDeletePreview(a) {
  const e = await googleGet(`${ws(a)}/${a.entityType}/${num(a.entityId, "entityId")}`);
  const usedBy = [];
  if (a.entityType === "triggers" || a.entityType === "variables") {
    const [tags, triggers, variables] = await Promise.all([
      gtmPaged(`${ws(a)}/tags`, "tag"),
      gtmPaged(`${ws(a)}/triggers`, "trigger"),
      gtmPaged(`${ws(a)}/variables`, "variable"),
    ]);
    if (a.entityType === "triggers") {
      for (const t of tags) {
        if ([...(t.firingTriggerId || []), ...(t.blockingTriggerId || [])].includes(String(a.entityId))) usedBy.push({ type: "tag", id: t.tagId, name: t.name });
      }
    } else {
      const needle = `{{${e.name}}}`;
      for (const [kind, list] of [["tag", tags], ["trigger", triggers], ["variable", variables]]) {
        for (const x of list) {
          if (kind === "variable" && x.variableId === String(a.entityId)) continue;
          if (JSON.stringify(x).includes(needle)) usedBy.push({ type: kind, id: x[`${kind}Id`], name: x.name });
        }
      }
    }
  }
  return {
    action: `Delete from the workspace: ${a.entityType}/${a.entityId} (live only after version + publish)`,
    entity: { name: e.name, type: e.type },
    usedBy,
    ...(usedBy.length ? { warning: "Still in use. Remove the references first, otherwise the version breaks." } : {}),
  };
}

// Before a DELETE via the free-form request tools: show the current state of the resource.
async function deletePreview(base, path) {
  const p = cleanPath(path).split("?")[0];
  let currentState;
  try {
    currentState = await googleGet(`${base}/${p}`);
  } catch (e) {
    currentState = `not readable: ${e.message}`;
  }
  return { action: `DELETE ${p}`, currentState };
}

async function gtmSyncWorkspace(a) {
  const j = await googlePost(`${ws(a)}:sync`);
  const conflicts = (j.mergeConflict || []).map((m) => ({ workspace: describeEntity(m.entityInWorkspace), base: describeEntity(m.entityInBaseVersion) }));
  return {
    syncError: j.syncStatus?.syncError || false,
    mergeConflict: j.syncStatus?.mergeConflict || false,
    conflicts,
    ...(conflicts.length ? { nextStep: "For each conflict call gtm_resolve_conflict with type, id and keep (workspace|base)." } : {}),
  };
}

// Resolve a conflict: take either the workspace or the base version (latest live/version state).
async function gtmResolveConflict(a) {
  const st = await googleGet(`${ws(a)}/status`);
  const isHit = (e) => {
    const d = describeEntity(e);
    return d.type === a.type && String(d.id) === String(a.id);
  };
  const hit = (st.mergeConflict || []).find((m) => isHit(m.entityInWorkspace) || isHit(m.entityInBaseVersion));
  if (!hit) throw new Error(`No open conflict for ${a.type} ${a.id}. gtm_workspace_status shows the open conflicts.`);
  const chosen = a.keep === "workspace" ? hit.entityInWorkspace : hit.entityInBaseVersion;
  if (!chosen || describeEntity(chosen).type === "unknown") {
    throw new Error(
      `The '${a.keep}' side no longer has this entity (deleted there). Resolve the conflict by hand then: ` +
        "gtm_delete_entity (accept the deletion) or gtm_save_entity (keep the entity).",
    );
  }
  const fp = hit.entityInWorkspace?.[a.type]?.fingerprint;
  await googlePost(`${ws(a)}:resolve_conflict${fp ? `?fingerprint=${encodeURIComponent(fp)}` : ""}`, chosen);
  return { resolved: `${a.type} ${a.id}`, kept: a.keep, name: describeEntity(chosen).name };
}

async function gtmImportGalleryTemplate(a) {
  if (a.acknowledgePermissions !== true) {
    throw new Error("acknowledgePermissions must be true: the template brings its own permissions (e.g. loading scripts, setting cookies).");
  }
  for (const k of ["galleryOwner", "galleryRepository"]) {
    if (!/^[A-Za-z0-9_.-]+$/.test(String(a[k] ?? ""))) throw new Error(`Invalid ${k}: '${a[k]}'`);
  }
  const q = new URLSearchParams({ galleryOwner: a.galleryOwner, galleryRepository: a.galleryRepository, acknowledgePermissions: "true" });
  if (a.gallerySha) q.set("gallerySha", a.gallerySha);
  const t = await googlePost(`${ws(a)}/templates:import_from_gallery?${q}`);
  return {
    templateId: t.templateId,
    name: t.name,
    galleryReference: t.galleryReference,
    note: "Tags of this template have the type 'cvt_<containerId>_<templateId>'. Code and permissions via gtm_list_entities (templates).",
  };
}

async function gtmContainerSnippet(a) {
  const [s, c] = await Promise.all([googleGet(`${ctr(a)}:snippet`), googleGet(`${ctr(a)}?fields=publicId,name,usageContext`)]);
  const out = { container: c.name, publicId: c.publicId, usageContext: c.usageContext, ...s };
  if (s.snippet && /^GTM-/.test(c.publicId || "")) {
    out.noscript =
      "<!-- Google Tag Manager (noscript) -->\n" +
      `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${c.publicId}"\n` +
      'height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>\n' +
      "<!-- End Google Tag Manager (noscript) -->";
    out.install = "snippet as high up as possible in <head>, noscript directly after the opening <body>.";
  }
  return out;
}

async function gtmLookupContainer({ id }) {
  const v = String(id ?? "").trim();
  if (!/^[A-Z]{1,4}-[A-Z0-9-]+$/i.test(v)) throw new Error(`Invalid ID: '${id}' (expected e.g. GTM-XXXX, G-XXXX, AW-123)`);
  const key = /^GTM-/i.test(v) ? "tagId" : "destinationId";
  const c = await googleGet(`${GTM}/accounts/containers:lookup?${key}=${encodeURIComponent(v)}`);
  return {
    accountId: c.accountId,
    containerId: c.containerId,
    name: c.name,
    publicId: c.publicId,
    usageContext: c.usageContext,
    tagIds: c.tagIds,
    tagManagerUrl: c.tagManagerUrl,
  };
}

// ── Selftest mode ────────────────────────────────────────────────────────────
if (process.argv.includes("--selftest")) {
  try {
    const info = await tokenInfo();
    console.log(`✓ Access token OK (${info.token} token${info.readonlyMode ? ", READONLY mode" : ""})`);
    console.log("  Scopes: " + info.scopes.map((s) => s.replace("https://www.googleapis.com/auth/", "")).join(", "));
    console.log("  Write: " + JSON.stringify(info.canWrite));

    const props = await ga4ListProperties();
    console.log(`\nGA4 properties (${props.count}):`);
    for (const p of props.properties) console.log(`  • ${p.displayName} → ${p.property}`);

    if (props.properties[0]) {
      const rep = await ga4RunReport({
        property: props.properties[0].property,
        metrics: ["sessions", "totalUsers"],
        dimensions: ["date"],
        limit: 3,
      });
      console.log(`\nSample report (${props.properties[0].displayName}), first rows:`);
      console.log("  " + JSON.stringify(rep.rows));
      const meta = await ga4GetMetadata({ property: props.properties[0].property });
      console.log(`  Metadata: ${meta.counts.dimensions} dimensions, ${meta.counts.metrics} metrics`);
    }

    const gtm = await gtmListAccounts();
    console.log(`\nGTM accounts (${gtm.count}):`);
    for (const a of gtm.accounts) {
      console.log(`  • ${a.name} (${a.accountId})`);
      for (const c of a.containers) console.log(`      - ${c.name} ${c.publicId} [${(c.usageContext || []).join("/")}]`);
    }

    console.log("\n✅ Selftest OK");
    process.exit(0);
  } catch (e) {
    console.error("❌ Selftest error:", e.message);
    process.exit(1);
  }
}

// ── MCP server ───────────────────────────────────────────────────────────────
const server = new McpServer({ name: "google-data", version: VERSION });

// Upper limit for tool responses, so a single call does not blow up the context.
const MAX_OUTPUT = Number(process.env.GOOGLE_DATA_MCP_MAX_OUTPUT) || 50_000;
function ok(data) {
  const text = JSON.stringify(data, null, 2);
  if (text.length <= MAX_OUTPUT) return { content: [{ type: "text", text }] };
  return {
    content: [
      {
        type: "text",
        text:
          `[Output truncated: ${text.length} characters, showing ${MAX_OUTPUT}. Narrow down with the Google parameter ` +
          "fields in the path (e.g. '…/tags?fields=tag(tagId,name,type)'), full=false or backup_read with select.]\n" +
          text.slice(0, MAX_OUTPUT),
      },
    ],
  };
}
const fail = (e) => ({ content: [{ type: "text", text: "Error: " + (e?.message || String(e)) }], isError: true });
// Tool hints for the client (approval prompts): read / write / go live.
const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
// Back up first, then write. If the backup fails, nothing happens at Google.
// validate runs before the backup (invalid input does not create superfluous snapshots).
const backedUp = (label, snapshot, fn, validate) => async (a) => {
  await validate?.(a);
  const backup = await snapshot(a, `before_${label}`);
  return { result: await fn(a), backup };
};
// Risky actions in two steps: without confirm only a preview (changes nothing, no backup),
// with confirm=true it is executed.
const CONFIRM_HINT = "Nothing changed. Review the preview, get approval, then repeat the same call with confirm=true.";
const confirmed = (preview, run) => async (a) => (a.confirm === true ? run(a) : { preview: await preview(a), note: CONFIRM_HINT });
const confirm = z
  .boolean()
  .optional()
  .describe("If omitted: preview only, changes nothing. Only run with true after review and approval.");
const tool = (fn) => async (args) => {
  try {
    return ok(await fn(args));
  } catch (e) {
    return fail(e);
  }
};

server.registerTool(
  "ga4_list_properties",
  {
    title: "GA4: List properties",
    description:
      "Lists all Google Analytics 4 properties the account can access (name + numeric property ID). You need the ID for ga4_run_report / ga4_realtime_report.",
    annotations: READ,
    inputSchema: {},
  },
  tool(() => ga4ListProperties()),
);

server.registerTool(
  "ga4_run_report",
  {
    title: "GA4: Report",
    description:
      "GA4 core report (Data API runReport). Example metrics: sessions, totalUsers, newUsers, screenPageViews, conversions, engagementRate, averageSessionDuration, bounceRate. Example dimensions: date, pagePath, pageTitle, sessionDefaultChannelGroup, sessionSource, sessionMedium, country, deviceCategory, landingPage.",
    annotations: READ,
    inputSchema: {
      property: z.string().describe("GA4 property ID, e.g. '123456789' or 'properties/123456789'"),
      metrics: z.array(z.string()).min(1).describe("Metrics, e.g. ['sessions','totalUsers','conversions']"),
      dimensions: z.array(z.string()).optional().describe("Optional dimensions, e.g. ['date'] or ['pagePath']"),
      startDate: z.string().optional().describe("Start: ISO date or relative like '28daysAgo' (default 28daysAgo)"),
      endDate: z.string().optional().describe("End: ISO date or 'yesterday'/'today' (default yesterday)"),
      limit: z.number().optional().describe("Max. rows (default 50)"),
      orderByMetric: z.string().optional().describe("Sort descending by this metric"),
      orderByDimension: z.string().optional().describe("Sort ascending by this dimension (e.g. 'date' for time series)"),
      dimensionFilter: z
        .record(z.any())
        .optional()
        .describe(
          "GA4 FilterExpression on dimensions. Examples: " +
            '{"filter":{"fieldName":"pagePath","stringFilter":{"matchType":"CONTAINS","value":"blog"}}} · ' +
            '{"filter":{"fieldName":"eventName","inListFilter":{"values":["click","generate_lead"]}}} · ' +
            'AND combination: {"andGroup":{"expressions":[{"filter":{...}},{"filter":{...}}]}}',
        ),
      metricFilter: z
        .record(z.any())
        .optional()
        .describe(
          "GA4 FilterExpression on metrics, e.g. " +
            '{"filter":{"fieldName":"sessions","numericFilter":{"operation":"GREATER_THAN","value":{"int64Value":"10"}}}}',
        ),
    },
  },
  tool((a) => ga4RunReport(a)),
);

server.registerTool(
  "ga4_realtime_report",
  {
    title: "GA4: Realtime",
    description:
      "GA4 realtime report (runRealtimeReport, last ~30 min). metrics e.g. ['activeUsers']; dimensions e.g. ['unifiedScreenName','country','deviceCategory'].",
    annotations: READ,
    inputSchema: {
      property: z.string().describe("GA4 property ID"),
      metrics: z.array(z.string()).min(1).describe("e.g. ['activeUsers']"),
      dimensions: z.array(z.string()).optional(),
      limit: z.number().optional(),
      dimensionFilter: z.record(z.any()).optional().describe("GA4 FilterExpression on dimensions, same syntax as for ga4_run_report"),
    },
  },
  tool((a) => ga4RealtimeReport(a)),
);

server.registerTool(
  "gtm_list_accounts",
  {
    title: "GTM: Accounts & containers",
    description:
      "Lists all Google Tag Manager accounts and their containers (publicId GTM-XXXX, numeric containerId, web/server). You need accountId + containerId for gtm_export_container.",
    annotations: READ,
    inputSchema: {},
  },
  tool(() => gtmListAccounts()),
);

server.registerTool(
  "gtm_export_container",
  {
    title: "GTM: Export container (live version)",
    description:
      "Reads the currently published (live) version of a GTM container: overview of all tags, triggers and variables — ideal for tracking audits. Requires accountId and containerId (from gtm_list_accounts). " +
      "With containerVersionId, an older version (from gtm_list_versions) instead, e.g. before a rollback.",
    annotations: READ,
    inputSchema: {
      accountId: z.string().describe("GTM accountId, e.g. '1234567890'"),
      containerId: z.string().describe("GTM containerId (numeric), e.g. '987654321'"),
      containerVersionId: z.string().optional().describe("Optional: a specific version instead of the live version"),
    },
  },
  tool((a) => gtmExportContainer(a)),
);

server.registerTool(
  "google_token_info",
  {
    title: "Google: Token & scopes",
    description:
      "Shows which refresh token is active (write / read-only) and which OAuth scopes it has — first check when a write tool fails with 403.",
    annotations: READ,
    inputSchema: {},
  },
  tool(() => tokenInfo()),
);

// ── GA4 Admin: read ──────────────────────────────────────────────────────────
const property = z.string().describe("GA4 property ID, e.g. '123456789' or 'properties/123456789'");

server.registerTool(
  "ga4_list_data_streams",
  {
    title: "GA4: Data streams",
    description: "Lists the data streams of a property (web streams with measurement ID G-XXXX and URL).",
    annotations: READ,
    inputSchema: { property },
  },
  tool((a) => ga4ListDataStreams(a)),
);

server.registerTool(
  "ga4_list_key_events",
  {
    title: "GA4: Key events",
    description: "Lists the events of a property marked as key events (formerly conversions).",
    annotations: READ,
    inputSchema: { property },
  },
  tool((a) => ga4ListKeyEvents(a)),
);

server.registerTool(
  "ga4_list_custom_definitions",
  {
    title: "GA4: Custom dimensions & metrics",
    description: "Lists all custom dimensions and custom metrics of a property.",
    annotations: READ,
    inputSchema: { property },
  },
  tool((a) => ga4ListCustomDefinitions(a)),
);

server.registerTool(
  "gtm_list_workspaces",
  {
    title: "GTM: Workspaces",
    description: "Lists the workspaces of a container. You need workspaceId for all GTM write tools.",
    annotations: READ,
    inputSchema: { accountId: z.string(), containerId: z.string() },
  },
  tool((a) => gtmListWorkspaces(a)),
);

const gtmWs = {
  accountId: z.string().describe("GTM accountId (from gtm_list_accounts)"),
  containerId: z.string().describe("GTM containerId, numeric"),
  workspaceId: z.string().describe("Workspace ID (from gtm_list_workspaces / gtm_create_workspace)"),
};
const entityType = z.enum(GTM_ENTITY_TYPES).describe("Entity type: tags, triggers, variables, folders, templates, clients, transformations, zones");

server.registerTool(
  "gtm_workspace_status",
  {
    title: "GTM: Workspace status",
    description:
      "Shows the changes and conflicts of a workspace compared to the live version — compact (kind of change, type, ID, name). " +
        "Check before gtm_create_version. full=true returns the complete entities incl. code.",
    annotations: READ,
    inputSchema: { ...gtmWs, full: z.boolean().optional().describe("Default false") },
  },
  tool((a) => gtmWorkspaceStatus(a)),
);

server.registerTool(
  "gtm_list_entities",
  {
    title: "GTM: Tags/triggers/variables in the workspace",
    description:
      "Returns the complete JSON objects (incl. parameter, fingerprint) of an entity type in the workspace — template for changing via gtm_save_entity.",
    annotations: READ,
    inputSchema: { ...gtmWs, entityType },
  },
  tool((a) => gtmListEntities(a)),
);

// ── Export / backup / change history ────────────────────────────────────────
const label = z.string().optional().describe("Short reason in the file name, e.g. 'before_relaunch' (default 'manual')");

server.registerTool(
  "ga4_export_config",
  {
    title: "GA4: Back up configuration",
    description:
      "Backs up the complete configuration of a property (settings, data streams incl. enhanced measurement, " +
        "key events, custom dimensions/metrics, data retention, links) as a local JSON file. " +
        "GA4 has no versions — this is the state to restore from. Read the content via backup_read.",
    annotations: READ,
    inputSchema: { property, label },
  },
  tool((a) => ga4ExportConfig(a)),
);

server.registerTool(
  "ga4_change_history",
  {
    title: "GA4: Change history",
    description:
      "Who changed what on the property and when (including in the GA4 UI), incl. state before/after. " +
        "Times as RFC3339, e.g. '2026-09-01T00:00:00Z'. Further pages via pageToken.",
    annotations: READ,
    inputSchema: {
      property,
      earliestChangeTime: z.string().optional(),
      latestChangeTime: z.string().optional(),
      resourceTypes: z.array(z.string()).optional().describe("e.g. ['CUSTOM_DIMENSION','DATA_STREAM','DATA_RETENTION_SETTINGS']"),
      actions: z.array(z.enum(["CREATED", "UPDATED", "DELETED"])).optional(),
      actorEmails: z.array(z.string()).optional(),
      pageSize: z.number().optional().describe("Default 25, max. 200"),
      pageToken: z.string().optional(),
    },
  },
  tool((a) => ga4ChangeHistory(a)),
);

server.registerTool(
  "gtm_export_workspace",
  {
    title: "GTM: Back up workspace",
    description:
      "Backs up a complete workspace (all tags, triggers, variables, folders, templates, built-in variables) as a local JSON file — " +
        "including unsaved changes that GTM itself does not version yet.",
    annotations: READ,
    inputSchema: { ...gtmWs, label },
  },
  tool((a) => gtmExportWorkspace(a)),
);

server.registerTool(
  "gtm_export_version",
  {
    title: "GTM: Back up version",
    description: "Backs up a container version (default: the live version) completely as a local JSON file.",
    annotations: READ,
    inputSchema: {
      accountId: z.string(),
      containerId: z.string(),
      containerVersionId: z.string().optional().describe("Default 'live'"),
      label,
    },
  },
  tool((a) => gtmExportVersion(a)),
);

server.registerTool(
  "backup_list",
  {
    title: "List backups",
    description: "Lists the local snapshots (newest first). id = GA4 property ID or GTM '<accountId>-<containerId>'.",
    annotations: READ,
    inputSchema: {
      platform: z.enum(["ga4", "gtm"]).optional(),
      id: z.string().optional(),
      limit: z.number().optional().describe("Default 50"),
    },
  },
  tool((a) => listBackups(a)),
);

server.registerTool(
  "backup_read",
  {
    title: "Read backup",
    description: "Reads a snapshot (path from backup_list or the backup field of a write action) — basis for comparison or restoring.",
    annotations: READ,
    inputSchema: {
      path: z.string().describe("Relative path, e.g. 'ga4/123456789/2026-09-27T10-00-00-000Z_manual.json'"),
      select: z.string().optional().describe("Read only a part, dot path, e.g. 'data.tags' or 'data.dataStreams.0'"),
    },
  },
  tool((a) => readBackup(a)),
);

server.registerTool(
  "gtm_quick_preview",
  {
    title: "GTM: Test workspace (quick preview)",
    description:
      "Compiles the workspace as a trial, without a version and without publishing anything. Returns only compilerError + number of " +
        "tags/triggers/variables. On compilerError it searches for the cause itself (likelyCauses).",
    annotations: READ,
    inputSchema: gtmWs,
  },
  tool((a) => gtmQuickPreview(a)),
);

server.registerTool(
  "gtm_validate_workspace",
  {
    title: "GTM: Validate workspace",
    description:
      "Checks all tags, triggers and variables in the workspace: JavaScript in Custom HTML/Custom JS (ES5 strict, incl. functions " +
        "in blocks) and whether every {{Variable}} exists. Returns name, ID, line and column per problem.",
    annotations: READ,
    inputSchema: gtmWs,
  },
  tool((a) => gtmValidateWorkspace(a)),
);

server.registerTool(
  "ga4_get_data_redaction",
  {
    title: "GA4: Show data redaction",
    description:
      "Shows the data redaction settings (email addresses, URL parameters) of the web data streams of a property (v1alpha).",
    annotations: READ,
    inputSchema: {
      property,
      dataStreamId: z.string().optional().describe("Numeric stream ID; if omitted, all web streams"),
    },
  },
  tool((a) => ga4GetDataRedaction(a)),
);

// ── GA4: metadata, compatibility, funnel, annotations (read) ────────────────
const filterExpr = z.record(z.any()).optional().describe("GA4 FilterExpression, same syntax as for ga4_run_report");

server.registerTool(
  "ga4_get_metadata",
  {
    title: "GA4: Available dimensions & metrics",
    description:
      "Lists the dimensions and metrics that ga4_run_report knows for this property, incl. custom ones (customEvent:…, customUser:…). " +
      "Use before a report instead of guessing API names. Without a filter only the apiNames; with search (substring in apiName, uiName, description), " +
      "category or customOnly, uiName, category and metric type are added.",
    annotations: READ,
    inputSchema: {
      property,
      search: z.string().optional().describe("Substring, e.g. 'page', 'source', 'lead'"),
      kind: z.enum(["all", "dimensions", "metrics"]).optional().describe("Default all"),
      customOnly: z.boolean().optional().describe("Only custom dimensions/metrics"),
      category: z.string().optional().describe("Category substring, e.g. 'Page / screen', 'Traffic source', 'Event'"),
      details: z.boolean().optional().describe("Include description (long, only useful together with a filter)"),
    },
  },
  tool((a) => ga4GetMetadata(a)),
);

server.registerTool(
  "ga4_check_compatibility",
  {
    title: "GA4: Check compatibility",
    description:
      "Checks whether the dimensions and metrics fit together in one ga4_run_report (not every combination is allowed). " +
      "compatible=false → requested shows which field is the problem. listAddable=true additionally returns all fields that can still be added.",
    annotations: READ,
    inputSchema: {
      property,
      dimensions: z.array(z.string()).optional(),
      metrics: z.array(z.string()).optional(),
      dimensionFilter: filterExpr,
      metricFilter: filterExpr,
      listAddable: z.boolean().optional().describe("Default false"),
    },
  },
  tool((a) => ga4CheckCompatibility(a)),
);

server.registerTool(
  "ga4_run_funnel_report",
  {
    title: "GA4: Funnel report",
    description:
      "Funnel analysis (Data API v1alpha runFunnelReport): how many users reach step 1, 2, 3 … and where they drop off. " +
      "Returns activeUsers, funnelStepCompletionRate, funnelStepAbandonments, funnelStepAbandonmentRate per step. " +
      "A step = eventName (optionally urlContains on page_location) or a raw FunnelFilterExpression. " +
      'Example: [{"name":"Landing page","eventName":"page_view","urlContains":"/heat-pump"},{"name":"Form","eventName":"form_start"},{"name":"Lead","eventName":"generate_lead"}].',
    annotations: READ,
    inputSchema: {
      property,
      steps: z
        .array(
          z.object({
            name: z.string().describe("Display name of the step"),
            eventName: z.string().optional().describe("Event, e.g. 'page_view', 'generate_lead'"),
            urlContains: z.string().optional().describe("Only events whose page_location contains this part"),
            isDirectlyFollowedBy: z.boolean().optional().describe("Must directly follow the previous step"),
            withinDurationFromPriorStep: z.string().optional().describe("Max. gap to the previous step, e.g. '1800s'"),
            filterExpression: z.record(z.any()).optional().describe("Raw FunnelFilterExpression instead of eventName/urlContains"),
          }),
        )
        .min(1),
      startDate: z.string().optional().describe("Default 28daysAgo"),
      endDate: z.string().optional().describe("Default yesterday"),
      isOpenFunnel: z.boolean().optional().describe("Open funnel: entry possible at any step (default false)"),
      breakdownDimension: z.string().optional().describe("Break down by, e.g. 'deviceCategory' or 'sessionDefaultChannelGroup'"),
      breakdownLimit: z.number().optional().describe("Max. breakdown values, 1–15 (default 5)"),
      dimensionFilter: filterExpr,
      limit: z.number().optional(),
    },
  },
  tool((a) => ga4RunFunnelReport(a)),
);

server.registerTool(
  "ga4_list_annotations",
  {
    title: "GA4: Annotations",
    description:
      "Lists the annotations of a property that GA4 shows in reports as markers: e.g. relaunch, GTM publish, campaign start. Newest first.",
    annotations: READ,
    inputSchema: { property },
  },
  tool((a) => ga4ListAnnotations(a)),
);

// ── GTM: versions, snippet, lookup (read) ───────────────────────────────────
server.registerTool(
  "gtm_list_versions",
  {
    title: "GTM: Versions",
    description:
      "Lists the container versions (newest first) with name, number of tags/triggers/variables and a live=true marker. " +
      "Basis for a rollback: view an older version via gtm_export_container (containerVersionId), then gtm_publish_version.",
    annotations: READ,
    inputSchema: {
      accountId: z.string(),
      containerId: z.string(),
      limit: z.number().optional().describe("Default 20"),
      includeDeleted: z.boolean().optional().describe("Include deleted versions"),
    },
  },
  tool((a) => gtmListVersions(a)),
);

server.registerTool(
  "gtm_container_snippet",
  {
    title: "GTM: Install code",
    description:
      "Returns the GTM install code of a container (head snippet and noscript part for the body), e.g. for onboarding or to check the installation on the website.",
    annotations: READ,
    inputSchema: { accountId: z.string(), containerId: z.string() },
  },
  tool((a) => gtmContainerSnippet(a)),
);

server.registerTool(
  "gtm_lookup_container",
  {
    title: "GTM: Find container by ID",
    description:
      "Finds the container with accountId and containerId for a public ID: GTM-XXXX (container ID) or a linked destination ID such as G-XXXX or AW-123456789.",
    annotations: READ,
    inputSchema: { id: z.string().describe("e.g. 'GTM-XXXXXXX' or 'AW-123456789'") },
  },
  tool((a) => gtmLookupContainer(a)),
);

// ── Write tools ──────────────────────────────────────────────────────────────
if (!READONLY_MODE) {
  server.registerTool(
    "ga4_create_key_event",
    {
      title: "GA4: Create key event",
      description: "Marks an event as a key event (formerly conversion), e.g. 'generate_lead'.",
      annotations: WRITE,
      inputSchema: {
        property,
        eventName: z.string().describe("Event name, e.g. 'generate_lead'"),
        countingMethod: z.enum(["ONCE_PER_EVENT", "ONCE_PER_SESSION"]).optional().describe("Default ONCE_PER_EVENT"),
      },
    },
    tool(backedUp("ga4_create_key_event", (a, l) => ga4Snapshot(a.property, l), ga4CreateKeyEvent)),
  );

  server.registerTool(
    "ga4_create_custom_dimension",
    {
      title: "GA4: Create custom dimension",
      description: "Creates a custom dimension for an event/user/item parameter.",
      annotations: WRITE,
      inputSchema: {
        property,
        parameterName: z.string().describe("Event parameter, e.g. 'form_id'"),
        displayName: z.string().describe("Display name in GA4"),
        scope: z.enum(["EVENT", "USER", "ITEM"]).optional().describe("Default EVENT"),
        description: z.string().optional(),
      },
    },
    tool(backedUp("ga4_create_custom_dimension", (a, l) => ga4Snapshot(a.property, l), ga4CreateCustomDimension)),
  );

  server.registerTool(
    "ga4_create_custom_metric",
    {
      title: "GA4: Create custom metric",
      description: "Creates a custom metric (event scope) for a numeric event parameter.",
      annotations: WRITE,
      inputSchema: {
        property,
        parameterName: z.string(),
        displayName: z.string(),
        measurementUnit: z
          .enum(["STANDARD", "CURRENCY", "FEET", "METERS", "KILOMETERS", "MILES", "MILLISECONDS", "SECONDS", "MINUTES", "HOURS"])
          .optional()
          .describe("Default STANDARD"),
        description: z.string().optional(),
      },
    },
    tool(backedUp("ga4_create_custom_metric", (a, l) => ga4Snapshot(a.property, l), ga4CreateCustomMetric)),
  );

  server.registerTool(
    "ga4_admin_request",
    {
      title: "GA4 Admin API: free-form request",
      description:
        "Arbitrary call to the GA4 Admin API (analyticsadmin.googleapis.com) for anything without its own tool — e.g. " +
          "PATCH 'properties/123/dataRetentionSettings?updateMask=eventDataRetention', " +
          "DELETE 'properties/123/keyEvents/456', POST 'properties/123/customDimensions/789:archive', " +
          "POST 'properties/123/dataStreams/111/measurementProtocolSecrets'. Path relative to the API version. " +
          "Without confirm=true, DELETE only shows the current state of the resource and deletes nothing.",
      annotations: DESTRUCTIVE,
      inputSchema: {
        method: z.enum(["GET", "POST", "PATCH", "DELETE"]),
        path: z.string().describe("Relative path incl. query, e.g. 'properties/123/keyEvents'"),
        body: z.record(z.any()).optional().describe("JSON body for POST/PATCH"),
        apiVersion: z.enum(["v1beta", "v1alpha"]).optional().describe("Default v1beta; v1alpha for alpha features"),
        confirm: confirm.describe("DELETE only: without it a preview, with true it deletes"),
      },
    },
    tool((a) => {
      if (a.method === "GET") return ga4AdminRequest(a);
      ga4Guard(a); // check the block before preview and backup
      const run = backedUp("ga4_admin_request", (x, l) => ga4SnapshotForPath(x.path, l), ga4AdminRequest);
      if (a.method !== "DELETE") return run(a);
      return confirmed((x) => deletePreview(`https://analyticsadmin.googleapis.com/${x.apiVersion || "v1beta"}`, x.path), run)(a);
    }),
  );

  server.registerTool(
    "ga4_create_annotation",
    {
      title: "GA4: Create annotation",
      description:
        "Creates an annotation that GA4 shows in reports as a marker: e.g. 'Relaunch', 'GTM: Consent Mode v2 live', 'Campaign start'. " +
        "One day (date) or a range (date + endDate). The color ORANGE is reserved for Google. Delete/change: ga4_admin_request (v1alpha).",
      annotations: WRITE,
      inputSchema: {
        property,
        title: z.string().describe("Short title"),
        description: z.string().optional(),
        date: z.string().describe("Day or start, YYYY-MM-DD"),
        endDate: z.string().optional().describe("End of a range, YYYY-MM-DD"),
        color: z.enum(["PURPLE", "BROWN", "BLUE", "GREEN", "RED", "CYAN"]).optional().describe("Default BLUE"),
      },
    },
    tool(
      backedUp("ga4_create_annotation", (a, l) => ga4Snapshot(a.property, l), ga4CreateAnnotation, (a) => {
        parseDate(a.date, "date");
        if (a.endDate) parseDate(a.endDate, "endDate");
      }),
    ),
  );

  server.registerTool(
    "gtm_create_workspace",
    {
      title: "GTM: Create workspace",
      description: "Creates a new workspace — always bundle changes in a separate workspace, not in the default workspace of the live site.",
      annotations: WRITE,
      inputSchema: { accountId: z.string(), containerId: z.string(), name: z.string(), description: z.string().optional() },
    },
    tool((a) => gtmCreateWorkspace(a)),
  );

  server.registerTool(
    "gtm_save_entity",
    {
      title: "GTM: Create or change tag/trigger/variable",
      description:
        "Without entityId: creates the entity (POST). With entityId: replaces it completely (PUT) — fetch it first via gtm_list_entities, " +
          "change it and send it back in full; if entity.fingerprint is included, GTM aborts if it was changed in the meantime. " +
          'Example GA4 event tag: {"name":"GA4 – generate_lead","type":"gaawe","parameter":[{"type":"template","key":"eventName","value":"generate_lead"},' +
          '{"type":"template","key":"measurementIdOverride","value":"G-XXXX"}],"firingTriggerId":["12"]}. ' +
          "Pre-check: JavaScript in Custom HTML tags and Custom JS variables must be ES5 strict (no let/const/arrow, " +
          "no function declaration in try/if/for), every {{Variable}} must exist in the workspace.",
      annotations: WRITE,
      inputSchema: {
        ...gtmWs,
        entityType,
        entity: z.record(z.any()).describe("GTM resource in API format (tag, trigger, variable …)"),
        entityId: z.string().optional().describe("ID of the existing entity (tagId/triggerId/variableId …) → update"),
        skipValidation: z.boolean().optional().describe("Skip the pre-check — only for a proven false positive"),
      },
    },
    tool(backedUp("gtm_save_entity", gtmSnapshotWorkspace, gtmSaveEntity, gtmValidateEntity)),
  );

  server.registerTool(
    "gtm_revert_entity",
    {
      title: "GTM: Revert change",
      description:
        "Resets an entity in the workspace to the state of the live version. An entity newly created in the workspace is removed in the process.",
      annotations: WRITE,
      inputSchema: {
        ...gtmWs,
        entityType,
        entityId: z.string(),
        fingerprint: z.string().optional().describe("Optional: aborts if the entity has been changed in the meantime"),
      },
    },
    tool(backedUp("gtm_revert_entity", gtmSnapshotWorkspace, gtmRevertEntity, (a) => num(a.entityId, "entityId"))),
  );

  server.registerTool(
    "ga4_update_data_redaction",
    {
      title: "GA4: Change data redaction",
      description:
        "Changes the data redaction of a web data stream: email addresses and/or the named URL parameters are redacted " +
          "before GA4 stores them. Takes effect immediately and only for new data. Only the specified fields are changed.",
      annotations: WRITE,
      inputSchema: {
        property,
        dataStreamId: z.string().describe("Numeric stream ID (from ga4_list_data_streams)"),
        emailRedactionEnabled: z.boolean().optional(),
        queryParameterRedactionEnabled: z.boolean().optional(),
        queryParameterKeys: z.array(z.string()).optional().describe("URL parameters, e.g. ['name','email','tel']"),
      },
    },
    tool(
      backedUp("ga4_update_data_redaction", (a, l) => ga4Snapshot(a.property, l), ga4UpdateDataRedaction, (a) => {
        num(a.dataStreamId, "dataStreamId");
        if ([a.emailRedactionEnabled, a.queryParameterRedactionEnabled, a.queryParameterKeys].every((v) => v === undefined)) {
          throw new Error("Nothing to change: specify at least one field.");
        }
      }),
    ),
  );

  server.registerTool(
    "gtm_delete_entity",
    {
      title: "GTM: Delete tag/trigger/variable",
      description:
        "Deletes an entity from the workspace (live only after version + publish). Two steps: without confirm only a preview " +
        "(name, type and what still references it, e.g. tags on a trigger), with confirm=true it is deleted.",
      annotations: DESTRUCTIVE,
      inputSchema: { ...gtmWs, entityType, entityId: z.string(), confirm },
    },
    tool(
      confirmed(gtmDeletePreview, backedUp("gtm_delete_entity", gtmSnapshotWorkspace, gtmDeleteEntity, (a) => num(a.entityId, "entityId"))),
    ),
  );

  server.registerTool(
    "gtm_sync_workspace",
    {
      title: "GTM: Update workspace (sync)",
      description:
        "Pulls changes published in the meantime (e.g. from another workspace or the GTM UI) into the workspace. " +
        "Needed when gtm_workspace_status or gtm_create_version reports conflicts or an outdated state. Then resolve conflicts with gtm_resolve_conflict.",
      annotations: WRITE,
      inputSchema: gtmWs,
    },
    tool(backedUp("gtm_sync_workspace", gtmSnapshotWorkspace, gtmSyncWorkspace)),
  );

  server.registerTool(
    "gtm_resolve_conflict",
    {
      title: "GTM: Resolve conflict",
      description:
        "Resolves a merge conflict after gtm_sync_workspace: keep='workspace' keeps your own change, keep='base' takes the newer " +
        "published state. type and id as in gtm_workspace_status / gtm_sync_workspace (e.g. type 'tag', id '42').",
      annotations: WRITE,
      inputSchema: {
        ...gtmWs,
        type: z.enum(Object.keys(CHANGE_ENTITIES)).describe("Entity type from the conflict, e.g. 'tag', 'trigger', 'variable'"),
        id: z.string().describe("ID from the conflict"),
        keep: z.enum(["workspace", "base"]),
      },
    },
    tool(backedUp("gtm_resolve_conflict", gtmSnapshotWorkspace, gtmResolveConflict)),
  );

  server.registerTool(
    "gtm_import_gallery_template",
    {
      title: "GTM: Import template from the community gallery",
      description:
        "Imports a tag or variable template from the GTM community gallery into the workspace (e.g. consent banners like Cookiebot, " +
        "usercentrics or vendor pixels). galleryOwner/galleryRepository = GitHub owner and repo of the template (shown on the gallery page at tagmanager.google.com/gallery). " +
        "acknowledgePermissions=true confirms the template's permissions (loading scripts, setting cookies …); review them first.",
      annotations: WRITE,
      inputSchema: {
        ...gtmWs,
        galleryOwner: z.string().describe("GitHub owner of the gallery template"),
        galleryRepository: z.string().describe("GitHub repository of the gallery template"),
        gallerySha: z.string().optional().describe("Specific version (commit SHA); default latest"),
        acknowledgePermissions: z.boolean().describe("Must be true"),
      },
    },
    tool(backedUp("gtm_import_gallery_template", gtmSnapshotWorkspace, gtmImportGalleryTemplate)),
  );

  server.registerTool(
    "gtm_enable_built_in_variables",
    {
      title: "GTM: Enable built-in variables",
      description: "Enables built-in variables in the workspace, e.g. ['clickUrl','clickText','formId','pageUrl'].",
      annotations: WRITE,
      inputSchema: { ...gtmWs, types: z.array(z.string()).min(1).describe("BuiltInVariable types (camelCase from the GTM API)") },
    },
    tool(backedUp("gtm_enable_built_in_variables", gtmSnapshotWorkspace, gtmEnableBuiltInVariables)),
  );

  server.registerTool(
    "gtm_create_version",
    {
      title: "GTM: Create version",
      description:
        "Creates a container version from the workspace (NOT live yet). Returns containerVersionId for gtm_publish_version; " +
          "compilerError=true means: the workspace has errors, do not publish anything.",
      annotations: WRITE,
      inputSchema: { ...gtmWs, name: z.string().describe("Version name"), notes: z.string().optional().describe("What was changed and why") },
    },
    tool(backedUp("gtm_create_version", gtmSnapshotWorkspace, gtmCreateVersion)),
  );

  server.registerTool(
    "gtm_publish_version",
    {
      title: "GTM: Publish version (LIVE)",
      description:
        "Publishes a container version — goes live on the live website immediately. Two steps: without confirm only a preview " +
          "(version, current live version, added/removed/changed tags, triggers, variables, rollback yes/no). " +
          "confirm=true only after explicit approval by a human. Rollback = publish an older version from gtm_list_versions.",
      annotations: DESTRUCTIVE,
      inputSchema: {
        accountId: z.string(),
        containerId: z.string(),
        containerVersionId: z.string().describe("From gtm_create_version or gtm_list_versions"),
        confirm,
      },
    },
    tool(
      confirmed(
        gtmPublishPreview,
        backedUp("gtm_publish_version", gtmSnapshotLive, gtmPublishVersion, (a) => num(a.containerVersionId, "containerVersionId")),
      ),
    ),
  );

  server.registerTool(
    "gtm_request",
    {
      title: "GTM API: free-form request",
      description:
        "Arbitrary call to the Tag Manager API v2 (www.googleapis.com/tagmanager/v2) for anything without its own tool — e.g. " +
          "GET 'accounts/1/containers/2/versions/5', POST 'accounts/1/containers/2/workspaces/3:sync', " +
          "POST 'accounts/1/containers/2/workspaces/3/templates'. Path relative to /tagmanager/v2. " +
          "Without confirm=true, DELETE only shows the current state of the resource and deletes nothing. Publishing only via gtm_publish_version.",
      annotations: DESTRUCTIVE,
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "DELETE"]),
        path: z.string().describe("Relative path incl. query, e.g. 'accounts/1/containers/2/workspaces'"),
        body: z.record(z.any()).optional().describe("JSON body for POST/PUT"),
        confirm: confirm.describe("DELETE only: without it a preview, with true it deletes"),
      },
    },
    tool((a) => {
      if (a.method === "GET") return gtmRequest(a);
      gtmGuard(a); // check the blocks before preview and backup
      gtmGuardPublish(a);
      const run = backedUp("gtm_request", (x, l) => gtmSnapshotForPath(x.path, l), gtmRequest);
      if (a.method !== "DELETE") return run(a);
      return confirmed((x) => deletePreview(GTM, x.path), run)(a);
    }),
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
