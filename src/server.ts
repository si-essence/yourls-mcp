import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolDescription, toolName } from "./brand.js";
import { callYourls } from "./call.js";
import { CONNECTOR_NAME, CONNECTOR_TITLE, CONNECTOR_VERSION } from "./constants.js";
import { ConnectorError } from "./errors.js";
import { toolInputSchema, type ToolInput } from "./fields.js";
import { operationsForTool, requireOp, toolsForToolsets, type Operation } from "./operations.js";
import type { Runtime } from "./runtime.js";
import {
  READ_ONLY_REMOTE,
  WRITE_DESTRUCTIVE,
  WRITE_NON_IDEMPOTENT,
  registerConnectorTool,
  type ToolAnnotations,
  type ToolContext,
} from "./tools.js";

export function createServer(runtime: Runtime): McpServer {
  const server = new McpServer({
    name: CONNECTOR_NAME,
    title: CONNECTOR_TITLE,
    version: CONNECTOR_VERSION,
  });
  const ctx: ToolContext = { secrets: runtime.secrets, logger: runtime.logger };
  for (const name of toolsForToolsets(runtime.config.toolsets)) {
    publishTool(server, ctx, runtime, name);
  }
  return server;
}

function publishTool(server: McpServer, ctx: ToolContext, runtime: Runtime, name: string): void {
  const operations = operationsForTool(name);
  const first = operations[0];
  if (first === undefined) return;
  const actions = operations.map((operation) => operation.action);
  const head = actions[0];
  if (head === undefined) return;
  const writes = operations.some((operation) => operation.write);
  const destructive = operations.some((operation) => operation.destructive);
  const annotations: ToolAnnotations = writes
    ? destructive
      ? WRITE_DESTRUCTIVE
      : WRITE_NON_IDEMPOTENT
    : READ_ONLY_REMOTE;
  const inputSchema = toolInputSchema([head, ...actions.slice(1)], writes);
  registerConnectorTool(
    server,
    {
      name: toolName(name),
      description: toolDescription(describeTool(name, first.toolset, operations, writes)),
      inputSchema,
      annotations,
      handler: (args) =>
        handleTool(runtime, name, {
          action: args.action,
          target: args.target,
          params: args.params,
          query: args.query,
          body: args.body,
          confirm: args.confirm === true ? true : undefined,
        }),
    },
    ctx,
  );
}

async function handleTool(
  runtime: Runtime,
  tool: string,
  args: ToolInput,
): Promise<Record<string, unknown>> {
  if (args.action === "help") return describeAction(tool, args.target);
  const operation = operationsForTool(tool).find((row) => row.action === args.action);
  if (operation === undefined) {
    throw new ConnectorError("input", `Unknown YOURLS action ${args.action}.`);
  }
  return callYourls(runtime, operation, {
    params: args.params,
    query: args.query,
    body: args.body,
    confirm: args.confirm,
  });
}

function describeAction(tool: string, target: string | undefined): Record<string, unknown> {
  if (target === undefined || target === "help") {
    const operations = operationsForTool(tool);
    return {
      tool,
      actions: operations.map((operation) => ({
        action: operation.action,
        yourlsAction: operation.yourlsAction,
        method: operation.method,
        path: operation.path,
        write: operation.write,
        summary: operation.summary,
      })),
    };
  }
  const operation = requireOp(tool, target);
  return {
    action: operation.action,
    yourlsAction: operation.yourlsAction,
    method: operation.method,
    path: operation.path,
    write: operation.write,
    summary: operation.summary,
    params: operation.fields,
    warnings: operation.warnings,
  };
}

function describeTool(
  name: string,
  toolset: string,
  operations: readonly Operation[],
  writes: boolean,
): string {
  const actions = operations.map((operation) => operation.action).join(", ");
  const gate = writes
    ? " Writes need confirm set to the boolean true and YOURLS_ALLOW_WRITES=true. Omit confirm for a dry-run preview that sends nothing."
    : "";
  return `${name} covers the ${toolset} toolset (${operations.length} operations). Auth is a POST body signature from YOURLS_SIGNATURE, or username and password from YOURLS_USERNAME and YOURLS_PASSWORD. YOURLS_URL is required. Requests go to yourls-api.php with format=json. action help with target returns one action's parameters.${gate} Actions: ${actions}.`;
}
