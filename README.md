# yourls

MCP connector for a self-hosted [YOURLS](https://github.com/YOURLS/YOURLS) server (1.10.6). It speaks the HTTP API over stdio and over stateless Streamable HTTP on localhost.

YOURLS is MIT software. This connector does not copy that code. It only calls `yourls-api.php` on the server you configure. It is not affiliated with YOURLS.

`yourls.routes.json` lists the 6 core API actions from YOURLS 1.10.6 `yourls-api.php`: `shorturl`, `expand`, `url-stats`, `stats`, `db-stats`, `version`. Plugin actions `delete`, `update`, and `edit` are recorded as exclusions because they are not in core 1.10.6. `scripts/gen-operations.mjs` writes `src/operations.ts` from that table. Do not edit `src/operations.ts` by hand.

`YOURLS_URL` is required. There is no default origin.

## Setup

```bash
npm install
npm run ci
npm start
npm run start:http
```

`npm start` speaks stdio. `npm run start:http` serves Streamable HTTP at `http://127.0.0.1:3000/mcp` and `GET /health`. HTTP mode has no authentication of its own. Keep it on localhost.

```json
{
  "mcpServers": {
    "yourls": {
      "command": "node",
      "args": ["/workspace/connectors/yourls/dist/index.js"],
      "env": {
        "YOURLS_URL": "http://127.0.0.1:8090",
        "YOURLS_SIGNATURE": "...",
        "YOURLS_ALLOW_WRITES": "false",
        "YOURLS_TOOLSETS": "meta,stats,links"
      }
    }
  }
}
```

You can set `YOURLS_USERNAME` and `YOURLS_PASSWORD` instead of `YOURLS_SIGNATURE`. The connector then POSTs those fields to `yourls-api.php`.

Docker (HTTP, no authentication, keep it on localhost):

```bash
docker build -t yourls .
docker run -p 127.0.0.1:3000:3000 \
  -e YOURLS_URL=http://127.0.0.1:8090 \
  -e YOURLS_SIGNATURE=... \
  yourls
```

Do not put secrets in the image.

Regenerate the registry after a route-table bump.

```bash
npm run gen:operations
```

`scripts/live-check.mjs` talks to a real server over stdio. It needs `YOURLS_URL` and either `YOURLS_SIGNATURE` or `YOURLS_USERNAME` plus `YOURLS_PASSWORD`. It unsets `DATABASE_URL`. It sets `YOURLS_TOOLSETS=all`. Gated writes run only when `YOURLS_ALLOW_WRITES=true`. It prints pass or fail lines only.

## Config

| Variable                | Meaning                                                                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `YOURLS_URL`            | Required. Origin, `http` or `https`, no userinfo, query, or hash. Example `http://127.0.0.1:8090`.                                                                                                                |
| `YOURLS_SIGNATURE`      | Signature token from Tools. Sent as the POST field `signature`. Redacted everywhere.                                                                                                                              |
| `YOURLS_SIGNATURE_HASH` | Optional `md5`, `sha256`, `sha384`, or `sha512`. Sends `timestamp` plus `hash(timestamp + token)`. YOURLS 1.10.6 accepts `sha256`, `sha384`, and `sha512` by default. `md5` needs a plugin that allows that algo. |
| `YOURLS_USERNAME`       | Account login. Set together with `YOURLS_PASSWORD` when no signature is set.                                                                                                                                      |
| `YOURLS_PASSWORD`       | Password for that login. Sent as a POST field. Redacted everywhere.                                                                                                                                               |
| `YOURLS_ALLOW_WRITES`   | Must be the literal `true` before a confirmed write is sent.                                                                                                                                                      |
| `YOURLS_TOOLSETS`       | Comma list of toolsets, or `all`. Default is the read-focused set below.                                                                                                                                          |
| `YOURLS_PER_MINUTE`     | Local request budget. Default 30. Cache hits do not spend it.                                                                                                                                                     |
| `YOURLS_TIMEOUT_MS`     | Upstream timeout. Default 20000.                                                                                                                                                                                  |
| `YOURLS_CACHE_TTL_SEC`  | Read cache TTL. Default 60. Writes clear the cache.                                                                                                                                                               |
| `YOURLS_CONTACT`        | Contact token in the User-Agent. Must not contain a secret.                                                                                                                                                       |
| `MCP_TRANSPORT`         | `stdio` or `http`. `--http` overrides.                                                                                                                                                                            |
| `PORT`                  | HTTP port. Default 3000.                                                                                                                                                                                          |

Invalid values are reported by field name and issue code. The rejected value is not included. Signatures, passwords, hashes, and authorization headers are redacted in logs, errors, tool results, thrown messages, and URLs.

Auth is a POST body field. The connector never puts credentials in the API URL. Every call sets `format=json`.

## Safety

Reads are `expand`, `url-stats`, `stats`, `db-stats`, and `version`. `shorturl` is a write. Plugin edit and delete are excluded from this connector.

A write needs `confirm: true` as a boolean and `YOURLS_ALLOW_WRITES=true`. The string `"true"` is rejected. Otherwise the tool returns a dry-run preview of method, path, and redacted form fields, and it sends nothing.

YOURLS auth failures are HTTP 403. The connector reports them as unauthorized. HTTP 404 is not found. HTTP 400, 409, and messages that contain "already exists" are invalid input. HTTP 429 includes Retry-After when present. Other failures are server, network, or timeout. Response bodies are capped at 1,000,000 bytes.

## Tools

Default `YOURLS_TOOLSETS` publishes 3 tools. `YOURLS_TOOLSETS=all` publishes the same 3 tools (6 operations, 5 reads and 1 write). Each tool takes `action` plus optional `params`, `query`, `body`, and `confirm`.

`action` `help` with optional `target` returns the fields for one action. Descriptions list action names only, so the tool list stays small.

| Toolset | Tool           | Operations | Default |
| ------- | -------------- | ---------- | ------- |
| meta    | `yourls_meta`  | 1          | yes     |
| stats   | `yourls_stats` | 2          | yes     |
| links   | `yourls_links` | 3          | yes     |

`yourls_meta` action `version` accepts `params.db=1` to include `db_version`. `yourls_stats` action `stats` accepts `filter` (`top`, `bottom`, `rand`, `last`), `limit`, and `start`. `yourls_links` actions are `expand`, `url_stats`, and `shorturl`.

## What this is not

This is not the YOURLS admin UI. It does not start YOURLS or MariaDB. It does not ship plugin actions such as delete, update, list-extended, or QR codes. Those need plugins that are not in YOURLS 1.10.6 core.

## Compared with kesslerio/yourls-mcp

[kesslerio/yourls-mcp](https://github.com/kesslerio/yourls-mcp) is a JavaScript stdio server (README says MIT, no LICENSE file in the repo, 0 stars when checked). It exposes 14 flat tools: `shorten_url`, `expand_url`, `url_stats`, `db_stats`, `create_custom_url`, `shorten_with_analytics`, plus plugin tools `url_analytics`, `contract_url`, `update_url`, `change_keyword`, `get_url_keyword`, `delete_url`, `list_urls`, and `generate_qr_code`. Signature auth is `md5(timestamp + token)`. Writes are not confirm-gated and have no dry-run. Core `version` is missing. Core `stats` with filter and limit is only an internal fallback. Plugin tools are always registered.

This connector covers the 6 core YOURLS 1.10.6 actions, including `version` with `db_version` and `stats` with `filter`, `limit`, and `start`. It POSTs to `yourls-api.php` with `format=json`. Auth is a raw signature token or username and password, with optional time-limited sha hashes. Writes need `confirm: true` and `YOURLS_ALLOW_WRITES=true`. Toolsets are scoped. Zod parses inputs. Failures are typed. A spec-coverage test pins the core action list. It does not ship plugin CRUD, UTM shortening, or QR generation. Those are what the rival has.

## Live check

PASS, 12 checks, failed=0, on 2 Nov 2026 against a real local YOURLS 1.10.6 (throwaway MariaDB 11.4.4, admin password auth plus a separate signature-auth session). Details in `LIVE-CHECK.md`.

## License

MIT. YOURLS itself is MIT. See `LICENSE`.
