// M1a acceptance: two devices write the same journal day offline; after the
// merge both devices' text is there (design/ARCHITECTURE.md §4.5, §8).
import { describe, expect, it } from "vitest";
import { bodyLines, initCard } from "../src/docs/card";
import { bind, device, settle, sync } from "./helpers";

describe("same journal day on two devices", () => {
  it("keeps what both devices wrote", async () => {
    const phone = device(11n);
    const laptop = device(22n);
    // Each device starts the day on its own (deterministic id, no network).
    initCard(phone, "journal", "", 1);
    initCard(laptop, "journal", "", 2);
    const a = await bind(phone);
    const b = await bind(laptop);
    a.editor.commands.setContent("<ul><li><p>手机上写的</p></li></ul>");
    b.editor.commands.setContent("<ul><li><p>Written on the laptop</p></li></ul>");
    await settle();

    sync(phone, laptop);
    await settle();

    for (const doc of [phone, laptop]) {
      const lines = bodyLines(doc);
      expect(lines).toContain("手机上写的");
      expect(lines).toContain("Written on the laptop");
    }
    // The editors show the merged day too, and agree.
    expect(a.editor.getText()).toContain("Written on the laptop");
    expect(b.editor.getText()).toContain("手机上写的");
    expect(a.editor.getJSON()).toEqual(b.editor.getJSON());
  });

  it("keeps both when only the editors created the day (no initCard)", async () => {
    // The binding itself creates the body root on an empty document; the
    // vendored patch makes those containers mergeable.
    const phone = device(31n);
    const laptop = device(32n);
    const a = await bind(phone);
    const b = await bind(laptop);
    a.editor.commands.insertContent("from phone");
    b.editor.commands.insertContent("from laptop");
    await settle();
    sync(phone, laptop);
    await settle();
    const text = a.editor.getText();
    expect(text).toContain("from phone");
    expect(text).toContain("from laptop");
  });
});
