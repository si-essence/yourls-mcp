import { z } from "zod";
import { confirmField } from "./confirm.js";
import { fixedError } from "./zod-messages.js";

export { confirmField };

const actionError = fixedError(
  "action must be a published YOURLS operation for this tool, or help",
);

const primitive = z.union([z.string(), z.number(), z.boolean()]);

export const stringMapField = z
  .record(z.string().min(1).max(100), z.union([primitive, z.array(primitive)]))
  .optional()
  .describe("YOURLS action fields keyed by name, such as url, keyword, shorturl, filter, limit.");

export const bodyField = z
  .record(z.string().min(1).max(100), z.unknown())
  .optional()
  .describe(
    "Optional extra form fields. Auth fields are rejected. Secrets are redacted in output.",
  );

export function actionField(actions: [string, ...string[]]): z.ZodType<string> {
  return z.enum(actions, { error: actionError }).describe("YOURLS operation to call, or help.");
}

export function toolInputSchema(actions: [string, ...string[]], writes: boolean) {
  const names = ["help", ...actions.filter((name) => name !== "help")] as [string, ...string[]];
  const shape = {
    action: actionField(names),
    target: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe("With action help, the action whose parameters to describe."),
    params: stringMapField.describe(
      "Action fields, such as url, keyword, shorturl, filter, limit.",
    ),
    query: stringMapField.describe("Same as params. Prefer params."),
    body: bodyField,
    ...(writes ? { confirm: confirmField } : {}),
  };
  return z.object(shape);
}

export type ToolInput = {
  action: string;
  target?: string | undefined;
  params?:
    | Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>
    | undefined;
  query?:
    | Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>
    | undefined;
  body?: unknown;
  confirm?: true | undefined;
};
