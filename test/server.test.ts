import { describe, expect, it } from "vitest";
import { jsonFetch, jsonResponse, runtimeFor } from "./harness.js";
import { connectServer } from "./mcp.js";

describe("createServer", () => {
  it("lists default tools when YOURLS_TOOLSETS is unset", async () => {
    const { fetchImpl } = jsonFetch(() => jsonResponse({ ok: true }));
    const runtime = runtimeFor(fetchImpl, { YOURLS_TOOLSETS: undefined });
    const connected = await connectServer(runtime);
    try {
      const listed = await connected.client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "yourls_links",
        "yourls_meta",
        "yourls_stats",
      ]);
    } finally {
      await connected.close();
    }
  });
});
