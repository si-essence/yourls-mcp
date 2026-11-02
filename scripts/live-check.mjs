#!/usr/bin/env node
/**
 * Live check against a real self-hosted YOURLS instance. Spawns dist/index.js
 * over stdio. Skips when YOURLS_URL is unset. Does not print secrets.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const phpBin = process.env["YOURLS_PHP"] ?? "/workspace/research/grocy-live/php";
const yourlsRoot = process.env["YOURLS_SRC"] ?? "/workspace/tools/yourls/YOURLS-1.10.6";
const adminPwFile = process.env["YOURLS_ADMIN_PW_FILE"] ?? "/workspace/tools/yourls/admin.pw";

function readAdminPassword() {
  const fromEnv = process.env["YOURLS_PASSWORD"] ?? "";
  if (fromEnv.trim().length > 0) return fromEnv;
  try {
    return readFileSync(adminPwFile, "utf8").trim();
  } catch {
    return "";
  }
}

const username = process.env["YOURLS_USERNAME"] ?? "admin";
const password = readAdminPassword();
const baseUrl = process.env["YOURLS_URL"] ?? "";

/** @type {string[]} */
const secrets = [];
if (password.length >= 8) secrets.push(password);

/**
 * @param {string} text
 */
function redact(text) {
  let out = String(text);
  for (const secret of secrets) {
    out = out.split(secret).join("[redacted]");
    out = out.split(encodeURIComponent(secret)).join("[redacted]");
  }
  out = out.replace(/(authorization:\s*(?:bearer|basic)\s+)\S+/gi, "Authorization: [redacted]");
  out = out.replace(
    /"(api_key|token|password|secret|authorization|signature|hash)"\s*:\s*"[^"]*"/gi,
    '"$1":"[redacted]"',
  );
  return out;
}

/**
 * @param {string} text
 */
function clip(text) {
  let shortened = redact(text).replace(/\s+/g, " ").trim();
  if (shortened.length > 180) shortened = `${shortened.slice(0, 177)}...`;
  return shortened;
}

const writeLine = console.log.bind(console);
const writeError = console.error.bind(console);
console.log = (line) => writeLine(redact(String(line)));
console.error = (line) => writeError(redact(String(line)));

let failed = 0;
let passed = 0;
/** @type {string[]} */
const rows = [];

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} detail
 */
function record(name, ok, detail) {
  if (ok) passed += 1;
  else failed += 1;
  rows.push(`${ok ? "PASS" : "FAIL"}  ${name}  ${clip(detail)}`);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {import("@modelcontextprotocol/sdk/client/index.js").Client} client
 * @param {string} name
 * @param {Record<string, unknown>} args
 */
async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const block = Array.isArray(result.content) ? result.content[0] : undefined;
  const text = block && typeof block === "object" && "text" in block ? String(block.text) : "";
  for (const secret of secrets) {
    if (secret.length >= 8 && text.includes(secret)) {
      throw new Error("secret leaked into tool output");
    }
  }
  /** @type {Record<string, unknown> | null} */
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { isError: result.isError === true, text, json };
}

/**
 * Compute YOURLS_SIGNATURE for a user without printing it.
 * Uses the YOURLS 1.10 formula: substr(hash_hmac(sha256, "api:"+user, cookiekey), 0, 32).
 * @param {string} user
 * @returns {string | undefined}
 */
function computeSignature(user) {
  const script = `<?php
chdir(${JSON.stringify(yourlsRoot)});
require "user/config.php";
$algo = "sha256";
$sig = substr(hash_hmac($algo, "api:" . ${JSON.stringify(user)}, YOURLS_COOKIEKEY), 0, 32);
fwrite(STDOUT, $sig);
`;
  const result = spawnSync(phpBin, ["-d", "display_errors=0"], {
    input: script,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status !== 0) return undefined;
  const sig = (result.stdout ?? "").trim();
  if (sig.length < 8) return undefined;
  return sig;
}

/**
 * @param {Record<string, string | undefined>} extra
 */
function childEnv(extra) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "DATABASE_URL") continue;
    if (key === "YOURLS_USERNAME" || key === "YOURLS_PASSWORD" || key === "YOURLS_SIGNATURE") {
      continue;
    }
    env[key] = value;
  }
  env["YOURLS_URL"] = baseUrl;
  env["YOURLS_ALLOW_WRITES"] = "true";
  env["YOURLS_TOOLSETS"] = "all";
  env["YOURLS_CACHE_TTL_SEC"] = "0";
  env["YOURLS_PER_MINUTE"] = "120";
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * @param {Record<string, string | undefined>} extra
 * @param {(client: import("@modelcontextprotocol/sdk/client/index.js").Client) => Promise<void>} run
 */
