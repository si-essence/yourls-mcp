import { ConnectorError } from "./errors.js";
import { jsonValueSchema } from "./json.js";
import type { Operation } from "./operations.js";
import { asJsonObject } from "./parse.js";
import type { Runtime } from "./runtime.js";
import { withWrite } from "./write-gate.js";

const RESERVED = new Set([
  "username",
  "password",
  "signature",
  "timestamp",
  "hash",
  "format",
  "action",
  "callback",
  "jsonp",
]);

export interface CallArgs {
  readonly params?:
    | Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>
    | undefined;
  readonly query?:
    | Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>
    | undefined;
  readonly body?: unknown;
  readonly confirm?: true | undefined;
}

export async function callYourls(
  runtime: Runtime,
  operation: Operation,
  args: CallArgs = {},
): Promise<Record<string, unknown>> {
  const fields = collectFields(operation, args);
  const ttlSec = operation.write ? 0 : runtime.cacheTtlSec;
  const run = async (): Promise<Record<string, unknown>> => {
    const json = await runtime.client.postForm(
      { path: operation.path, fields, ttlSec, fieldRedact: true },
      jsonValueSchema,
    );
    return asJsonObject(json);
  };
  if (!operation.write) return run();
  return withWrite(
    runtime,
    args.confirm,
    {
      method: "POST",
      path: operation.path,
      query: undefined,
      body: fields,
      summary: operation.summary,
      warnings: operation.warnings,
      revealSecret: false,
    },
    run,
  );
}

function collectFields(operation: Operation, args: CallArgs): Record<string, string> {
  const merged: Record<string, string> = {};
  mergeRecord(merged, args.params);
  mergeRecord(merged, args.query);
  if (args.body !== undefined) {
    if (args.body === null || typeof args.body !== "object" || Array.isArray(args.body)) {
      throw new ConnectorError("input", "body must be an object of form fields.");
    }
    mergeRecord(merged, args.body as Record<string, unknown>);
  }
  const out: Record<string, string> = {
    action: operation.yourlsAction,
    format: "json",
  };
  for (const field of operation.fields) {
    const value = merged[field.name];
    if (value === undefined || value === "") {
      if (field.required) {
        throw new ConnectorError("input", `Missing parameter ${field.name}.`);
      }
      continue;
    }
    out[field.name] = value;
  }
  for (const [key, value] of Object.entries(merged)) {
    if (out[key] !== undefined) continue;
    if (operation.fields.some((field) => field.name === key)) continue;
    if (RESERVED.has(key)) {
      throw new ConnectorError("input", `Parameter ${key} is reserved for connector auth.`);
    }
    out[key] = value;
  }
  return out;
}

function mergeRecord(
  target: Record<string, string>,
  record: Readonly<Record<string, unknown>> | undefined,
): void {
  if (record === undefined) return;
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    if (RESERVED.has(key)) {
      throw new ConnectorError("input", `Parameter ${key} is reserved for connector auth.`);
    }
    if (Array.isArray(value)) {
      throw new ConnectorError("input", `Parameter ${key} must be a string or a number.`);
    }
    if (typeof value === "boolean") target[key] = value ? "1" : "0";
    else if (typeof value === "string" || typeof value === "number") target[key] = String(value);
    else {
      throw new ConnectorError("input", `Parameter ${key} must be a string or a number.`);
    }
  }
}
