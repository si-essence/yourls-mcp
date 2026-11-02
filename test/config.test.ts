import { describe, expect, it } from "vitest";
import { CONNECTOR_NAME, CONNECTOR_VERSION } from "../src/constants.js";
import { loadConfig } from "../src/config.js";
import { ConnectorError } from "../src/errors.js";
import { DEFAULT_TOOLSETS } from "../src/operations.js";

const KEY = "super-secret/key+value=99";
const URL = "http://127.0.0.1:8090";

function messageOf(error: unknown): string {
  expect(error).toBeInstanceOf(ConnectorError);
  if (!(error instanceof ConnectorError)) throw error;
  return error.message;
}

function catchError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("loadConfig", () => {
  it("requires YOURLS_URL", () => {
    const message = messageOf(catchError(() => loadConfig({}, [])));
    expect(message).toContain("YOURLS_URL");
    expect(message).toContain("required");
  });

  it("requires signature or username and password", () => {
    const message = messageOf(catchError(() => loadConfig({ YOURLS_URL: URL }, [])));
    expect(message).toContain("YOURLS_SIGNATURE");
    expect(message).toContain("YOURLS_USERNAME");
  });

  it("applies defaults when the URL and signature are set", () => {
    const config = loadConfig({ YOURLS_URL: URL, YOURLS_SIGNATURE: KEY }, []);
    expect(config.signature).toBe(KEY);
    expect(config.signatureHash).toBeUndefined();
    expect(config.username).toBeUndefined();
    expect(config.password).toBeUndefined();
    expect(config.baseUrl).toBe(URL);
    expect(config.allowWrites).toBe(false);
    expect(config.toolsets).toEqual([...DEFAULT_TOOLSETS]);
    expect(config.perMinute).toBe(30);
    expect(config.timeoutMs).toBe(20_000);
    expect(config.contact).toBe("contact@example.com");
    expect(config.transport).toBe("stdio");
    expect(config.port).toBe(3000);
    expect(config.cacheTtlSec).toBe(60);
    expect(config.userAgent).toBe(`${CONNECTOR_NAME}/${CONNECTOR_VERSION} (contact@example.com)`);
  });

  it("lets --http override the transport", () => {
    expect(
      loadConfig({ YOURLS_URL: URL, YOURLS_SIGNATURE: KEY, MCP_TRANSPORT: "stdio" }, [
        "node",
        "app",
        "--http",
      ]).transport,
    ).toBe("http");
    expect(
      loadConfig({ YOURLS_URL: URL, YOURLS_SIGNATURE: KEY, MCP_TRANSPORT: "http" }, []).transport,
    ).toBe("http");
  });

  it("enables writes only when YOURLS_ALLOW_WRITES is the literal true", () => {
    expect(
      loadConfig({ YOURLS_URL: URL, YOURLS_SIGNATURE: KEY, YOURLS_ALLOW_WRITES: "true" }, [])
        .allowWrites,
    ).toBe(true);
    expect(
      loadConfig({ YOURLS_URL: URL, YOURLS_SIGNATURE: KEY, YOURLS_ALLOW_WRITES: "TRUE" }, [])
        .allowWrites,
    ).toBe(false);
    expect(
      loadConfig({ YOURLS_URL: URL, YOURLS_SIGNATURE: KEY, YOURLS_ALLOW_WRITES: "1" }, [])
        .allowWrites,
    ).toBe(false);
  });

  it("parses YOURLS_TOOLSETS", () => {
    expect(
      loadConfig({ YOURLS_URL: URL, YOURLS_SIGNATURE: KEY, YOURLS_TOOLSETS: "all" }, []).toolsets,
    ).toEqual(["links", "meta", "stats"]);
    expect(
      loadConfig({ YOURLS_URL: URL, YOURLS_SIGNATURE: KEY, YOURLS_TOOLSETS: "meta, stats" }, [])
        .toolsets,
    ).toEqual(["meta", "stats"]);
  });

  it("rejects an unknown toolset", () => {
    const message = messageOf(
      catchError(() =>
        loadConfig({ YOURLS_URL: URL, YOURLS_SIGNATURE: KEY, YOURLS_TOOLSETS: "nope" }, []),
      ),
    );
    expect(message).toContain("YOURLS_TOOLSETS");
    expect(message).not.toContain("nope");
  });

  it("accepts username and password together", () => {
    const config = loadConfig(
      { YOURLS_URL: URL, YOURLS_USERNAME: "admin", YOURLS_PASSWORD: "correct-horse-battery" },
      [],
    );
    expect(config.username).toBe("admin");
    expect(config.password).toBe("correct-horse-battery");
    expect(config.signature).toBeUndefined();
  });

  it("rejects username without password", () => {
    const message = messageOf(
      catchError(() => loadConfig({ YOURLS_URL: URL, YOURLS_USERNAME: "admin" }, [])),
    );
    expect(message).toContain("YOURLS_USERNAME");
    expect(message).toContain("YOURLS_PASSWORD");
  });

  it("reports invalid fields without the rejected value or the signature", () => {
    const message = messageOf(
      catchError(() =>
        loadConfig(
          {
            YOURLS_URL: URL,
            YOURLS_SIGNATURE: KEY,
            PORT: "nope",
            MCP_TRANSPORT: "sse",
          },
          [],
        ),
      ),
    );
    expect(message).toContain("PORT");
    expect(message).toContain("MCP_TRANSPORT");
    expect(message).not.toContain(KEY);
    expect(message).not.toContain("nope");
    expect(message).not.toContain("sse");
  });
});
