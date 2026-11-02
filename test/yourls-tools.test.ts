import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it } from "vitest";
import { OPERATIONS, toolIsWrite, toolNames, type Operation } from "../src/operations.js";
import { decideWrite, WRITES_DISABLED } from "../src/write-gate.js";
import { jsonFetch, jsonResponse, runtimeFor, TOKEN, type CapturedRequest } from "./harness.js";
import { connectServer } from "./mcp.js";
import { readToolText } from "./result.js";

const TOOL_NAMES = toolNames();
const WRITE_OPS = OPERATIONS.filter((operation) => operation.write);

function leakyBody(): Record<string, unknown> {
  return {
    version: "1.10.6",
    signature: TOKEN,
    password: "hunter2-secret-value",
    hash: "deadbeefdeadbeefdeadbeefdeadbeef",
    stack: "at /var/www/yourls/yourls-api.php:10",
    message: `hello ${TOKEN}`,
    statusCode: "200",
  };
}

function argsFor(operation: Operation): Record<string, unknown> {
  const args: Record<string, unknown> = { action: operation.action };
  if (Object.keys(operation.sampleParams).length > 0) args["params"] = operation.sampleParams;
  return args;
}

async function withClient(
  fetchImpl: typeof fetch,
  extra: NodeJS.ProcessEnv,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const runtime = runtimeFor(fetchImpl, extra);
  const connected = await connectServer(runtime);
  try {
    await run(connected.client);
  } finally {
    await connected.close();
  }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean; json: Record<string, unknown> | null }> {
  const result = readToolText(await client.callTool({ name, arguments: args }));
  expect(result.text).not.toContain(TOKEN);
  if (result.isError) return { ...result, json: null };
  return { ...result, json: JSON.parse(result.text) as Record<string, unknown> };
}

describe("yourls tools", () => {
  it("publishes every tool with a compact description and confirm on writes", async () => {
    const { fetchImpl } = jsonFetch(() => jsonResponse(leakyBody()));
    await withClient(fetchImpl, {}, async (client) => {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      expect(names).toEqual(TOOL_NAMES);
      for (const tool of listed.tools) {
        const description = tool.description ?? "";
        expect(description).toContain("action help");
        expect(description.length).toBeGreaterThan(40);
        const schema = JSON.stringify(tool.inputSchema);
        expect(schema).toContain("help");
        if (toolIsWrite(tool.name)) expect(schema).toContain("confirm");
        else expect(schema).not.toContain("confirm");
      }
    });
  });

  it("scopes the published set to YOURLS_TOOLSETS", async () => {
    const { fetchImpl } = jsonFetch(() => jsonResponse({ ok: true }));
    await withClient(fetchImpl, { YOURLS_TOOLSETS: "meta,stats" }, async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["yourls_meta", "yourls_stats"]);
    });
    await withClient(fetchImpl, { YOURLS_TOOLSETS: undefined }, async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "yourls_links",
        "yourls_meta",
        "yourls_stats",
      ]);
    });
  });

  it("describes one action without calling upstream", async () => {
    const { fetchImpl, calls } = jsonFetch(() => jsonResponse(leakyBody()));
    await withClient(fetchImpl, {}, async (client) => {
      const described = await call(client, "yourls_links", {
        action: "help",
        target: "shorturl",
      });
      expect(described.isError).toBe(false);
      expect(described.json).toMatchObject({
        action: "shorturl",
        yourlsAction: "shorturl",
        method: "POST",
        path: "yourls-api.php",
        write: true,
      });
      expect(calls).toHaveLength(0);
    });
  });

  it("redacts signature, password, and hashes and drops stack traces", async () => {
    const { fetchImpl, calls } = jsonFetch((captured) => {
      if (captured.form["signature"] !== TOKEN) throw new Error("missing signature in form");
      if (captured.url.includes(TOKEN)) throw new Error("token leaked into the url");
      return jsonResponse(leakyBody());
    });
    await withClient(fetchImpl, {}, async (client) => {
      const listed = await call(client, "yourls_meta", { action: "version", params: { db: 1 } });
      expect(listed.isError).toBe(false);
      const raw = JSON.stringify(listed.json);
      expect(raw).toContain("1.10.6");
      expect(raw).toContain("[redacted]");
      expect(raw).not.toContain("hunter2-secret-value");
      expect(raw).not.toContain("deadbeefdeadbeefdeadbeefdeadbeef");
      expect(raw).not.toContain("yourls-api.php:10");
      expect(raw).not.toContain("stack");
      expect(calls[0]?.url).toBe("https://yourls.test/yourls-api.php");
      expect(calls[0]?.form["format"]).toBe("json");
      expect(calls[0]?.form["action"]).toBe("version");
      expect(calls[0]?.form["db"]).toBe("1");
    });
  });

  it("blocks writes when YOURLS_ALLOW_WRITES is not true", async () => {
    const { fetchImpl, calls } = jsonFetch(() => jsonResponse({ ok: true }));
    await withClient(fetchImpl, { YOURLS_ALLOW_WRITES: "false" }, async (client) => {
      const result = await call(client, "yourls_links", {
        action: "shorturl",
        params: { url: "https://example.com/x", keyword: "x" },
        confirm: true,
      });
      expect(result.json).toMatchObject({
        executed: false,
        blocked: true,
        method: "POST",
        path: "yourls-api.php",
      });
      expect(JSON.stringify(result.json)).toContain("short URL");
      expect(calls).toHaveLength(0);
    });
  });

  it("rejects confirm false and the string true", async () => {
    const { fetchImpl, calls } = jsonFetch(() => jsonResponse({ ok: true }));
    await withClient(fetchImpl, {}, async (client) => {
      const asFalse = await call(client, "yourls_links", {
        action: "shorturl",
        params: { url: "https://example.com/x" },
        confirm: false,
      });
      expect(asFalse.isError).toBe(true);
      const asString = await call(client, "yourls_links", {
        action: "shorturl",
        params: { url: "https://example.com/x" },
        confirm: "true",
      });
      expect(asString.isError).toBe(true);
      expect(asString.text).toContain("confirm");
      expect(calls).toHaveLength(0);
    });
  });
});

