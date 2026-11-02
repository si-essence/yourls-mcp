import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { ConnectorError } from "../src/errors.js";
import { jsonValueSchema } from "../src/json.js";
import { createRuntime } from "../src/runtime.js";

const KEY = "super-secret/key+value=99";
const URL = "https://yourls.test";
const recordSchema = z.object({ version: z.string() });

function runtimeFor(options: {
  fetchImpl: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}) {
  return createRuntime(loadConfig({ YOURLS_URL: URL, YOURLS_SIGNATURE: KEY, ...options.env }, []), {
    fetchImpl: options.fetchImpl,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  const record = input as { url?: unknown; href?: unknown };
  if (typeof record.url === "string") return record.url;
  if (typeof record.href === "string") return record.href;
  return "";
}

function formOf(init: RequestInit | undefined): URLSearchParams {
  if (typeof init?.body !== "string") return new URLSearchParams();
  return new URLSearchParams(init.body);
}

describe("HttpClient", () => {
  it("POSTs form fields with signature in the body and never in the URL", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      urls.push(requestUrl(input));
      const form = formOf(init);
      expect(form.get("signature")).toBe(KEY);
      expect(form.get("action")).toBe("version");
      expect(form.get("format")).toBe("json");
      expect(form.get("username")).toBeNull();
      return Promise.resolve(Response.json({ version: "1.10.6" }));
    });
    let now = 0;
    const runtime = runtimeFor({
      fetchImpl,
      env: { YOURLS_CACHE_TTL_SEC: "30" },
      now: () => now,
    });
    const first = await runtime.client.postForm(
      { path: "yourls-api.php", fields: { action: "version", format: "json" }, ttlSec: 30 },
      recordSchema,
    );
    const second = await runtime.client.postForm(
      { path: "yourls-api.php", fields: { action: "version", format: "json" }, ttlSec: 30 },
      recordSchema,
    );
    expect(first).toEqual({ version: "1.10.6" });
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(urls.join("\n")).not.toContain(KEY);
    expect(urls[0]).toBe(`${URL}/yourls-api.php`);
    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    now = 31_000;
    await runtime.client.postForm(
      { path: "yourls-api.php", fields: { action: "version", format: "json" }, ttlSec: 30 },
      recordSchema,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not spend the rate limit on a cache hit and blocks the next miss", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ version: "1" })));
    const runtime = runtimeFor({
      fetchImpl,
      env: { YOURLS_PER_MINUTE: "1", YOURLS_CACHE_TTL_SEC: "60" },
      now: () => 0,
    });
    await runtime.client.postForm(
      { path: "yourls-api.php", fields: { action: "version", format: "json" }, ttlSec: 60 },
      recordSchema,
    );
    await expect(
      runtime.client.postForm(
        { path: "yourls-api.php", fields: { action: "db-stats", format: "json" }, ttlSec: 60 },
        jsonValueSchema,
      ),
    ).rejects.toMatchObject({ code: "rate_limit" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("redacts a secret that the upstream body or a network error tried to echo", async () => {
    const logs: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(() => {
      throw new Error(`connect failed ${KEY} ${encodeURIComponent(KEY)}`);
    });
    const runtime = createRuntime(loadConfig({ YOURLS_URL: URL, YOURLS_SIGNATURE: KEY }, []), {
      fetchImpl,
      logger: { info: () => undefined, error: (message) => logs.push(message) },
    });
    await expect(
      runtime.client.postForm(
        { path: "yourls-api.php", fields: { action: "version", format: "json" }, ttlSec: 0 },
        jsonValueSchema,
      ),
    ).rejects.toThrow(ConnectorError);
    try {
      await runtime.client.postForm(
        { path: "yourls-api.php", fields: { action: "version", format: "json" }, ttlSec: 0 },
        jsonValueSchema,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      if (!(error instanceof ConnectorError)) throw error;
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain(encodeURIComponent(KEY));
      expect(error.message).toContain("[redacted]");
    }
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("sends username and password in the form body", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      const form = formOf(init);
      expect(form.get("username")).toBe("admin");
      expect(form.get("password")).toBe("correct-horse-battery");
      expect(form.get("signature")).toBeNull();
      expect(requestUrl(_input)).not.toContain("correct-horse-battery");
      return Promise.resolve(Response.json({ version: "1.10.6" }));
    });
    const runtime = createRuntime(
      loadConfig(
        {
          YOURLS_URL: URL,
          YOURLS_USERNAME: "admin",
          YOURLS_PASSWORD: "correct-horse-battery",
        },
        [],
      ),
      { fetchImpl },
    );
    const body = await runtime.client.postForm(
      { path: "yourls-api.php", fields: { action: "version", format: "json" }, ttlSec: 0 },
      recordSchema,
    );
    expect(body).toEqual({ version: "1.10.6" });
  });

  it("sends a time-limited hashed signature and remembers the digest", async () => {
    const now = 1_700_000_000_000;
    const timestamp = String(Math.floor(now / 1000));
    const digest = createHash("sha256").update(`${timestamp}${KEY}`).digest("hex");
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      const form = formOf(init);
      expect(form.get("timestamp")).toBe(timestamp);
      expect(form.get("signature")).toBe(digest);
      expect(form.get("hash")).toBe("sha256");
      expect(requestUrl(_input)).not.toContain(digest);
      expect(requestUrl(_input)).not.toContain(KEY);
      return Promise.resolve(Response.json({ version: "1.10.6", signature: digest }));
    });
    const runtime = runtimeFor({
      fetchImpl,
      env: { YOURLS_SIGNATURE_HASH: "sha256" },
      now: () => now,
    });
    const body = await runtime.client.postForm(
      { path: "yourls-api.php", fields: { action: "version", format: "json" }, ttlSec: 0 },
      jsonValueSchema,
    );
    expect(JSON.stringify(body)).not.toContain(digest);
    expect(JSON.stringify(body)).toContain("[redacted]");
  });

  it("maps timeout, not found, and too many requests", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          reject(new Error("missing abort signal"));
          return;
        }
        const abort = (): void => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    const timeoutRuntime = runtimeFor({
      fetchImpl: hanging,
      env: { YOURLS_TIMEOUT_MS: "100" },
    });
    await expect(
      timeoutRuntime.client.postForm(
        { path: "yourls-api.php", fields: { action: "version", format: "json" }, ttlSec: 0 },
        jsonValueSchema,
      ),
    ).rejects.toMatchObject({ code: "timeout" });

    const notFound = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({ message: "Error: short URL not found", errorCode: "404" }, { status: 404 }),
      ),
    );
    await expect(
      runtimeFor({ fetchImpl: notFound }).client.postForm(
        {
          path: "yourls-api.php",
          fields: { action: "expand", format: "json", shorturl: "missing" },
          ttlSec: 0,
        },
        jsonValueSchema,
      ),
    ).rejects.toMatchObject({ code: "not_found" });

    const limited = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(`slow ${KEY}`, { status: 429, headers: { "retry-after": "4" } }),
      ),
    );
    try {
      await runtimeFor({ fetchImpl: limited }).client.postForm(
        { path: "yourls-api.php", fields: { action: "shorturl", format: "json" }, ttlSec: 0 },
        jsonValueSchema,
      );
      throw new Error("expected rate limit");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      if (!(error instanceof ConnectorError)) throw error;
      expect(error.code).toBe("rate_limit");
      expect(error.retryAfterSeconds).toBe(4);
      expect(error.message).not.toContain(KEY);
    }
  });
});
