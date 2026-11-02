import { ConnectorError, type ConnectorErrorCode } from "./errors.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = entry;
  return out;
}

function numericCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && /^[0-9]+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

function pickMessage(body: Record<string, unknown> | undefined, fallback: string): string {
  if (body === undefined) return fallback;
  for (const key of ["message", "error_message", "error", "simple", "title", "detail"]) {
    const entry = body[key];
    if (typeof entry === "string" && entry.trim().length > 0) return entry.trim();
  }
  return fallback;
}

function alreadyExists(message: string): boolean {
  return /already exists/i.test(message);
}

/**
 * Map YOURLS HTTP status plus JSON errorCode/statusCode to a ConnectorError.
 * Auth failures are 403 in YOURLS and become unauthorized here.
 * Duplicate keyword or long URL (400 or 409, or "already exists") is input.
 */
export function errorFromYourls(
  httpStatus: number,
  body: unknown,
  label: string,
): ConnectorError | undefined {
  const record = asRecord(body);
  const fromBody = numericCode(record?.["errorCode"]) ?? numericCode(record?.["statusCode"]);
  const status = fromBody ?? httpStatus;
  const fail = record?.["status"] === "fail";
  const message = pickMessage(record, "");
  const duplicate = alreadyExists(message);

  const successHttp = httpStatus >= 200 && httpStatus < 300;
  const successCode = status === 200 || status === 0;
  if (successHttp && successCode && !fail && !duplicate) return undefined;

  const mapped = mapCode(status, duplicate, message);
  const detail = message.length > 0 ? `: ${message}` : "";
  return new ConnectorError(mapped.code, `${label} HTTP ${mapped.http}${detail}`, mapped.retry);
}

function mapCode(
  status: number,
  duplicate: boolean,
  message: string,
): { code: ConnectorErrorCode; http: number; retry: number | null } {
  if (status === 401 || status === 403) {
    return { code: "unauthorized", http: status === 401 ? 401 : 403, retry: null };
  }
  if (status === 404) return { code: "not_found", http: 404, retry: null };
  if (status === 429) return { code: "rate_limit", http: 429, retry: null };
  if (duplicate || status === 400 || status === 409 || status === 422) {
    return { code: "input", http: status === 0 ? 400 : status, retry: null };
  }
  if (status >= 500) return { code: "upstream", http: status, retry: null };
  if (/please log in|invalid username or password/i.test(message)) {
    return { code: "unauthorized", http: 403, retry: null };
  }
  return { code: "upstream", http: status === 0 ? 500 : status, retry: null };
}
