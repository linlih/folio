import { record, type, write, nav, click, moveTo, drag, sleep } from "./lib.mjs";
import { seed } from "./seed.mjs";
const SIZE = { width: 1080, height: 680 };
const which = process.argv[2];
const D = 38; // ms per typed character

const scenes = {
  // Journal: an outline with a link, a tag and a task; then the linked card beside it.
  async write() {
    await record("write", SIZE, async (page) => { await seed(page); await nav(page, "Journal"); }, async (page) => {
      await click(page, page.locator(".journal-day.today .ProseMirror, .journal-day.today .journal-static").first());
      await page.keyboard.press("Meta+ArrowDown"); await page.keyboard.press("End"); await page.keyboard.press("Enter"); await page.waitForTimeout(300);
      await write(page, ["Call with [[Dana]] about the pricing table", "\tShe wants one plan on the home page #project"], D);
      await page.keyboard.press("Enter"); await page.waitForTimeout(250);
      await type(page, "/todo", D + 20); await page.waitForTimeout(500);
      await page.keyboard.press("Enter"); await page.waitForTimeout(250);
      await type(page, "Draft the new pricing copy", D);
      await page.waitForTimeout(700);
      await page.keyboard.down("Meta");
      await click(page, page.locator(".journal-day.today .ProseMirror a, .journal-day.today .ProseMirror .card-link").first(), { after: 200 });
      await page.keyboard.up("Meta");
      await page.waitForTimeout(2600);
    });
  },

  // A live query: pick a common one, tick a task in the results, see its text form.
  async query() {
    await record("query", SIZE, async (page) => { await seed(page); await nav(page, "Journal"); }, async (page) => {
      await click(page, page.locator(".journal-day.today .ProseMirror, .journal-day.today .journal-static").first());
      await page.keyboard.press("Meta+ArrowDown"); await page.keyboard.press("End"); await page.keyboard.press("Enter"); await page.waitForTimeout(300);
      await type(page, "/query", D + 30); await page.waitForTimeout(600);
      await page.keyboard.press("Enter"); await page.waitForTimeout(900);
      await click(page, page.locator(".query-preset", { hasText: "Tasks due within 7 days" }), { after: 350 });
      await click(page, page.locator(".query-done"), { after: 1600, ms: 300 });
      await click(page, page.locator(".query-block .task-list button, .query-block .task-list [role=checkbox]").first(), { after: 1300 });
      await moveTo(page, page.locator(".query-block .task-row").nth(2), { dx: 120 });
      await page.waitForTimeout(1800);
    });
  },
  // Whiteboard: cards dragged in from the library, joined by lines, then a
  // mind map grown from one of them.
  async board() {
    await record("board", { width: 1200, height: 700 }, async (page) => {
      await seed(page, { journal: false });
      await nav(page, "Whiteboards"); await page.getByText("New whiteboard").click(); await page.waitForTimeout(700);
      await page.locator("[aria-label='Split view']").click(); await page.waitForTimeout(500);
      await page.locator("[aria-label='Hide sidebar']").click(); await page.waitForTimeout(400);
      await page.locator(".pane").first().locator(".tab", { hasText: "Card library" }).click().catch(() => page.getByText("Card library").first().click());
      await page.waitForTimeout(600);
      await page.locator("[aria-label='List view']:visible").click(); await page.waitForTimeout(500);
      await page.mouse.move(300, 400); await page.mouse.wheel(0, 170); await page.waitForTimeout(600);
      if (process.env.PROBE) { await page.screenshot({ path: "probe-list.png" }); console.log(await page.$$eval("[draggable=true]", (x) => x.map((e) => e.className + ":" + e.textContent.slice(0, 24)))); }
    }, async (page) => {
      const tile = (n) => page.locator("[draggable=true]:visible").filter({ has: page.getByText(n, { exact: true }) }).first();
      const node = (n) => page.locator(".react-flow__node:visible").filter({ has: page.getByText(n, { exact: true }) }).first();
      await page.waitForTimeout(400);
      await drag(page, tile("Website redesign"), { x: 790, y: 330 });
      await drag(page, tile("Dana"), { x: 1150, y: 170 });
      await drag(page, tile("How to Take Smart Notes"), { x: 1150, y: 560 }, { ms: 800 });
      await page.waitForTimeout(400);
      if (process.env.PROBE) { await page.screenshot({ path: "probe-board.png" }); console.log(await page.$$eval(".react-flow__node", (x) => x.map((e) => e.className.slice(0, 80) + JSON.stringify(e.getBoundingClientRect())))); console.log(await page.$$eval(".board-handle", (x) => x.map((e) => e.className + e.dataset.handlepos + JSON.stringify(e.getBoundingClientRect())).slice(0, 8))); }
      const fit = () => click(page, "[aria-label='Show everything']:visible", { after: 900 });
      await fit();
      const handle = (n, pos) => node(n).locator(`.board-handle[data-handlepos=${pos}]`).first();
      await moveTo(page, node("Website redesign"));
      await drag(page, handle("Website redesign", "top"), handle("Dana", "left"), { ms: 700 });
      await moveTo(page, node("Website redesign"));
      await drag(page, handle("Website redesign", "bottom"), handle("How to Take Smart Notes", "left"), { ms: 700 });
      // A mind map grown from a card: Tab adds a subtopic, Enter the next one.
      await click(page, node("Dana"), { after: 400, dy: -20 });
      await page.keyboard.press("Tab"); await page.waitForTimeout(350);
      await type(page, "Ask about pricing", D); await page.waitForTimeout(300);
      await page.keyboard.press("Enter"); await page.waitForTimeout(300);
      await page.keyboard.press("Enter"); await page.waitForTimeout(350);
      await type(page, "Send wireframes", D); await page.waitForTimeout(300);
      await page.keyboard.press("Enter"); await page.waitForTimeout(400);
      await fit();
      await page.waitForTimeout(1800);
    });
  },
  async search() {
    await record("search", SIZE, async (page) => { await seed(page); await nav(page, "Journal"); }, async (page) => {
      await click(page, ".nav-search", { after: 500 });
      await type(page, "notes", D + 40); await page.waitForTimeout(1500);
      await page.keyboard.press("ArrowDown"); await page.waitForTimeout(500);
      await page.keyboard.press("Enter"); await page.waitForTimeout(2000);
    });
  },

  // Phone layout: quick capture, the task page, a card.
  async phone() {
    await record("phone", { width: 1280, height: 800 }, async (page) => {
      await seed(page); await nav(page, "Journal");
      await page.setViewportSize({ width: 390, height: 800 }); await page.waitForTimeout(900);
      await page.evaluate(() => { document.activeElement?.blur(); for (const e of document.querySelectorAll("*")) if (e.scrollTop > 0) e.scrollTop = 0; });
    }, async (page) => {
      const tab = (n) => click(page, page.locator(".phone-nav-item", { hasText: n }), { after: 900 });
      await page.waitForTimeout(600);
      await click(page, ".phone-capture", { after: 600 });
      await type(page, "Try a two-column pricing table", D); await page.keyboard.press("Enter");
      await type(page, "[ ] Call the printer about posters", D); await page.waitForTimeout(500);
      await click(page, page.getByRole("button", { name: "Save" }), { after: 1500 });
      await tab("Tasks"); await page.waitForTimeout(500);
      await click(page, page.locator(".task-status:visible").nth(1), { after: 1300 });
      await tab("Card library");
      await click(page, page.getByText("Website redesign", { exact: true }).last(), { after: 2200 });
    }, true);
  },
};
await scenes[which]();
