import { card, nav, write } from "./lib.mjs";
export async function seed(page, { journal = true } = {}) {
  await card(page, "Zettelkasten", ["A box of small notes, each holding one idea and linked to the others.", "Luhmann wrote 90,000 of them and called the box his conversation partner.", "The value is in the links, not the folders. #method"]);
  await card(page, "Evergreen notes", ["Notes written to grow over time, across projects.", "One concept per note, titled as a claim when possible.", "Related: [[Zettelkasten]] #method"]);
  await card(page, "How to Take Smart Notes", ["Sönke Ahrens, 2017. #book", "Writing is not what follows research; it is the medium of it.", "Fleeting notes, literature notes, permanent notes.", "See [[Zettelkasten]] and [[Evergreen notes]]."]);
  await card(page, "Local-first software", ["Your data lives on your device; the network is optional.", "CRDTs let several devices edit and merge without conflicts. #idea"]);
  await card(page, "Website redesign", ["Goal: a faster, simpler home page by the end of the month. #project", "People: Dana (design), Leo (frontend)", "Open questions: pricing table, dark mode"]);
  await card(page, "Dana", ["Designer on [[Website redesign]].", "Prefers written feedback in the doc, not in chat."]);
  await card(page, "Weekly review", ["What moved forward this week?", "What is stuck, and what is the next step?", "What can be dropped?"]);
  await page.evaluate(async () => {
    const { notes } = await import("/src/app.ts");
    const day = (off) => { const d = new Date(); d.setDate(d.getDate() + off); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    const n = notes();
    await n.addTask(day(-1), "Send wireframe feedback", "human");
    await n.addTask(day(0), "Book a room for the design review", "human");
    await n.addTask(day(1), "Draft home page copy", "human");
    await n.addTask(day(2), "Compare three hosting options", "human");
    await n.addTask(day(4), "Finish the last two chapters", "human");
  });
  if (journal) {
    await nav(page, "Journal");
    const day = (i) => page.locator(".journal-day:not(.placeholder)").nth(i).locator(".journal-static, .ProseMirror").first();
    await day(2).click(); await page.waitForTimeout(400); await page.keyboard.press("End");
    await write(page, ["Kickoff for [[Website redesign]] with [[Dana]]", "\tAgreed on three directions for the home page", "\tDana shares wireframes on Thursday", "Read two chapters of [[How to Take Smart Notes]] #reading"]);
    await day(1).click(); await page.waitForTimeout(400); await page.keyboard.press("Meta+ArrowDown"); await page.keyboard.press("End"); await page.keyboard.press("Enter");
    await write(page, ["A note works best when it can stand alone #idea", "\tSame point as [[Evergreen notes]]", "Wireframe review went well, we picked direction B for [[Website redesign]]"]);
  }
  // Close the tabs opened on the way.
  for (let i = 0; i < 12; i++) {
    const tabs = page.locator(".tab-close, [aria-label='Close tab']");
    if ((await tabs.count()) <= 1) break;
    await tabs.last().click({ force: true }); await page.waitForTimeout(120);
  }
  await page.waitForTimeout(400);
}