async function withServer(extra, run) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: root,
    env: childEnv(extra),
    stderr: "pipe",
  });
  const client = new Client({ name: "live-check", version: "0" });
  await client.connect(transport);
  try {
    await run(client);
  } finally {
    await client.close();
  }
}

async function main() {
  if (baseUrl.trim().length === 0) {
    writeLine("SKIP  live-check  YOURLS_URL is unset.");
    return;
  }
  if (username.trim().length === 0 || password.trim().length === 0) {
    writeLine("SKIP  live-check  YOURLS_USERNAME plus YOURLS_PASSWORD required.");
    return;
  }

  const stamp = Date.now().toString(36);
  const keyword = `mcp${stamp}`.replace(/[^a-z0-9]/g, "").slice(0, 20) || `mcp${stamp}`;
  const longUrl = `https://example.com/mcp-live-${stamp}`;

  await withServer({ YOURLS_USERNAME: username, YOURLS_PASSWORD: password }, async (client) => {
    const listed = await client.listTools();
    record("list_tools", listed.tools.length >= 3, `${listed.tools.length} tools`);

    const version = await call(client, "yourls_meta", {
      action: "version",
      params: { db: 1 },
    });
    const versionOk =
      !version.isError &&
      isRecord(version.json) &&
      (version.json["version"] === "1.10.6" ||
        (isRecord(version.json["result"]) && version.json["result"]["version"] === "1.10.6"));
    record("yourls_meta version", versionOk, version.text);

    const dbStats = await call(client, "yourls_stats", { action: "db_stats" });
    record("yourls_stats db_stats", !dbStats.isError, dbStats.text);

    const preview = await call(client, "yourls_links", {
      action: "shorturl",
      params: { url: longUrl, keyword, title: "mcp-live" },
    });
    record(
      "yourls_links shorturl preview",
      preview.json?.["executed"] === false && preview.json?.["dry_run"] === true,
      preview.text,
    );

    const created = await call(client, "yourls_links", {
      action: "shorturl",
      params: { url: longUrl, keyword, title: "mcp-live" },
      confirm: true,
    });
    const createdOk =
      !created.isError &&
      created.json?.["executed"] === true &&
      /shorturl|success/i.test(created.text);
    record("yourls_links shorturl confirm", createdOk, created.text);

    const duplicate = await call(client, "yourls_links", {
      action: "shorturl",
      params: { url: `https://example.com/other-${stamp}`, keyword, title: "dup" },
      confirm: true,
    });
    record(
      "yourls_links shorturl duplicate keyword",
      duplicate.isError && /\[input\]/.test(duplicate.text),
      duplicate.text,
    );

    const expanded = await call(client, "yourls_links", {
      action: "expand",
      params: { shorturl: keyword },
    });
    record("yourls_links expand", !expanded.isError, expanded.text);

    const urlStats = await call(client, "yourls_links", {
      action: "url_stats",
      params: { shorturl: keyword },
    });
    record("yourls_links url_stats", !urlStats.isError, urlStats.text);

    const stats = await call(client, "yourls_stats", {
      action: "stats",
      params: { filter: "last", limit: 10, start: 0 },
    });
    record("yourls_stats stats", !stats.isError, stats.text);

    const missing = await call(client, "yourls_links", {
      action: "expand",
      params: { shorturl: `missing${stamp}` },
    });
    record(
      "yourls_links expand unknown keyword",
      missing.isError && /\[not-found\]/.test(missing.text),
      missing.text,
    );
  });

  await withServer(
    { YOURLS_USERNAME: username, YOURLS_PASSWORD: "definitely-wrong-password-xx" },
    async (client) => {
      const bad = await call(client, "yourls_meta", { action: "version" });
      record("bad password auth", bad.isError && /\[unauthorized\]/.test(bad.text), bad.text);
    },
  );

  const signature = computeSignature(username);
  if (signature === undefined) {
    record("signature auth", false, "could not compute YOURLS_SIGNATURE from PHP");
  } else {
    if (signature.length >= 8) secrets.push(signature);
    await withServer(
      {
        YOURLS_SIGNATURE: signature,
        YOURLS_USERNAME: undefined,
        YOURLS_PASSWORD: undefined,
      },
      async (client) => {
        const version = await call(client, "yourls_meta", {
          action: "version",
          params: { db: 1 },
        });
        record("signature auth version", !version.isError, version.text);
      },
    );
  }

  for (const row of rows) writeLine(row);
  writeLine(`RESULT  passed=${passed} failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

await main();
