import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALL_TOOLSETS,
  CORE_ACTIONS,
  DEFAULT_TOOLSETS,
  EXCLUSIONS,
  OPERATIONS,
  parseToolsets,
  toolNames,
} from "../src/operations.js";

function planned(): { actions: string[]; exclusions: string[] } {
  const script = [
    'import { planOperations } from "./scripts/gen-operations.mjs";',
    'import { readFileSync } from "node:fs";',
    'const spec = JSON.parse(readFileSync("./yourls.routes.json", "utf8"));',
    "const plan = planOperations(spec);",
    "process.stdout.write(JSON.stringify({",
    '  actions: plan.rows.map((row) => row.tool + ":" + row.action),',
    "  exclusions: plan.exclusions.map((row) => row.action),",
    "}));",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "generator failed");
  }
  return JSON.parse(result.stdout) as { actions: string[]; exclusions: string[] };
}

function loadSpec(): {
  core: string[];
  actions: { yourlsAction: string }[];
  exclusions: { action: string }[];
} {
  return JSON.parse(readFileSync(new URL("../yourls.routes.json", import.meta.url), "utf8")) as {
    core: string[];
    actions: { yourlsAction: string }[];
    exclusions: { action: string }[];
  };
}

describe("route coverage", () => {
  const spec = loadSpec();

  it("maps or excludes every core YOURLS action", () => {
    expect(spec.core).toEqual([...CORE_ACTIONS]);
    const mapped = new Set(OPERATIONS.map((operation) => operation.yourlsAction));
    const excluded = new Set(EXCLUSIONS.map((row) => row.action));
    for (const action of spec.core) {
      const inMap = mapped.has(action);
      const inExclusions = excluded.has(action);
      expect(inMap || inExclusions, action).toBe(true);
      expect(inMap && inExclusions, action).toBe(false);
    }
    for (const operation of OPERATIONS) {
      expect(spec.core).toContain(operation.yourlsAction);
    }
    expect(mapped.size).toBe(spec.core.length);
    expect(OPERATIONS).toHaveLength(6);
  });

  it("keeps action names unique and stable against the generator", () => {
    const seen = new Set<string>();
    for (const operation of OPERATIONS) {
      const id = `${operation.tool}:${operation.action}`;
      expect(seen.has(id), id).toBe(false);
      seen.add(id);
      expect(operation.action).not.toBe("help");
      expect(operation.action).toMatch(/^[a-z0-9_]+$/);
      expect(operation.method).toBe("POST");
      expect(operation.path).toBe("yourls-api.php");
    }
    const plan = planned();
    expect([...plan.actions].sort()).toEqual(
      OPERATIONS.map((operation) => `${operation.tool}:${operation.action}`).sort(),
    );
    expect(plan.exclusions.sort()).toEqual(EXCLUSIONS.map((row) => row.action).sort());
    const shorturl = OPERATIONS.find((operation) => operation.yourlsAction === "shorturl");
    expect(shorturl?.write).toBe(true);
    expect(shorturl?.action).toBe("shorturl");
    const version = OPERATIONS.find((operation) => operation.yourlsAction === "version");
    expect(version?.write).toBe(false);
    expect(version?.toolset).toBe("meta");
  });

  it("documents plugin actions as exclusions", () => {
    expect(EXCLUSIONS.map((row) => row.action).sort()).toEqual(["delete", "edit", "update"]);
    for (const row of EXCLUSIONS) {
      expect(row.reason.length).toBeGreaterThan(10);
      expect(/plugin|not a core/i.test(row.reason)).toBe(true);
    }
  });
});

describe("toolset scoping", () => {
  it("defaults to the read-focused subset and treats all as every toolset", () => {
    expect([...parseToolsets(undefined)]).toEqual([...DEFAULT_TOOLSETS]);
    expect([...parseToolsets("all")]).toEqual([...ALL_TOOLSETS]);
    expect(parseToolsets("meta,stats")).toEqual(["meta", "stats"]);
    expect(toolNames()).toEqual(["yourls_links", "yourls_meta", "yourls_stats"]);
    expect(DEFAULT_TOOLSETS).toEqual(["meta", "stats", "links"]);
  });
});
