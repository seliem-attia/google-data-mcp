#!/usr/bin/env node
// One-time refresh-token capture for google-data-mcp.
//
// Reads GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET from the environment or from the env file,
// opens Google's OAuth consent (offline access), catches the code on
// http://localhost:53682/oauth2callback, exchanges it for tokens and writes the refresh token back
// into the env file (mode 0600). The other token in the file is kept.
//
// Usage:
//   npm run auth               → GOOGLE_OAUTH_REFRESH_TOKEN        (read-only)
//   npm run auth -- --write    → GOOGLE_OAUTH_REFRESH_TOKEN_WRITE  (GA4 + GTM write, publish)
//   npm run auth -- --env ./my.env
// Env file: --env <path>, else $GOOGLE_DATA_MCP_ENV, else ~/.config/google-data-mcp/.env
//
// Requirement: set the OAuth consent screen to "In production", otherwise Google expires the
// refresh token after 7 days.

import { createServer } from "node:http";
import { readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const argv = process.argv.slice(2);
const envFlag = argv.indexOf("--env");
const ENV_PATH = resolve(
  envFlag >= 0 && argv[envFlag + 1]
    ? argv[envFlag + 1]
    : process.env.GOOGLE_DATA_MCP_ENV || resolve(homedir(), ".config/google-data-mcp/.env"),
);

const PORT = 53682;
const REDIRECT = `http://localhost:${PORT}/oauth2callback`;
// Read-only token: Analytics and Tag Manager, read-only.
const READ_SCOPES = ["analytics.readonly", "tagmanager.readonly"];
// Write token: additionally GA4 Admin edit, GTM workspace edit, create and publish versions.
// Deliberately NOT requested: deleting containers, managing users/accounts.
const WRITE_SCOPES = [...READ_SCOPES, "analytics.edit", "tagmanager.edit.containers", "tagmanager.edit.containerversions", "tagmanager.publish"];
const WRITE = argv.includes("--write");
const TOKEN_KEY = WRITE ? "GOOGLE_OAUTH_REFRESH_TOKEN_WRITE" : "GOOGLE_OAUTH_REFRESH_TOKEN";
const SCOPE = (WRITE ? WRITE_SCOPES : READ_SCOPES).map((s) => `https://www.googleapis.com/auth/${s}`).join(" ");

function parseEnv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = parseEnv(ENV_PATH);
const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || env.GOOGLE_OAUTH_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(`ERROR: GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET missing (environment or ${ENV_PATH}).`);
  process.exit(1);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent", // forces a fresh refresh token, also on re-runs
  }).toString();

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const page = (res, status, html) => {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
};
const finish = (code) => setTimeout(() => process.exit(code), 100);

const server = createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname !== "/oauth2callback") return page(res, 404, "");

  const err = u.searchParams.get("error");
  if (err) {
    page(res, 200, `<h2>Error: ${escapeHtml(err)}</h2><p>Close this window and return to the terminal.</p>`);
    console.error("OAuth error:", err);
    server.close();
    return finish(1);
  }
  const code = u.searchParams.get("code");
  if (!code) return page(res, 400, "missing code");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT, grant_type: "authorization_code" }),
  });
  const tok = await tokenRes.json().catch(() => ({}));
  if (!tok.refresh_token) {
    page(res, 200, "<h2>No refresh_token received.</h2><p>Usually the consent screen is not in production. Details in the terminal.</p>");
    console.error("Response without refresh_token:", JSON.stringify({ ...tok, access_token: tok.access_token ? "[hidden]" : undefined }, null, 2));
    server.close();
    return finish(1);
  }

  // Rewrite the file cleanly (no duplicates on re-runs), mode 0600. The other refresh token is kept.
  const next = { ...env, GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET, [TOKEN_KEY]: tok.refresh_token };
  const keys = ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REFRESH_TOKEN", "GOOGLE_OAUTH_REFRESH_TOKEN_WRITE"];
  const rest = Object.keys(next).filter((k) => !keys.includes(k));
  mkdirSync(dirname(ENV_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(ENV_PATH, [...keys, ...rest].filter((k) => next[k]).map((k) => `${k}=${next[k]}`).join("\n") + "\n", { mode: 0o600 });
  chmodSync(ENV_PATH, 0o600); // mode only applies on creation; tighten an existing file too

  page(res, 200, "<h2>Done.</h2><p>Refresh token saved. Close this window and return to the terminal.</p>");
  console.log(`\nSaved ${TOKEN_KEY} to ${ENV_PATH}`);
  console.log(`Scopes: ${tok.scope}`);
  server.close();
  finish(0);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\nMode: ${WRITE ? "WRITE (GA4/GTM edit + publish)" : "read-only"} → ${TOKEN_KEY}`);
  console.log("Open this link in your browser and sign in with the Google account that has GA4/GTM access:\n");
  console.log(authUrl + "\n");
  // Try to open the browser; no shell involved.
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    spawn(opener, [authUrl], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    /* no browser available: the link above is enough */
  }
});
