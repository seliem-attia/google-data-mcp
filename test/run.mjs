// Integration test: starts the server over stdio with a fake fetch (test/mock-fetch.mjs) and calls the tools
// through a real MCP client. No Google account or network needed.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, "..");
const tmp = mkdtempSync(resolve(tmpdir(), "google-data-mcp-test-"));
const LOG = resolve(tmp, "requests.log");
writeFileSync(LOG, "");
const baseEnv = { PATH: process.env.PATH, HOME: tmp };
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", resolve(here, "mock-fetch.mjs"), resolve(serverDir, "index.mjs")],
  env: {
    ...baseEnv,
    MOCK_LOG: LOG,
    GOOGLE_OAUTH_CLIENT_ID: "id",
    GOOGLE_OAUTH_CLIENT_SECRET: "secret",
    GOOGLE_OAUTH_REFRESH_TOKEN_WRITE: "rt",
    GOOGLE_DATA_MCP_BACKUP_DIR: resolve(tmp, "backups"),
  },
});
const client = new Client({ name: "test", version: "0" });
await client.connect(transport);

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failures++;
};
const reqs = () => readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean);
async function call(name, args) {
  const before = reqs().length;
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { r, data, text, calls: reqs().slice(before) };
}

const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
console.log(`Tools: ${names.length}`);
for (const n of ["ga4_get_metadata", "ga4_check_compatibility", "ga4_run_funnel_report", "ga4_list_annotations", "ga4_create_annotation",
  "gtm_list_versions", "gtm_container_snippet", "gtm_lookup_container", "gtm_sync_workspace", "gtm_resolve_conflict", "gtm_import_gallery_template"]) {
  check(`registered: ${n}`, names.includes(n));
}
const ann = (n) => tools.find((t) => t.name === n)?.annotations || {};
check("READ annotation on ga4_get_metadata", ann("ga4_get_metadata").readOnlyHint === true);
check("DESTRUCTIVE annotation on gtm_publish_version", ann("gtm_publish_version").destructiveHint === true);
check("all tools have annotations", tools.every((t) => t.annotations && "readOnlyHint" in t.annotations), tools.filter((t) => !t.annotations).map((t) => t.name).join(","));

const W = { accountId: "1", containerId: "2", workspaceId: "5" };

let x = await call("ga4_get_metadata", { property: "1" });
check("metadata without filter → apiNames only", Array.isArray(x.data.dimensions) && typeof x.data.dimensions[0] === "string", JSON.stringify(x.data.counts));
x = await call("ga4_get_metadata", { property: "1", search: "landingPagePlus" });
check("metadata search matches deprecatedApiName", x.data.dimensions?.[0]?.apiName === "landingPage");
x = await call("ga4_get_metadata", { property: "1", customOnly: true, kind: "dimensions" });
check("metadata customOnly", x.data.counts?.dimensions === 1 && x.data.dimensions[0].custom === true && x.data.counts.metrics === 0);

x = await call("ga4_check_compatibility", { property: "1", dimensions: ["pagePath", "landingPage"], metrics: ["sessions"], listAddable: true });
check("compat: false because of landingPage", x.data.compatible === false && x.data.requested.dimensions[1].compatibility === "INCOMPATIBLE");
check("compat: addable has country, not pagePath", x.data.addable.dimensions.includes("country") && !x.data.addable.dimensions.includes("pagePath"));
x = await call("ga4_check_compatibility", { property: "1" });
check("compat: no fields → error", x.r.isError === true);

x = await call("ga4_run_funnel_report", {
  property: "1",
  steps: [{ name: "LP", eventName: "page_view", urlContains: "/wp" }, { name: "Lead", eventName: "generate_lead" }],
  breakdownDimension: "deviceCategory",
});
check("funnel: rows formatted", x.data.rows?.[0]?.funnelStepName === "1. LP" && x.data.rows[0].activeUsers === "100");
check("funnel: v1alpha endpoint", x.calls.some((c) => c.startsWith("POST /v1alpha/properties/1:runFunnelReport")));
x = await call("ga4_run_funnel_report", { property: "1", steps: [{ name: "kaputt" }] });
check("funnel: step without eventName → error", x.r.isError === true && /eventName/.test(x.text));

x = await call("ga4_list_annotations", { property: "1" });
check("annotations: sorted, dates formatted", x.data.annotations?.[0]?.from === "2026-10-01" && x.data.annotations[1].date === "2026-01-05");
x = await call("ga4_create_annotation", { property: "1", title: "Relaunch", date: "2026-11-06" });
check("create annotation: backup + POST", !!x.data.backup && x.calls.some((c) => c.startsWith("POST /v1alpha/properties/1/reportingDataAnnotations")));
x = await call("ga4_create_annotation", { property: "1", title: "x", date: "06.11.2026" });
check("annotation: bad date → error, no POST", x.r.isError === true && !x.calls.some((c) => c.startsWith("POST")));

x = await call("gtm_list_versions", { accountId: "1", containerId: "2" });
check("versions: newest first + live", x.data.versions?.[0]?.containerVersionId === "30" && x.data.versions[0].live === true && x.data.liveVersionId === "30");

x = await call("gtm_export_container", { accountId: "1", containerId: "2", containerVersionId: "29" });
check("export_container with version 29", x.data.versionId === "29");

