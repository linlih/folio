import { record, type, write, nav, click, moveTo, sleep } from "./lib.mjs";
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
  // Whiteboard: a mind map by keyboard, then an existing card beside it.
  async board() {
    await record("board", SIZE, async (page) => { await seed(page, { journal: false }); await nav(page, "Whiteboards"); await page.getByText("New whiteboard").click(); await page.waitForTimeout(800); }, async (page) => {
      await click(page, "[aria-label='Mind map']", { after: 500 });
      const topic = async (keys, text) => {
        for (const k of keys) { await page.keyboard.press(k); await page.waitForTimeout(260); }
        if (text) { await page.keyboard.press("Meta+a"); await type(page, text, D); await page.waitForTimeout(300); }
      };
      await topic([" "], "Website redesign");
      await topic(["Tab"], "Home page");
      await topic(["Tab"], "Hero copy");
      await topic(["Enter", "Enter"], "Pricing table");
      await topic(["Enter"], null);
      await click(page, page.locator(".board-mind", { hasText: "Home page" }), { after: 300 });
      await topic(["Enter"], "Blog");
      await topic(["Tab"], "Launch post");
      await topic(["Enter"], null);
      await page.waitForTimeout(500);
      await click(page, "[aria-label='Add an existing card']", { after: 500 });
      await type(page, "Dana", D + 20); await page.waitForTimeout(500);
      await click(page, page.locator(".board-add .popup-item").first(), { after: 900 });
      await page.keyboard.press("Escape");
      await click(page, "[aria-label='Show everything']", { after: 2400 });
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
