import { describe, expect, it } from "vitest";
import { countWords } from "../src/docs/words";
import cases from "../../crates/folio-core/src/word_count_cases.json";

describe("countWords", () => {
  it("matches the cases the Rust count runs", () => {
    for (const [text, want] of cases as [string, number][]) expect(countWords(text), JSON.stringify(text)).toBe(want);
  });
});
