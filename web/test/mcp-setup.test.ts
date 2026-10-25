import { describe, expect, it } from "vitest";
import type { McpStatus } from "../src/bindings/commands";
import { CLIENTS, setup } from "../src/mcp/McpDialogs";

const status: McpStatus = { enabled: true, running: true, url: "http://127.0.0.1:39741/mcp", token: "abc123", clients: [], error: null };

describe("MCP setup for each AI tool", () => {
  it("every snippet has the address and the token", () => {
    for (const c of CLIENTS) {
      const text = setup(c, status);
      expect(text, c).toContain(status.url);
      expect(text, c).toContain("Bearer abc123");
    }
  });

  it("config files are valid", () => {
    const cursor = JSON.parse(setup("cursor", status));
    expect(cursor.mcpServers.folio).toEqual({ url: status.url, headers: { Authorization: "Bearer abc123" } });
    const vscode = JSON.parse(setup("vscode", status));
    expect(vscode.servers.folio.type).toBe("http");
    const desktop = JSON.parse(setup("claudeDesktop", status));
    expect(desktop.mcpServers.folio.args).toEqual(["-y", "mcp-remote", status.url, "--header", "Authorization:${FOLIO_AUTH}"]);
    expect(desktop.mcpServers.folio.env.FOLIO_AUTH).toBe("Bearer abc123");
    expect(setup("codex", status).split("\n")).toEqual([
      "[mcp_servers.folio]",
      `url = "${status.url}"`,
      'http_headers = { "Authorization" = "Bearer abc123" }',
    ]);
  });
});
