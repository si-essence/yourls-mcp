import { z } from "zod";
import { brandBaseUrl, brandSecret, type BaseUrl, type Secret } from "./brand.js";
import { CONNECTOR_NAME, CONNECTOR_VERSION } from "./constants.js";
import { ConnectorError } from "./errors.js";
import { parseToolsets } from "./operations.js";
import { fixedError } from "./zod-messages.js";

const invalid = fixedError("invalid");

export const SIGNATURE_HASHES = ["md5", "sha256", "sha384", "sha512"] as const;
export type SignatureHash = (typeof SIGNATURE_HASHES)[number];

const EnvSchema = z.object({
  YOURLS_SIGNATURE: z
    .string({ error: invalid })
    .trim()
    .min(8, { error: invalid })
    .max(512, { error: invalid })
    .optional(),
  YOURLS_SIGNATURE_HASH: z.enum(SIGNATURE_HASHES, { error: invalid }).optional(),
  YOURLS_USERNAME: z
    .string({ error: invalid })
    .trim()
    .min(1, { error: invalid })
    .max(256, { error: invalid })
    .optional(),
  YOURLS_PASSWORD: z
    .string({ error: invalid })
    .min(1, { error: invalid })
    .max(512, { error: invalid })
    .optional(),
  YOURLS_URL: z.url({ error: invalid }),
  YOURLS_ALLOW_WRITES: z.string({ error: invalid }).optional(),
  YOURLS_TOOLSETS: z.string({ error: invalid }).optional(),
  YOURLS_PER_MINUTE: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  YOURLS_TIMEOUT_MS: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  YOURLS_CONTACT: z
    .string({ error: invalid })
    .trim()
    .min(1, { error: invalid })
    .max(120, { error: invalid })
    .optional(),
  MCP_TRANSPORT: z.enum(["stdio", "http"], { error: invalid }).optional(),
  PORT: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  YOURLS_CACHE_TTL_SEC: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
});

export interface Config {
  signature: Secret | undefined;
  signatureHash: SignatureHash | undefined;
  username: string | undefined;
  password: Secret | undefined;
  baseUrl: BaseUrl;
  allowWrites: boolean;
  toolsets: readonly string[];
  perMinute: number;
  timeoutMs: number;
  contact: string;
  transport: "stdio" | "http";
  port: number;
  cacheTtlSec: number;
  userAgent: string;
}

function hasControlChar(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function blank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return blank(env[name]);
}

function issueSummary(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path =
        issue.path.length === 0 ? "(root)" : issue.path.map((part) => String(part)).join(".");
      return `${path} (${issue.code})`;
    })
    .join("; ");
}

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (raw === undefined) return fallback;
  const parsed = z.number().int().min(min).max(max).safeParse(Number(raw));
  if (!parsed.success) {
    throw new ConnectorError("config", `Invalid environment: ${field} (out_of_range).`);
  }
  return parsed.data;
}

function userAgentFor(contact: string): string {
  const clean = contact
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 120);
  return `${CONNECTOR_NAME}/${CONNECTOR_VERSION} (${clean.length > 0 ? clean : "contact@example.com"})`;
}

function normalizeBaseUrl(value: string): BaseUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectorError("config", "Invalid environment: YOURLS_URL (invalid_url).");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConnectorError("config", "Invalid environment: YOURLS_URL (invalid_url).");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConnectorError("config", "Invalid environment: YOURLS_URL (userinfo).");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConnectorError("config", "Invalid environment: YOURLS_URL (query_or_hash).");
  }
  return brandBaseUrl(value.replace(/\/+$/, ""));
}