// Publish: the preview must not publish
x = await call("gtm_publish_version", { accountId: "1", containerId: "2", containerVersionId: "29" });
check("publish without confirm: no :publish call", !x.calls.some((c) => c.includes(":publish")) && !!x.data.preview);
check("publish preview: rollback + diff", x.data.preview?.rollback === true && JSON.stringify(x.data.preview.changesVsLive.tag) === JSON.stringify({ added: ["B"], removed: ["C"], changed: ["A"] }), JSON.stringify(x.data.preview?.changesVsLive));
check("publish preview: no backup", !existsSync(resolve(tmp, "backups/gtm/1-2")) || !x.calls.some((c) => c.includes("/workspaces")));
x = await call("gtm_publish_version", { accountId: "1", containerId: "2", containerVersionId: "29", confirm: true });
check("publish with confirm: :publish + backup", x.calls.some((c) => c.startsWith("POST") && c.includes("/versions/29:publish")) && !!x.data.backup);

// Delete: preview with references
x = await call("gtm_delete_entity", { ...W, entityType: "triggers", entityId: "12" });
check("delete without confirm: no DELETE", !x.calls.some((c) => c.startsWith("DELETE")));
check("delete preview: tag A references trigger", x.data.preview?.usedBy?.[0]?.name === "A" && !!x.data.preview.warning);
x = await call("gtm_delete_entity", { ...W, entityType: "triggers", entityId: "12", confirm: true });
check("delete with confirm: DELETE sent", x.calls.some((c) => c.startsWith("DELETE") && c.endsWith("/triggers/12")));

// Generic requests
x = await call("gtm_request", { method: "POST", path: "accounts/1/containers/2/versions/29:publish" });
check("gtm_request :publish blocked", x.r.isError === true && !x.calls.some((c) => c.includes(":publish")));
x = await call("gtm_request", { method: "DELETE", path: "accounts/1/containers/2/workspaces/5/tags/2" });
check("gtm_request DELETE without confirm: no DELETE", !x.calls.some((c) => c.startsWith("DELETE")) && !!x.data.preview);
x = await call("gtm_request", { method: "DELETE", path: "accounts/1/containers/2" });
check("gtm_request DELETE container still blocked", x.r.isError === true && /Blocked/.test(x.text));
x = await call("ga4_admin_request", { method: "DELETE", path: "properties/1/keyEvents/5" });
check("ga4 DELETE without confirm: preview with current state", !x.calls.some((c) => c.startsWith("DELETE")) && x.data.preview?.currentState?.eventName === "generate_lead");
x = await call("ga4_admin_request", { method: "DELETE", path: "properties/1/keyEvents/5", confirm: true });
check("ga4 DELETE with confirm: deleted + backup", x.calls.some((c) => c.startsWith("DELETE /v1beta/properties/1/keyEvents/5")) && !!x.data.backup);
x = await call("ga4_admin_request", { method: "PATCH", path: "properties/1/dataRetentionSettings?updateMask=eventDataRetention", body: { eventDataRetention: "FOURTEEN_MONTHS" } });
check("ga4 PATCH still needs no confirm", x.calls.some((c) => c.startsWith("PATCH")));

// Sync + conflict
x = await call("gtm_sync_workspace", W);
check("sync: conflict detected", x.data.result?.mergeConflict === true && x.data.result.conflicts[0].workspace.id === "1");
x = await call("gtm_resolve_conflict", { ...W, type: "tag", id: "1", keep: "base" });
const rc = x.calls.find((c) => c.includes(":resolve_conflict"));
check("resolve: uses workspace fingerprint", !!rc && rc.includes("fingerprint=ws-fp"), rc);
x = await call("gtm_resolve_conflict", { ...W, type: "tag", id: "999", keep: "base" });
check("resolve: unknown conflict → error", x.r.isError === true);

// Gallery
x = await call("gtm_import_gallery_template", { ...W, galleryOwner: "own", galleryRepository: "repo", acknowledgePermissions: false });
check("gallery without acknowledge → error, no import", x.r.isError === true && !x.calls.some((c) => c.includes("import_from_gallery")));
x = await call("gtm_import_gallery_template", { ...W, galleryOwner: "own", galleryRepository: "repo", acknowledgePermissions: true });
check("gallery import: compact", x.data.result?.templateId === "77" && !("templateData" in x.data.result));
x = await call("gtm_import_gallery_template", { ...W, galleryOwner: "o/../x", galleryRepository: "repo", acknowledgePermissions: true });
check("gallery: invalid owner → error", x.r.isError === true);

// Snippet + Lookup
x = await call("gtm_container_snippet", { accountId: "1", containerId: "2" });
check("snippet + noscript", x.data.snippet === "<script>gtm</script>" && x.data.noscript.includes("ns.html?id=GTM-TEST"));
x = await call("gtm_lookup_container", { id: "GTM-ABC123" });
check("lookup per tagId", x.data.containerId === "2" && x.calls.some((c) => c.includes("containers:lookup?tagId=GTM-ABC123")));
x = await call("gtm_lookup_container", { id: "AW-123" });
check("lookup per destinationId", x.calls.some((c) => c.includes("destinationId=AW-123")));
x = await call("gtm_lookup_container", { id: "../x" });
check("lookup: invalid id → error", x.r.isError === true);

await client.close();

// Read-only mode: no write tool may be visible.
const ro = new Client({ name: "test-ro", version: "0" });
await ro.connect(
  new StdioClientTransport({ command: process.execPath, args: [resolve(serverDir, "index.mjs")], env: { ...baseEnv, GOOGLE_DATA_MCP_READONLY: "1" } }),
);
const roTools = (await ro.listTools()).tools;
const visibleWrites = roTools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name);
check(`read-only mode hides all write tools (${roTools.length} tools)`, visibleWrites.length === 0, visibleWrites.join(","));
await ro.close();

console.log(failures ? `\n${failures} FAILED` : "\nALL TESTS PASSED");
process.exit(failures ? 1 : 0);
