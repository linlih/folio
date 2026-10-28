import i18n from "i18next";
import { describe, expect, it } from "vitest";
import { commandErrorText, errorText } from "./status";

const zh = i18n.getFixedT("zh");

describe("sync errors", () => {
  it("words a tagged command failure in the interface's language", () => {
    expect(commandErrorText(zh, "[bad-code] this is not a sync code")).toBe(zh("sync.errorCode"));
    expect(commandErrorText(zh, "[wrong-passphrase] the passphrase does not open this workspace")).toBe(zh("sync.errorPassphrase"));
    expect(commandErrorText(zh, "[network] cannot reach the server (connection refused)")).toBe(zh("sync.errorNetwork"));
    expect(commandErrorText(zh, "[short-passphrase] too short")).toContain("8");
    expect(zh("sync.errorCode")).not.toBe("sync.errorCode");
  });

  it("keeps the host's wording for unknown kinds and untagged errors", () => {
    expect(commandErrorText(zh, "[other] conflict: something")).toBe("conflict: something");
    expect(commandErrorText(zh, new Error("plain"))).toBe("Error: plain");
    expect(commandErrorText(zh, "sync is not set up")).toBe("sync is not set up");
  });

  it("words the status line by its kind", () => {
    expect(errorText(zh, { error: "the server refused the token", errorKind: "unauthorized" })).toBe(zh("sync.errorUnauthorized"));
    expect(errorText(zh, { error: "database: locked", errorKind: "other" })).toBe("database: locked");
  });
});
