import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { redact, redactUnknown } from "../src/redact.js";
import { createRuntime } from "../src/runtime.js";
import { connectServer } from "./mcp.js";
import { readToolText } from "./result.js";

const KEY = "super-secret/key+value=99";
const ENCODED = encodeURIComponent(KEY);
const URL = "https://yourls.test";

function assertNoKey(label: string, text: string): void {
  expect(text, label).not.toContain(KEY);
  expect(text, label).not.toContain(ENCODED);
}

describe("redact", () => {
  it("strips the secret, its url encoding, query params, and auth headers", () => {
    const raw = [
      `key=${KEY}`,
      `encoded=${ENCODED}`,
      `https://yourls.test/yourls-api.php?signature=${KEY}&x=1`,
      `Authorization: Bearer ${KEY}`,
      `Authorization: Basic ${KEY}`,
      `x-api-key: ${KEY}`,
      `x-auth-token: ${KEY}`,
    ].join("\n");
    const cleaned = redact(raw, [KEY]);
    assertNoKey("redact", cleaned);
    expect(cleaned).toContain("signature=[redacted]");
    expect(cleaned).toContain("Bearer [redacted]");
    expect(cleaned).toContain("Basic [redacted]");
    expect(cleaned).toContain("x-api-key: [redacted]");
    expect(cleaned).toContain("x-auth-token: [redacted]");
  });

  it("redacts nested signature, password, and hash fields and leaves names", () => {
    const cleaned = redactUnknown(
      {
        username: "admin",
        signature: "sig-token-value-xxxx",
        password: "hunter2-secret-value",
        hash: "deadbeefdeadbeefdeadbeefdeadbeef",
        folders: ["/data/yourls"],
      },
      [KEY],
    );
    const raw = JSON.stringify(cleaned);
    assertNoKey("nested", raw);
    expect(raw).toContain("admin");
    expect(raw).toContain("/data/yourls");
    expect(raw).not.toContain("sig-token-value-xxxx");
    expect(raw).not.toContain("hunter2-secret-value");
    expect(raw).not.toContain("deadbeefdeadbeefdeadbeefdeadbeef");
  });

  it("redacts logger lines", () => {
    const lines: string[] = [];
    const logger = createLogger([KEY], (line) => {
      lines.push(line);
    });
    logger.error(`upstream said ${KEY}`);
    assertNoKey("logger", lines.join("\n"));
    expect(lines.join("\n")).toContain("[redacted]");
  });

  it("keeps the signature out of tool output, errors, and logs", async () => {
    const logs: string[] = [];
    const consoleLines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      consoleLines.push(
        args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
      );
    });
    let call = 0;
    const fetchImpl = vi.fn<typeof fetch>(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(Response.json({ version: "1.10.6", title: `hello ${KEY}` }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ message: `Please log in ${KEY}`, errorCode: "403" }), {
          status: 403,
        }),
      );
    });
    const runtime = createRuntime(
      loadConfig(
        {
          YOURLS_URL: URL,
          YOURLS_SIGNATURE: KEY,
          YOURLS_CACHE_TTL_SEC: "0",
          YOURLS_TOOLSETS: "meta",
        },
        [],
      ),
      {
        fetchImpl,
        logger: { info: () => undefined, error: (message) => logs.push(message) },
      },
    );
    const connected = await connectServer(runtime);
    try {
      const ok = readToolText(
        await connected.client.callTool({ name: "yourls_meta", arguments: { action: "version" } }),
      );
      expect(ok.isError).toBe(false);
      assertNoKey("ok", ok.text);
      const failed = readToolText(
        await connected.client.callTool({ name: "yourls_meta", arguments: { action: "version" } }),
      );
      expect(failed.isError).toBe(true);
      assertNoKey("err", failed.text);
      expect(failed.text).toContain("[unauthorized]");
    } finally {
      await connected.close();
      spy.mockRestore();
    }
    assertNoKey("logs", logs.join("\n"));
    assertNoKey("console", consoleLines.join("\n"));
  });
});