describe("every registered tool", () => {
  it("guard: every tool is called as a read or a confirmed write, and every write is previewed", async () => {
    const seen = new Set<string>();
    const previewed = new Set<string>();
    const { fetchImpl, calls } = jsonFetch((captured: CapturedRequest) => {
      if (captured.form["signature"] !== TOKEN) throw new Error("missing signature");
      if (captured.url.includes(TOKEN)) throw new Error("token leaked into the url");
      expect(captured.method).toBe("POST");
      expect(captured.form["format"]).toBe("json");
      return jsonResponse(leakyBody());
    });
    await withClient(fetchImpl, { YOURLS_PER_MINUTE: "10000" }, async (client) => {
      const listed = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(listed).toEqual(TOOL_NAMES);
      for (const operation of OPERATIONS) {
        if (operation.write) {
          calls.length = 0;
          const preview = await call(client, operation.tool, argsFor(operation));
          expect(preview.isError, `${operation.tool} ${operation.action} preview`).toBe(false);
          expect(preview.json).toMatchObject({
            executed: false,
            dry_run: true,
            blocked: false,
            method: operation.method,
          });
          expect(String(preview.json?.["path"])).toBe("yourls-api.php");
          expect(calls).toHaveLength(0);
          previewed.add(operation.tool);
        }
        calls.length = 0;
        const args = operation.write
          ? { ...argsFor(operation), confirm: true }
          : argsFor(operation);
        const result = await call(client, operation.tool, args);
        expect(result.isError, `${operation.tool} ${operation.action}`).toBe(false);
        expect(result.text).not.toContain("hunter2-secret-value");
        expect(result.text).not.toContain("yourls-api.php:10");
        expect(calls.length).toBeGreaterThan(0);
        expect(calls[0]?.form["action"]).toBe(operation.yourlsAction);
        expect(calls[0]?.form["format"]).toBe("json");
        seen.add(operation.tool);
      }
    });
    expect([...seen].sort()).toEqual(TOOL_NAMES);
    const writeTools = [...new Set(WRITE_OPS.map((operation) => operation.tool))].sort();
    for (const name of writeTools) expect(previewed.has(name), name).toBe(true);
    expect(OPERATIONS.length).toBe(6);
    expect(WRITE_OPS.length).toBe(1);
  });
});

describe("error paths", () => {
  it("maps 403 auth, 404, 400 already exists, 422, and 429", async () => {
    const cases: { status: number; body: unknown; needle: string; retry?: string }[] = [
      {
        status: 403,
        body: { message: `Please log in ${TOKEN}`, errorCode: "403" },
        needle: "[unauthorized]",
      },
      {
        status: 404,
        body: { message: "Error: short URL not found", errorCode: "404" },
        needle: "[not-found]",
      },
      {
        status: 400,
        body: {
          status: "fail",
          message: "Short URL mcpkw already exists in database or is reserved",
          errorCode: "400",
          statusCode: "400",
        },
        needle: "[input]",
      },
      {
        status: 409,
        body: {
          status: "fail",
          message: "https://example.com already exists in database (short URL: sho.rt/abc)",
          errorCode: "409",
          statusCode: "409",
        },
        needle: "[input]",
      },
      {
        status: 422,
        body: { message: "invalid", errorCode: "422" },
        needle: "[input]",
      },
      {
        status: 429,
        body: { message: `slow ${TOKEN}` },
        needle: "[rate-limit]",
        retry: "9",
      },
    ];
    for (const item of cases) {
      const { fetchImpl } = jsonFetch(() =>
        jsonResponse(
          item.body,
          item.status,
          item.retry === undefined ? {} : { "retry-after": item.retry },
        ),
      );
      await withClient(fetchImpl, {}, async (client) => {
        const result = await call(client, "yourls_meta", { action: "version" });
        expect(result.isError).toBe(true);
        expect(result.text).toContain(item.needle);
        expect(result.text).not.toContain(TOKEN);
        if (item.retry !== undefined) expect(result.text).toContain(`retry after ${item.retry}s`);
      });
    }
  });
});

describe("write gate", () => {
  const plan = {
    method: "POST" as const,
    path: "yourls-api.php",
    query: undefined,
    body: { action: "shorturl", url: "https://example.com" },
    summary: "create",
    warnings: ["This creates a short URL. It writes to the YOURLS database."],
    revealSecret: false,
  };

  it("previews when confirm is omitted", () => {
    const decision = decideWrite(true, undefined, plan, []);
    expect(decision.kind).toBe("preview");
    if (decision.kind !== "preview") return;
    expect(decision.payload).toMatchObject({ executed: false, dry_run: true, blocked: false });
  });

  it("blocks when confirm is true and writes are disabled", () => {
    const decision = decideWrite(false, true, plan, []);
    expect(decision.kind).toBe("preview");
    if (decision.kind !== "preview") return;
    expect(decision.payload).toMatchObject({ blocked: true, reason: WRITES_DISABLED });
  });

  it("executes only for boolean true plus allow writes", () => {
    expect(decideWrite(true, true, plan, []).kind).toBe("execute");
  });
});
