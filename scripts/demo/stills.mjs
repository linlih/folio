import { open, nav, write } from "./lib.mjs";
import { seed } from "./seed.mjs";
const today = async (page) => {
  await page.locator(".journal-day.today .ProseMirror, .journal-day.today .journal-static").first().click();
  await page.keyboard.press("Meta+ArrowDown"); await page.keyboard.press("End"); await page.keyboard.press("Enter");
  await write(page, ["Call with [[Dana]] about the pricing table", "\tShe wants one plan on the home page #project", "Idea: show the price per month first, see [[Website redesign]]"]);
};
{
  const { browser, page } = await open({ width: 1280, height: 800, scale: 2 });
  await seed(page); await nav(page, "Journal"); await today(page);
  await page.locator(".journal-date").first().click({ position: { x: 2, y: 2 } }).catch(() => {});
  await page.mouse.click(1250, 600); await page.waitForTimeout(500);
  await page.screenshot({ path: "out/journal.png" });
  await browser.close();
}
{
  const { browser, page } = await open({ width: 1280, height: 800, scale: 2, dark: true });
  await seed(page); await nav(page, "Card library"); await page.waitForTimeout(600);
  await page.screenshot({ path: "out/library-dark.png" });
  await browser.close();
}
{
  const { browser, page } = await open({ width: 1280, height: 800, scale: 1 });
  await seed(page, { journal: false });
  // Phone: the same data cannot be carried over (memory only), so seed at desktop width, then narrow.
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(800);
  await page.screenshot({ path: "out/phone-probe.png" });
  console.log(await page.$$eval(".phone-nav-item", (x) => x.map((e) => e.textContent)));
  await browser.close();
}
