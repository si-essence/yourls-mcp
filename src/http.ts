import { createHash } from "node:crypto";
import type { ZodType } from "zod";
import type { BaseUrl, Secret } from "./brand.js";
import { TtlCache } from "./cache.js";
import type { SignatureHash } from "./config.js";
import { ConnectorError } from "./errors.js";
import type { Logger } from "./log.js";
import { messageFromErrorBody } from "./parse.js";
import type { RateLimiter } from "./rate-limit.js";
import { redact, redactLiterals, redactUnknown, stripUrls } from "./redact.js";
import { errorFromYourls } from "./status.js";

const MAX_BODY = 1_000_000;

export type QueryPrimitive = string | number | boolean;
export type QueryValue = QueryPrimitive | readonly QueryPrimitive[];
export type QueryMap = Readonly<Record<string, QueryValue>>;
export type FormMap = Readonly<Record<string, string>>;

export interface FormPost {
  path: string;
  fields: FormMap;
  ttlSec: number;
  fieldRedact?: boolean;
}

export interface HttpClientOptions {
  baseUrl: BaseUrl;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  secrets: string[];
  cache: TtlCache;
  limiter: RateLimiter;
  userAgent: string;
  logger: Logger;
  signature: Secret | undefined;
  signatureHash: SignatureHash | undefined;
  username: string | undefined;
  password: Secret | undefined;
  now: () => number;
  label: string;
}

export class HttpClient {
  private readonly baseUrl: BaseUrl;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly secrets: string[];
  private readonly cache: TtlCache;
  private readonly limiter: RateLimiter;
  private readonly userAgent: string;
  private readonly logger: Logger;
  private readonly signature: Secret | undefined;
  private readonly signatureHash: SignatureHash | undefined;
  private readonly username: string | undefined;
  private readonly password: Secret | undefined;
  private readonly now: () => number;
  private readonly label: string;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs;
    this.secrets = options.secrets;
    this.cache = options.cache;
    this.limiter = options.limiter;
    this.userAgent = options.userAgent;
    this.logger = options.logger;
    this.signature = options.signature;
    this.signatureHash = options.signatureHash;
    this.username = options.username;
    this.password = options.password;
    this.now = options.now;
    this.label = options.label;
  }

  async postForm<T>(request: FormPost, schema: ZodType<T>): Promise<T> {
    const url = this.buildUrl(request.path, undefined);
    const cacheKey = cacheKeyFor(request.path, request.fields);
    if (request.ttlSec > 0) {
      const cached = this.readCache(cacheKey, schema);
      if (cached !== undefined) return cached;
    }
    const form = this.withAuth(request.fields);
    const body = encodeForm(form);
    if (body.length > MAX_BODY) {
      throw new ConnectorError("input", "Request body was too large.");
    }
    const response = await this.dispatch(url, body);
    const text = await readLimited(response, this.label);
    const keepFields = request.fieldRedact === false;
    if (isRedirect(response.status)) {
      const accepted = this.accept(
        cacheKey,
        0,
        schema,
        redirectBody(response, this.secrets),
        keepFields,
      );
      if (request.ttlSec === 0) this.cache.clear();
      return accepted;
    }
    if (!response.ok) throw this.httpError(response, text);
    this.rejectHtml(text, response.status);
    const json = parseFlexibleBody(text, response.status);
    const mapped = errorFromYourls(response.status, json, this.label);
    if (mapped !== undefined) throw mapped;
    const accepted = this.accept(cacheKey, request.ttlSec, schema, json, keepFields);
    if (request.ttlSec === 0) this.cache.clear();
    return accepted;
  }

  rememberSecret(value: string): void {
    this.remember(value);
  }

  private withAuth(fields: FormMap): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) out[key] = value;
    if (this.signature !== undefined) {
      if (this.signatureHash !== undefined) {
        const timestamp = String(Math.floor(this.now() / 1000));
        const digest = createHash(this.signatureHash)
          .update(`${timestamp}${this.signature}`)
          .digest("hex");
        out["timestamp"] = timestamp;
        out["signature"] = digest;
        out["hash"] = this.signatureHash;
        this.remember(digest);
      } else {
        out["signature"] = this.signature;
      }
      return out;
    }
    if (this.username !== undefined && this.password !== undefined) {
      out["username"] = this.username;
      out["password"] = this.password;
    }
    return out;
  }

  private readCache<T>(cacheKey: string, schema: ZodType<T>): T | undefined {
    const cached = this.cache.get(cacheKey);
    if (cached === undefined) return undefined;
    const parsed = schema.safeParse(cached);
    if (parsed.success) return parsed.data;
    this.cache.delete(cacheKey);
    return undefined;
  }

  private accept<T>(
    cacheKey: string,
    ttlSec: number,
    schema: ZodType<T>,
    json: unknown,
    keepFields = false,
  ): T {
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ConnectorError(
        "upstream",
        `${this.label} response did not match the expected shape.`,
      );
    }
    const scrubbed = keepFields
      ? redactLiterals(parsed.data, this.secrets)
      : redactUnknown(parsed.data, this.secrets);
    const safe = schema.safeParse(scrubbed);
    if (!safe.success) {
      throw new ConnectorError("upstream", `${this.label} response could not be returned safely.`);
    }
    if (ttlSec > 0) this.cache.set(cacheKey, safe.data, ttlSec);
    return safe.data;
  }

  private rejectHtml(text: string, status: number): void {
    if (/<!doctype html|<html[\s>]/i.test(text)) {
      throw new ConnectorError(
        "upstream",
        `${this.label} HTTP ${status}: the service returned an error page instead of JSON.`,
      );
    }
  }

  private buildUrl(path: string, query: QueryMap | undefined): URL {
    if (
      path.length === 0 ||
      path.startsWith("/") ||
      path.includes("?") ||
      path.includes("#") ||
      path.includes("\\") ||
      path.includes("..")
    ) {
      throw new ConnectorError("input", "Request path must be a relative path.");
    }
    this.assertNoSecret(path, "Refusing to place a secret in the request URL.");
    const base = new URL(`${this.baseUrl}/`);
    const url = new URL(path, base);
    if (url.origin !== base.origin) {
      throw new ConnectorError("input", "Request path must stay on the configured base URL.");
    }
    if (query !== undefined) {
      for (const key of Object.keys(query).sort()) {
        const value = query[key];
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            const text = String(item);
            this.assertNoSecret(text, "Refusing to place a secret in the request URL.");
            url.searchParams.append(key, text);
          }
        } else {
          const text = String(value);
          this.assertNoSecret(text, "Refusing to place a secret in the request URL.");
          url.searchParams.set(key, text);
        }
      }
    }
    return url;
  }

  private assertNoSecret(value: string, message: string): void {
    for (const secret of this.secrets) {
      if (
        secret.length >= 8 &&
        (value.includes(secret) || value.includes(encodeURIComponent(secret)))
      ) {
        this.logger.error(message);
        throw new ConnectorError("config", message);
      }
    }
  }

  private async dispatch(url: URL, body: string): Promise<Response> {
    this.limiter.acquire();
    const headers = new Headers();
    headers.set("accept", "application/json");
    headers.set("user-agent", this.userAgent);
    headers.set("content-type", "application/x-www-form-urlencoded");
    try {
      return await this.fetchImpl(url, {
        method: "POST",
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
        body,
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        const seconds = Math.max(1, Math.round(this.timeoutMs / 1000));
        throw new ConnectorError("timeout", `${this.label} request timed out after ${seconds}s.`);
      }
      const raw = error instanceof Error ? error.message : "network error";
      const safe = publicSnippet(raw, this.secrets);
      this.logger.error(`${this.label} request failed: ${safe}`);
      throw new ConnectorError("network", `${this.label} request failed: ${safe}`);
    }
  }

  private remember(value: string): void {
    if (value.length >= 8 && !this.secrets.includes(value)) this.secrets.push(value);
  }

  private httpError(response: Response, text: string): ConnectorError {
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = undefined;
    }
    const mapped = errorFromYourls(
      response.status,
      json ?? { message: messageFromErrorBody(text) },
      this.label,
    );
    if (mapped !== undefined) {
      const retry =
        mapped.code === "rate_limit"
          ? (retryAfterSeconds(response) ?? mapped.retryAfterSeconds)
          : mapped.retryAfterSeconds;
      const wait = retry !== null && mapped.code === "rate_limit" ? ` retry after ${retry}s` : "";
      const snippet = publicSnippet(`${mapped.message}${wait}`, this.secrets);
      return new ConnectorError(mapped.code, snippet, retry);
    }
    const snippet = publicSnippet(messageFromErrorBody(text), this.secrets);
    const detail = snippet.length > 0 ? `: ${snippet}` : "";
    this.logger.error(`${this.label} HTTP ${response.status}${detail}`);
    return new ConnectorError("upstream", `${this.label} HTTP ${response.status}${detail}`);
  }
}

