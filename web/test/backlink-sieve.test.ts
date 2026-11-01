import { describe, expect, it } from "vitest";
import type { Backlink } from "../src/bindings/commands";
import { byCard, sieve } from "../src/card/Backlinks";

const row = (cardId: string, cardTitle: string, bid: string, text: string, children?: Backlink["children"]): Backlink => ({ cardId, cardTitle, cardKind: "card", bid, text, via: "link", children });

describe("searching and sorting backlinks", () => {
  // As they come: the card edited last first.
  const groups = byCard([
    row("c1", "Zebra notes", "a", "Meeting about the launch"),
    row("c1", "Zebra notes", "b", "Lunch"),
    row("c2", "Apple", "c", "nothing here", [{ bid: "d", text: "a LAUNCH detail", depth: 1 }]),
    row("c3", "Launch plan", "e", "draft"),
  ]);
  const shape = (gs: ReturnType<typeof byCard>) => gs.map((g) => `${g.cardId}:${g.rows.map((r) => r.bid).join("")}`);

  it("keeps rows whose text, card name or nested blocks match, in any case", () => {
    expect(shape(sieve(groups, "launch", "recent"))).toEqual(["c1:a", "c2:c", "c3:e"]);
    expect(shape(sieve(groups, "  ", "recent"))).toEqual(["c1:ab", "c2:c", "c3:e"]);
    expect(sieve(groups, "nope", "recent")).toEqual([]);
  });

  it("sorts by edit time either way or by card name", () => {
    expect(shape(sieve(groups, "", "oldest"))).toEqual(["c3:e", "c2:c", "c1:ab"]);
    expect(shape(sieve(groups, "", "title"))).toEqual(["c2:c", "c3:e", "c1:ab"]);
  });
});