export function loadConfig(env: NodeJS.ProcessEnv, argv: readonly string[]): Config {
  const urlRaw = read(env, "YOURLS_URL");
  if (urlRaw === undefined) {
    throw new ConnectorError(
      "config",
      "Invalid environment: YOURLS_URL (required). Set it to your YOURLS origin, for example http://127.0.0.1:8090.",
    );
  }

  const parsed = EnvSchema.safeParse({
    YOURLS_SIGNATURE: read(env, "YOURLS_SIGNATURE"),
    YOURLS_SIGNATURE_HASH: read(env, "YOURLS_SIGNATURE_HASH"),
    YOURLS_USERNAME: read(env, "YOURLS_USERNAME"),
    YOURLS_PASSWORD: read(env, "YOURLS_PASSWORD"),
    YOURLS_URL: urlRaw,
    YOURLS_ALLOW_WRITES: read(env, "YOURLS_ALLOW_WRITES"),
    YOURLS_TOOLSETS: read(env, "YOURLS_TOOLSETS"),
    YOURLS_PER_MINUTE: read(env, "YOURLS_PER_MINUTE"),
    YOURLS_TIMEOUT_MS: read(env, "YOURLS_TIMEOUT_MS"),
    YOURLS_CONTACT: read(env, "YOURLS_CONTACT"),
    MCP_TRANSPORT: read(env, "MCP_TRANSPORT"),
    PORT: read(env, "PORT"),
    YOURLS_CACHE_TTL_SEC: read(env, "YOURLS_CACHE_TTL_SEC"),
  });
  if (!parsed.success) {
    throw new ConnectorError("config", `Invalid environment: ${issueSummary(parsed.error)}.`);
  }

  const data = parsed.data;
  const signature =
    data.YOURLS_SIGNATURE === undefined ? undefined : brandSecret(data.YOURLS_SIGNATURE);
  const password =
    data.YOURLS_PASSWORD === undefined ? undefined : brandSecret(data.YOURLS_PASSWORD);
  const username = data.YOURLS_USERNAME;
  if ((username === undefined) !== (password === undefined)) {
    throw new ConnectorError(
      "config",
      "Invalid environment: YOURLS_USERNAME and YOURLS_PASSWORD must be set together.",
    );
  }
  if (signature === undefined && username === undefined) {
    throw new ConnectorError(
      "config",
      "Invalid environment: set YOURLS_SIGNATURE or YOURLS_USERNAME and YOURLS_PASSWORD.",
    );
  }
  if (data.YOURLS_SIGNATURE_HASH !== undefined && signature === undefined) {
    throw new ConnectorError(
      "config",
      "Invalid environment: YOURLS_SIGNATURE_HASH needs YOURLS_SIGNATURE.",
    );
  }
  const baseUrl = normalizeBaseUrl(data.YOURLS_URL);
  const contact = data.YOURLS_CONTACT ?? "contact@example.com";
  if (hasControlChar(contact)) {
    throw new ConnectorError("config", "Invalid environment: YOURLS_CONTACT (control_character).");
  }
  const userAgent = userAgentFor(contact);
  const secretValues = [signature, password].filter(
    (value): value is Secret => value !== undefined,
  );
  for (const secret of secretValues) {
    if (baseUrl.includes(secret)) {
      throw new ConnectorError("config", "Invalid environment: YOURLS_URL (contains_secret).");
    }
    if (contact.includes(secret) || userAgent.includes(secret)) {
      throw new ConnectorError("config", "Invalid environment: YOURLS_CONTACT (contains_secret).");
    }
    if (username !== undefined && username.includes(secret)) {
      throw new ConnectorError("config", "Invalid environment: YOURLS_USERNAME (contains_secret).");
    }
  }

  const envTransport = data.MCP_TRANSPORT ?? "stdio";
  const transport = argv.includes("--http") ? "http" : envTransport;
  const allowWrites = data.YOURLS_ALLOW_WRITES === "true";
  let toolsets: readonly string[];
  try {
    toolsets = parseToolsets(data.YOURLS_TOOLSETS);
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError("config", "Invalid environment: YOURLS_TOOLSETS.");
  }

  return {
    signature,
    signatureHash: data.YOURLS_SIGNATURE_HASH,
    username,
    password,
    baseUrl,
    allowWrites,
    toolsets,
    perMinute: boundedInt(data.YOURLS_PER_MINUTE, 30, 1, 10_000, "YOURLS_PER_MINUTE"),
    timeoutMs: boundedInt(data.YOURLS_TIMEOUT_MS, 20_000, 100, 120_000, "YOURLS_TIMEOUT_MS"),
    contact,
    transport,
    port: boundedInt(data.PORT, 3000, 1, 65_535, "PORT"),
    cacheTtlSec: boundedInt(data.YOURLS_CACHE_TTL_SEC, 60, 0, 86_400, "YOURLS_CACHE_TTL_SEC"),
    userAgent,
  };
}
