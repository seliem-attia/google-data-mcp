// Preload: replaces fetch with fake Google APIs and logs every call (method + URL) to $MOCK_LOG.
import { appendFileSync } from "node:fs";

const LOG = process.env.MOCK_LOG;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const tag = (id, name, fp, trig = []) => ({ tagId: id, name, type: "html", fingerprint: fp, firingTriggerId: trig });
const v29 = { containerVersionId: "29", name: "ChatGPT Tracking", container: { publicId: "GTM-TEST" }, tag: [tag("1", "A", "1"), tag("2", "B", "1")], trigger: [], variable: [] };
const v30 = { containerVersionId: "30", name: "WhatsApp", container: { publicId: "GTM-TEST" }, tag: [tag("1", "A", "2"), tag("3", "C", "1")], trigger: [], variable: [] };

function route(method, u) {
  const p = u.pathname + (u.search || "");
  if (u.hostname === "oauth2.googleapis.com" && u.pathname === "/token") return json({ access_token: "tok", expires_in: 3600 });
  // GA4 Data API
  if (p.endsWith("/metadata")) {
    return json({
      dimensions: [
        { apiName: "pagePath", uiName: "Page path", category: "Page / screen", description: "Pfad" },
        { apiName: "customEvent:form_id", uiName: "Form ID", category: "Custom", customDefinition: true },
        { apiName: "landingPage", uiName: "Landing page", category: "Page / screen", deprecatedApiNames: ["landingPagePlusQueryString"] },
      ],
      metrics: [{ apiName: "sessions", uiName: "Sessions", category: "Session", type: "TYPE_INTEGER" }],
    });
  }
  if (p.endsWith(":checkCompatibility")) {
    return json({
      dimensionCompatibilities: [
        { dimensionMetadata: { apiName: "pagePath" }, compatibility: "COMPATIBLE" },
        { dimensionMetadata: { apiName: "landingPage" }, compatibility: "INCOMPATIBLE" },
        { dimensionMetadata: { apiName: "country" }, compatibility: "COMPATIBLE" },
      ],
      metricCompatibilities: [{ metricMetadata: { apiName: "sessions" }, compatibility: "COMPATIBLE" }],
    });
  }
  if (p.includes("/v1alpha/") && p.endsWith(":runFunnelReport")) {
    return json({
      funnelTable: {
        dimensionHeaders: [{ name: "funnelStepName" }],
        metricHeaders: [{ name: "activeUsers" }, { name: "funnelStepCompletionRate" }],
        rows: [
          { dimensionValues: [{ value: "1. LP" }], metricValues: [{ value: "100" }, { value: "0.4" }] },
          { dimensionValues: [{ value: "2. Lead" }], metricValues: [{ value: "40" }, { value: "0" }] },
        ],
      },
    });
  }
  // GA4 Admin
  if (p.includes("/reportingDataAnnotations")) {
    if (method === "POST") return json({ name: "properties/1/reportingDataAnnotations/9", title: "Relaunch" });
    return json({
      reportingDataAnnotations: [
        { name: "properties/1/reportingDataAnnotations/7", title: "Alt", color: "BLUE", annotationDate: { year: 2026, month: 1, day: 5 } },
        { name: "properties/1/reportingDataAnnotations/8", title: "Neu", color: "RED", annotationDateRange: { startDate: { year: 2026, month: 10, day: 1 }, endDate: { year: 2026, month: 10, day: 3 } } },
      ],
    });
  }
  if (method === "GET" && /\/properties\/\d+$/.test(u.pathname)) return json({ name: "properties/1", parent: "accounts/1", displayName: "Test" });
  if (method === "GET" && /keyEvents\/\d+$/.test(u.pathname)) return json({ name: "properties/1/keyEvents/5", eventName: "generate_lead" });
  // GTM
  if (p.includes("/version_headers")) {
    return json({ containerVersionHeader: [{ containerVersionId: "29", name: "ChatGPT Tracking", numTags: "55" }, { containerVersionId: "30", name: "WhatsApp", numTags: "56" }] });
  }
  if (p.endsWith("/versions:live?fields=containerVersionId")) return json({ containerVersionId: "30" });
  if (p.endsWith("/versions:live")) return json(v30);
  if (u.pathname.endsWith("/versions/29") && method === "GET") return json(v29);
  if (u.pathname.endsWith("/versions/30") && method === "GET") return json(v30);
  if (p.endsWith(":snippet")) return json({ snippet: "<script>gtm</script>" });
  if (u.pathname.endsWith("/containers/2") && u.search.includes("fields=")) return json({ publicId: "GTM-TEST", name: "Web", usageContext: ["web"] });
  if (u.pathname.endsWith("/accounts/containers:lookup")) {
    return json({ accountId: "1", containerId: "2", name: "Web", publicId: u.searchParams.get("tagId") || "?", usageContext: ["web"], tagIds: ["GTM-TEST"], fingerprint: "x" });
  }
  if (u.pathname.endsWith("/workspaces/5:sync")) {
    return json({
      syncStatus: { mergeConflict: true },
      mergeConflict: [{ entityInWorkspace: { tag: { tagId: "1", name: "A", fingerprint: "ws-fp" } }, entityInBaseVersion: { tag: { tagId: "1", name: "A", fingerprint: "base-fp" } } }],
    });
  }
  if (u.pathname.endsWith("/workspaces/5/status")) {
    return json({ mergeConflict: [{ entityInWorkspace: { tag: { tagId: "1", name: "A", fingerprint: "ws-fp" } }, entityInBaseVersion: { tag: { tagId: "1", name: "A", type: "html", fingerprint: "base-fp" } } }] });
  }
  if (u.pathname.endsWith(":resolve_conflict")) return json({});
  if (u.pathname.endsWith("/templates:import_from_gallery")) return json({ templateId: "77", name: "Cookie Banner", galleryReference: { owner: "o", repository: "r" }, templateData: "x".repeat(5000) });
  if (u.pathname.endsWith("/triggers/12") && method === "GET") return json({ triggerId: "12", name: "Klick WhatsApp", type: "click" });
  if (u.pathname.endsWith("/workspaces/5/tags")) return json({ tag: [tag("1", "A", "1", ["12"]), tag("2", "B", "1", ["99"])] });
  if (u.pathname.endsWith("/workspaces/5/triggers")) return json({ trigger: [{ triggerId: "12", name: "Klick WhatsApp" }] });
  if (u.pathname.endsWith("/workspaces/5/variables")) return json({ variable: [] });
  if (method === "DELETE" || u.pathname.endsWith(":publish")) return json({ containerVersion: { containerVersionId: "29", name: "ChatGPT Tracking" } });
  return json({}); // default for backup collection calls
}

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const method = (init.method || "GET").toUpperCase();
  if (LOG) appendFileSync(LOG, `${method} ${u.pathname}${u.search}\n`);
  return route(method, u);
};
