import { loadConfig } from "../src/config.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

export const TOKEN = "super-secret/key+value=99";
export const PASSWORD = "correct-horse-battery";
export const BASE = "https://yourls.test";

export function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    YOURLS_URL: BASE,
    YOURLS_SIGNATURE: TOKEN,
    YOURLS_CACHE_TTL_SEC: "0",
    YOURLS_ALLOW_WRITES: "true",
    YOURLS_TOOLSETS: "all",
    ...extra,
  };
}

export function runtimeFor(
  fetchImpl: typeof fetch,
  extra: NodeJS.ProcessEnv = {},
  now?: () => number,
): Runtime {
  return createRuntime(loadConfig(env(extra), []), {
    fetchImpl,
    ...(now === undefined ? {} : { now }),
  });
}

export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export interface CapturedRequest {
  method: string;
  url: string;
  contentType: string | null;
  body: unknown;
  form: Record<string, string>;
}

export function capturedFrom(input: RequestInfo | URL, init?: RequestInit): CapturedRequest {
  const headers = new Headers(init?.headers);
  let body: unknown;
  const form: Record<string, string> = {};
  if (init?.body === undefined) body = undefined;
  else if (typeof init.body === "string") {
    try {
      body = JSON.parse(init.body) as unknown;
    } catch {
      body = init.body;
      const params = new URLSearchParams(init.body);
      for (const [key, value] of params.entries()) form[key] = value;
    }
  } else body = init.body;
  return {
    method: init?.method ?? "GET",
    url: requestUrl(input),
    contentType: headers.get("content-type"),
    body,
    form,
  };
}

export function jsonFetch(impl: (captured: CapturedRequest) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const captured = capturedFrom(input, init);
    calls.push(captured);
    return Promise.resolve(impl(captured));
  };
  return { fetchImpl, calls };
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function textResponse(body: string, status = 200, contentType = "text/plain"): Response {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}