function encodeForm(fields: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(fields).sort()) {
    const value = fields[key];
    if (value === undefined) continue;
    params.set(key, value);
  }
  return params.toString();
}

function cacheKeyFor(path: string, fields: FormMap): string {
  const keys = Object.keys(fields).sort();
  const parts = keys.map((key) => `${key}=${fields[key] ?? ""}`);
  return `POST ${path} ${parts.join("&")}`;
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function redirectBody(response: Response, secrets: readonly string[]): Record<string, unknown> {
  const location = response.headers.get("location");
  return {
    redirected: true,
    status: response.status,
    ...(location === null ? {} : { location: redact(location, secrets) }),
  };
}

function publicSnippet(text: string, secrets: readonly string[]): string {
  return stripUrls(redact(text, secrets)).replace(/\s+/g, " ").trim().slice(0, 180);
}

function parseFlexibleBody(text: string, status: number): unknown {
  if (text.trim().length === 0) {
    return { ok: true, status };
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { text: text.slice(0, 100_000), status };
  }
}

async function readLimited(response: Response, label: string): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > MAX_BODY) {
    await response.body?.cancel().catch(() => undefined);
    throw new ConnectorError("upstream", `${label} response was too large to parse.`);
  }
  let text = "";
  try {
    text = await response.text();
  } catch {
    throw new ConnectorError("upstream", `${label} response could not be read.`);
  }
  if (text.length > MAX_BODY) {
    throw new ConnectorError("upstream", `${label} response was too large to parse.`);
  }
  return text;
}

function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null) return null;
  if (/^[0-9]+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) ? seconds : null;
  }
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return null;
  const seconds = Math.ceil((date - Date.now()) / 1000);
  return seconds > 0 ? seconds : 0;
}
