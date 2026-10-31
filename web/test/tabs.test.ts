import { beforeEach, describe, expect, it } from "vitest";
import { focusedPane, useShell } from "../src/shell/tabs";

const initial = useShell.getState();
const keys = (i = 0) => useShell.getState().panes[i].tabs.map((t) => t.key);
const pane = (i: number) => useShell.getState().panes[i];
const focused = () => focusedPane(useShell.getState());

describe("tabs", () => {
  beforeEach(() => useShell.setState(initial, true));

  it("switches to an open tab instead of opening it twice", () => {
    const { open } = useShell.getState();
    open({ kind: "card", cardId: "a" }, "A");
    open({ kind: "library" });
    open({ kind: "card", cardId: "a" }, "A");
    expect(keys()).toEqual(["library", "card:a"]);
    expect(focused().active).toBe("card:a");
  });

  it("follows a tag to its new name, or into the tag it merged with", () => {
    const { open, renameTag } = useShell.getState();
    open({ kind: "tag", name: "想法" });
    renameTag("想法", "灵感");
    expect(keys()).toEqual(["library", "tag:灵感"]);
    expect(focused().active).toBe("tag:灵感");
    expect(focused().tabs[1].target).toEqual({ kind: "tag", name: "灵感" });
    // Merged into a tag whose page is open: one tab left, the merged one.
    open({ kind: "tag", name: "idea" });
    renameTag("idea", "灵感");
    expect(keys()).toEqual(["library", "tag:灵感"]);
    expect(focused().active).toBe("tag:灵感");
    // Only the case changed: same tab, new spelling.
    renameTag("灵感", "灵感");
    open({ kind: "tag", name: "Todo" });
    renameTag("Todo", "TODO");
    expect(keys()).toEqual(["library", "tag:灵感", "tag:todo"]);
    expect(focused().tabs[2].target).toEqual({ kind: "tag", name: "TODO" });
  });

  it("opens new tabs after the active one", () => {
    const { open, activate } = useShell.getState();
    open({ kind: "card", cardId: "a" });
    open({ kind: "card", cardId: "b" });
    activate("library");
    open({ kind: "journal" });
    expect(keys()).toEqual(["library", "journal", "card:a", "card:b"]);
  });

  it("activates a neighbour when the active tab closes, and never leaves none", () => {
    const { open, close } = useShell.getState();
    open({ kind: "card", cardId: "a" });
    open({ kind: "card", cardId: "b" });
    close("card:b");
    expect(focused().active).toBe("card:a");
    close("card:a");
    close("library");
    expect(keys()).toEqual(["library"]);
  });

  it("remembers recent cards, newest first, without duplicates", () => {
    const { open } = useShell.getState();
    open({ kind: "card", cardId: "a" }, "A");
    open({ kind: "card", cardId: "b" }, "B");
    open({ kind: "card", cardId: "a" }, "A");
    expect(useShell.getState().recent.map((r) => r.cardId)).toEqual(["a", "b"]);
  });
});

