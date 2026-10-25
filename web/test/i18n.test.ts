import { describe, expect, it } from "vitest";
import { systemLanguage } from "../src/i18n";
import en from "../src/i18n/locales/en.json";
import zh from "../src/i18n/locales/zh.json";

function keys(obj: object, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object" ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

describe("i18n", () => {
  it("has the same keys in every language", () => {
    expect(keys(zh).sort()).toEqual(keys(en).sort());
  });

  it("picks the first supported system language", () => {
    expect(systemLanguage(["zh-Hans-CN", "en-US"])).toBe("zh");
    expect(systemLanguage(["fr-FR", "en-GB"])).toBe("en");
    expect(systemLanguage(["fr-FR"])).toBe("en");
  });
});
