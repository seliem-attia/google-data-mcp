# google-data-mcp

An MCP server for **Google Analytics 4** (Data API + Admin API) and **Google Tag Manager** (API v2) that can
**read and write** — built for people who let an AI assistant work on real tracking setups and want guard rails.

- **45 tools**: GA4 reports, realtime, funnels, metadata and compatibility checks, key events, custom
  definitions, data redaction, annotations, change history; GTM workspaces, tags/triggers/variables, versions,
  sync and merge conflicts, Community Template Gallery import, container snippet and lookup.
- **Automatic backups** before every write: GA4 has no configuration versioning, and GTM does not version
  unsaved workspace changes, so the server snapshots the affected state to local JSON first. If the backup
  fails, nothing is written.
- **GTM code validation** before saving: JavaScript in Custom HTML tags and Custom JavaScript variables is
  parsed as ES5 strict (what GTM's compiler accepts), and every `{{Variable}}` must exist. Errors come back with
  name, line and column instead of GTM's bare `compilerError: true`.
- **Preview before risky actions**: publishing a GTM version, deleting a GTM entity, and any `DELETE` through
  the generic API tools return a preview (diff against the live version, rollback flag, what still references the
  entity) and change nothing until called again with `confirm: true`.
- **Read-only mode** (`GOOGLE_DATA_MCP_READONLY=1`) hides every write tool and forces the read-only token.
- All tools carry MCP annotations (`readOnlyHint`, `destructiveHint`) so clients can ask before acting.

Runs locally over stdio (Claude Desktop, Claude Code, any MCP client). Node.js ≥ 20, three dependencies
(`@modelcontextprotocol/sdk`, `zod`, `acorn`).

## Tools

**Read**

| Tool | What it does |
|---|---|
| `google_token_info` | Active token (write / read-only) and its scopes; first check on a 403 |
| `ga4_list_properties` | All GA4 properties with account |
| `ga4_run_report` | Core report with dimension/metric filters and ordering |
| `ga4_realtime_report` | Last ~30 minutes |
| `ga4_run_funnel_report` | Funnel (Data API v1alpha): steps as `eventName` + optional `urlContains`, or a raw FunnelFilterExpression; optional breakdown |
| `ga4_get_metadata` | Dimensions and metrics available for the property, incl. custom ones; without a filter only apiNames |
| `ga4_check_compatibility` | Do these dimensions and metrics fit one report? `listAddable` lists what can still be added |
| `ga4_list_data_streams`, `ga4_list_key_events`, `ga4_list_custom_definitions` | Admin configuration |
| `ga4_get_data_redaction` | E-mail / URL query parameter redaction of web streams (v1alpha) |
| `ga4_list_annotations` | Annotations shown in GA4 reports |
| `ga4_change_history` | Who changed what and when, incl. changes made in the GA4 UI |
| `gtm_list_accounts` | Accounts and containers |
| `gtm_export_container` | Overview of the live version, or of an older one via `containerVersionId` |
| `gtm_list_versions` | Container versions, newest first, live version flagged |
| `gtm_list_workspaces`, `gtm_workspace_status`, `gtm_list_entities` | Workspaces, pending changes and conflicts, full entity JSON |
| `gtm_container_snippet` | Install snippet (head + noscript) |
| `gtm_lookup_container` | `GTM-XXXX`, `G-XXXX` or `AW-…` → accountId / containerId |
| `gtm_quick_preview` | Compiles the workspace without creating a version; on `compilerError` it looks for the cause itself |
| `gtm_validate_workspace` | Runs the code/variable validation over all tags, triggers and variables |

**Backup**: `ga4_export_config`, `gtm_export_workspace`, `gtm_export_version`, `backup_list`, `backup_read`

**Write – GA4**: `ga4_create_key_event`, `ga4_create_custom_dimension`, `ga4_create_custom_metric`,
`ga4_update_data_redaction`, `ga4_create_annotation`, `ga4_admin_request` (generic Admin API call for everything
else: archive, delete, data retention, Measurement Protocol secrets …)

**Write – GTM**: `gtm_create_workspace`, `gtm_save_entity` (create or replace a tag/trigger/variable/…, with
validation), `gtm_revert_entity`, `gtm_delete_entity`, `gtm_enable_built_in_variables`, `gtm_sync_workspace`,
`gtm_resolve_conflict` (`keep`: `workspace` or `base`), `gtm_import_gallery_template`, `gtm_create_version`,
`gtm_publish_version`, `gtm_request` (generic GTM API v2 call)

## Setup

### 1. Google Cloud project (once)

1. Create or pick a project in the [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **Google Analytics Data API**, **Google Analytics Admin API** and **Tag Manager API**.
3. *Google Auth Platform* → set up the consent screen. Add the scopes you need (see below). Set the
   publishing status to **In production**, otherwise refresh tokens expire after 7 days. An unverified app
   shows "Google hasn't verified this app" during consent → *Advanced* → *Continue*.
4. *Clients* → create an OAuth client of type **Desktop app**. Note client ID and secret.

### 2. Install and authorize

```bash
git clone https://github.com/seliem-attia/google-data-mcp.git
cd google-data-mcp
npm ci
mkdir -p ~/.config/google-data-mcp
cp .env.example ~/.config/google-data-mcp/.env   # fill in client ID and secret
npm run auth                 # read-only token
npm run auth -- --write      # optional: write token
npm run selftest             # read-only live check
```

`npm run auth` opens Google's consent page, catches the callback on `localhost:53682` and stores the refresh
token in the env file (mode 0600).

| Token | Scopes |
|---|---|
| `GOOGLE_OAUTH_REFRESH_TOKEN` | `analytics.readonly`, `tagmanager.readonly` |
| `GOOGLE_OAUTH_REFRESH_TOKEN_WRITE` | read-only scopes + `analytics.edit`, `tagmanager.edit.containers`, `tagmanager.edit.containerversions`, `tagmanager.publish` |

If the write token is present it is used for everything; otherwise write tools fail with a clear scope hint.
Deliberately **not** requested: deleting containers (`tagmanager.delete.containers`) and managing users
(`tagmanager.manage.*`). The Google account itself also needs the GA4 role *Editor* and GTM container
permission *Publish* for write tools.

Credentials are read from, in this order: process environment → file in `$GOOGLE_DATA_MCP_ENV` →
`~/.config/google-data-mcp/.env` → `.env` next to `index.mjs`.

### 3. Add to your MCP client

Claude Desktop (`claude_desktop_config.json`) or any client that starts stdio servers:

```json
{
  "mcpServers": {
    "google-data": {
      "command": "node",
      "args": ["/absolute/path/to/google-data-mcp/index.mjs"]
    }
  }
}
```

Claude Code:

```bash
claude mcp add google-data -- node /absolute/path/to/google-data-mcp/index.mjs
```

For analysis-only or unattended setups add `"env": { "GOOGLE_DATA_MCP_READONLY": "1" }`.

## Safety model

**Two-step actions (`confirm`).** Without `confirm: true` these only return a preview and write nothing (no
backup either):

| Tool | Preview |
|---|---|
| `gtm_publish_version` | target version, current live version, added/removed/changed tags, triggers, variables and templates, `rollback: true` for an older version |
| `gtm_delete_entity` | name, type and what still references it (tags firing on a trigger, `{{Variable}}` usage) |
| `ga4_admin_request` / `gtm_request` with `DELETE` | current state of the resource |

Publishing through `gtm_request` (`…:publish`) is blocked so the preview cannot be bypassed. In Claude Code you
can additionally force a prompt for the riskiest tools in `.claude/settings.json`:

```json
{ "permissions": { "ask": ["mcp__google-data__gtm_publish_version", "mcp__google-data__gtm_request", "mcp__google-data__ga4_admin_request"] } }
```

**Hard limits.** The generic request tools accept only relative API paths on a fixed host. Deleting whole
accounts, properties or containers is blocked. All IDs are checked to be digits before they go into a URL.

**Backups.** Every write tool first saves the affected state:

| Action | Saved before |
|---|---|
| GA4 write tools, `ga4_admin_request` (except GET) | full property configuration |
| GTM workspace tools (`save`, `revert`, `delete`, built-ins, `sync`, `resolve_conflict`, gallery import, `create_version`) | full workspace |
| `gtm_publish_version` | current live version |
| `gtm_request` (except GET) | workspace, otherwise live version (derived from the path) |

Location: `~/.config/google-data-mcp/backups/<ga4|gtm>/<propertyId | accountId-containerId>/<timestamp>_<label>.json`
(directories 0700, files 0600; override with `GOOGLE_DATA_MCP_BACKUP_DIR`). The GA4 snapshot contains property
settings, data streams incl. enhanced measurement and redaction, key events, custom dimensions/metrics, data
retention, Google Ads/Firebase links, attribution, Google Signals and annotations. Measurement Protocol secrets
are stored without their value. Restoring is intentionally manual: read a snapshot with `backup_read`, compare,
and rebuild with the write tools. For GTM, republishing an older version is the simpler rollback
(`gtm_list_versions` → `gtm_export_container` with `containerVersionId` → `gtm_publish_version`).
Backups are never deleted automatically.

**GTM validation** (`gtm-validate.mjs`): `<script>` blocks in Custom HTML tags (without `src` and without
foreign types like `ld+json`) and Custom JavaScript variables are parsed as ES5 strict — no `let`/`const`, arrow
functions or template literals, and no function declarations inside `try`/`if`/`for` blocks (checked separately,
because acorn accepts them in ES5). Custom JavaScript variables must be exactly one anonymous function. Every
`{{Variable}}` must exist as a variable or an enabled built-in. Only for a proven false positive pass
`skipValidation: true`.

**Other.** Rate limits (429/503) are retried with backoff (2, 4, 8, 16 s). Responses over 50,000 characters are
truncated with a hint (`GOOGLE_DATA_MCP_MAX_OUTPUT` to change). Data coming back from GA4/GTM (page titles, tag
names, HTML) is third-party content, not instructions.

## Development

```bash
npm test
```

Runs the server over stdio with a fake `fetch` (`test/mock-fetch.mjs`) and exercises the tools through a real
MCP client: preview vs. confirm, blocked paths, backups, conflict resolution, read-only mode. No Google account
needed. `npm run selftest` is the live, read-only check against your own account.

Notes:
- `ga4_run_funnel_report`, annotations and data redaction use Google's **v1alpha** APIs, which can change.
- The server speaks stdio. To host it remotely, run it behind a stdio-to-HTTP MCP bridge of your choice.

## License

MIT