describe("split view", () => {
  beforeEach(() => useShell.setState(initial, true));

  it("opens to the side in a new right pane, which takes focus", () => {
    const { open } = useShell.getState();
    open({ kind: "card", cardId: "a" }, "A");
    open({ kind: "card", cardId: "b" }, "B", true);
    expect(useShell.getState().panes).toHaveLength(2);
    expect(keys(0)).toEqual(["library", "card:a"]);
    expect(keys(1)).toEqual(["card:b"]);
    expect(useShell.getState().focused).toBe(pane(1).id);
  });

  it("opens in the focused pane, and to the side goes back the other way", () => {
    const { open, focusPane } = useShell.getState();
    open({ kind: "card", cardId: "b" }, "B", true);
    open({ kind: "card", cardId: "c" }, "C");
    expect(keys(1)).toEqual(["card:b", "card:c"]);
    open({ kind: "card", cardId: "d" }, "D", true);
    expect(keys(0)).toEqual(["library", "card:d"]);
    focusPane(pane(1).id);
    open({ kind: "journal" });
    expect(keys(1)).toEqual(["card:b", "card:c", "journal"]);
    expect(useShell.getState().panes).toHaveLength(2);
  });

  it("lets the same card be open in both panes", () => {
    const { open } = useShell.getState();
    open({ kind: "card", cardId: "a" }, "A");
    open({ kind: "card", cardId: "a" }, "A", true);
    expect(keys(0)).toContain("card:a");
    expect(keys(1)).toEqual(["card:a"]);
  });

  it("closing a pane's last tab removes the pane", () => {
    const { open, close } = useShell.getState();
    open({ kind: "card", cardId: "b" }, "B", true);
    close("card:b", pane(1).id);
    expect(useShell.getState().panes).toHaveLength(1);
    expect(useShell.getState().focused).toBe(pane(0).id);
  });

  it("closing the left pane's last tab keeps the right pane, now alone", () => {
    const { open, close } = useShell.getState();
    open({ kind: "card", cardId: "b" }, "B", true);
    const right = pane(1).id;
    close("library", pane(0).id);
    expect(useShell.getState().panes.map((p) => p.id)).toEqual([right]);
  });

  it("moves a tab to the other side", () => {
    const { open, moveToOther } = useShell.getState();
    open({ kind: "card", cardId: "a" }, "A");
    moveToOther("card:a", pane(0).id);
    expect(keys(0)).toEqual(["library"]);
    expect(keys(1)).toEqual(["card:a"]);
  });

  it("Mod+\\ splits with the current tab, and joins the panes back", () => {
    const { open, toggleSplit } = useShell.getState();
    open({ kind: "card", cardId: "a" }, "A");
    toggleSplit();
    expect(keys(1)).toEqual(["card:a"]);
    useShell.getState().open({ kind: "card", cardId: "b" }, "B");
    useShell.getState().toggleSplit();
    expect(useShell.getState().panes).toHaveLength(1);
    expect(keys(0)).toEqual(["library", "card:a", "card:b"]);
    expect(focused().active).toBe("card:b");
  });

  it("renames and forgets a card in both panes", () => {
    const { open, renameCard, forgetCard } = useShell.getState();
    open({ kind: "card", cardId: "a" }, "A");
    open({ kind: "card", cardId: "a" }, "A", true);
    renameCard("a", "Renamed");
    expect(pane(1).tabs[0].title).toBe("Renamed");
    forgetCard("a");
    expect(useShell.getState().panes).toHaveLength(1);
    expect(keys(0)).toEqual(["library"]);
  });

  it("restores a saved layout, keeping the divider in range", () => {
    useShell.getState().restore({
      panes: [
        { id: "x", tabs: [{ key: "journal", target: { kind: "journal" }, title: null }], active: "journal" },
        { id: "y", tabs: [{ key: "card:a", target: { kind: "card", cardId: "a" }, title: "A" }], active: "gone" },
      ],
      focused: "y",
      split: 0.95,
    });
    const s = useShell.getState();
    expect(s.panes.map((p) => p.active)).toEqual(["journal", "card:a"]);
    expect(s.focused).toBe(s.panes[1].id);
    expect(s.split).toBe(0.8);
  });

  describe("dragging a tab", () => {
    it("reorders within a tab bar", () => {
      const { open, moveTab } = useShell.getState();
      open({ kind: "card", cardId: "a" });
      open({ kind: "card", cardId: "b" });
      const id = pane(0).id;
      moveTab("card:b", id, { pane: id, index: 0 });
      expect(keys()).toEqual(["card:b", "library", "card:a"]);
      // Dropped just after itself: nothing moves.
      moveTab("card:b", id, { pane: id, index: 1 });
      expect(keys()).toEqual(["card:b", "library", "card:a"]);
      moveTab("card:b", id, { pane: id });
      expect(keys()).toEqual(["library", "card:a", "card:b"]);
    });

    it("moves a tab to the other pane at the drop place", () => {
      const { open, moveTab, toggleSplit } = useShell.getState();
      open({ kind: "card", cardId: "a" });
      open({ kind: "card", cardId: "b" });
      toggleSplit(); // right pane: card:b
      const [left, right] = [pane(0).id, pane(1).id];
      moveTab("card:a", left, { pane: right, index: 0 });
      expect(keys(0)).toEqual(["library", "card:b"]);
      expect(keys(1)).toEqual(["card:a", "card:b"]);
      expect(focused().id).toBe(right);
      expect(focused().active).toBe("card:a");
    });

    it("drops the pane it emptied, and keeps one tab per card in a pane", () => {
      const { open, moveTab, toggleSplit } = useShell.getState();
      open({ kind: "card", cardId: "a" });
      toggleSplit(); // both panes show card:a
      const [left, right] = [pane(0).id, pane(1).id];
      moveTab("card:a", right, { pane: left, index: 0 });
      expect(useShell.getState().panes).toHaveLength(1);
      expect(keys(0)).toEqual(["card:a", "library"]);
    });

    it("splits off into a new pane, but not the only tab", () => {
      const { open, moveTab } = useShell.getState();
      const id = pane(0).id;
      moveTab("library", id, { newPane: true });
      expect(useShell.getState().panes).toHaveLength(1);
      open({ kind: "card", cardId: "a" });
      moveTab("card:a", id, { newPane: true });
      expect(keys(0)).toEqual(["library"]);
      expect(keys(1)).toEqual(["card:a"]);
      expect(focused().id).toBe(pane(1).id);
    });
  });

  describe("the card library is in one pane only", () => {
    it("opening it on the other side goes to where it is", () => {
      const { open, toggleSplit } = useShell.getState();
      open({ kind: "card", cardId: "a" }, "A");
      toggleSplit(); // right pane: card:a
      expect(focused().id).toBe(pane(1).id);
      open({ kind: "library" });
      expect(keys(1)).toEqual(["card:a"]);
      expect(focused().id).toBe(pane(0).id);
      expect(focused().active).toBe("library");
      // Asked for beside the pane that holds it: it moves over (one copy).
      open({ kind: "library" }, null, true);
      expect(keys(1)).toEqual(["card:a", "library"]);
      expect(keys(0)).not.toContain("library");
    });

    it("asked for beside the pane that holds it, it moves across", () => {
      const { open } = useShell.getState();
      open({ kind: "card", cardId: "a" }, "A");
      open({ kind: "library" }, null, true);
      expect(keys(0)).toEqual(["card:a"]);
      expect(keys(1)).toEqual(["library"]);
      expect(focused().id).toBe(pane(1).id);
    });

    it("splitting from it shows the latest card on the other side", () => {
      const { open, activate, toggleSplit } = useShell.getState();
      open({ kind: "card", cardId: "a" }, "A");
      activate("library");
      toggleSplit();
      expect(keys(0)).toEqual(["library", "card:a"]);
      expect(keys(1)).toEqual(["card:a"]);
    });

    it("splitting from it with no card opened yet shows the journal", () => {
      useShell.getState().toggleSplit();
      expect(keys(1)).toEqual(["journal"]);
    });

    it("a saved layout with it in both panes keeps the first", () => {
      const lib = { key: "library", target: { kind: "library" as const }, title: null };
      const card = { key: "card:a", target: { kind: "card" as const, cardId: "a" }, title: "A" };
      useShell.getState().restore({
        panes: [
          { id: "x", tabs: [lib], active: "library" },
          { id: "y", tabs: [lib, card], active: "library" },
        ],
        focused: "y",
        split: 0.5,
      });
      expect(keys(0)).toEqual(["library"]);
      expect(keys(1)).toEqual(["card:a"]);
      expect(pane(1).active).toBe("card:a");
    });
  });
});
