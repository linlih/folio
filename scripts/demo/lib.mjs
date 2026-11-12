// Records the README's demo clips from the browser build (in-memory data).
//   npm run dev                      (in another terminal)
//   cd scripts/demo && for s in write query board search; do node scenes.mjs $s && ./cut.sh $s; done
//   node stills.mjs && node phone.mjs
// Needs Playwright with WebKit (PLAYWRIGHT=/path/to/playwright/index.mjs if it
// is not installed here) and ffmpeg. FOLIO_URL: where the dev server is.
const { webkit } = await import(process.env.PLAYWRIGHT ?? "playwright");
const URL = process.env.FOLIO_URL ?? "http://localhost:5173/";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function open({ width = 1200, height = 750, video = null, scale = 1, dark = false } = {}) {
  const browser = await webkit.launch();
  const ctx = await browser.newContext({
    viewport: { width, height }, locale: "en-US", deviceScaleFactor: scale, colorScheme: dark ? "dark" : "light",
    ...(video ? { recordVideo: { dir: video, size: { width, height } } } : {}),
  });
  const page = await ctx.newPage();
  const t0 = Date.now();
  page.on("pageerror", (e) => console.log("PAGEERR", e.message));
  await page.goto(URL);
  await page.addStyleTag({ content: ".web-mode{display:none!important}" });
  await page.waitForTimeout(1200);
  return { browser, ctx, page, now: () => (Date.now() - t0) / 1000 };
}

/** Types a line the way a person would: [[Card]] picks from the link menu,
 *  #tag ends with a space. delay 0 = instant (setting up). */
export async function type(page, text, delay = 0) {
  const parts = text.split(/(\[\[[^\]]+\]\]|#[\w-]+)/);
  for (const p of parts) {
    if (!p) continue;
    if (p.startsWith("[[")) {
      const name = p.slice(2, -2);
      await put(page, "[[", delay);
      await put(page, name, delay);
      await page.waitForTimeout(delay ? 450 : 250);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(delay ? 250 : 80);
    } else if (p.startsWith("#")) {
      await put(page, p, delay);
      await page.waitForTimeout(delay ? 350 : 200);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(delay ? 200 : 80);
    } else await put(page, p, delay);
  }
}
async function put(page, s, delay) {
  if (!delay) return page.keyboard.insertText(s);
  for (const ch of s) { await page.keyboard.insertText(ch); await page.waitForTimeout(delay * (0.6 + Math.random() * 0.8)); }
}
export const nav = async (page, name) => { await page.locator(".nav-item", { hasText: name }).first().click(); await page.waitForTimeout(500); };

/** A card written through the editor (so links and tags are real). Lines
 *  starting with tabs are indented. */
export async function card(page, title, lines) {
  await page.locator(".nav-new").click(); await page.waitForTimeout(400);
  await page.keyboard.insertText(title); await page.keyboard.press("Enter"); await page.waitForTimeout(150);
  await write(page, lines);
}
export async function write(page, lines, delay = 0) {
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const want = lines[i].match(/^\t*/)[0].length;
    for (; depth < want; depth++) await page.keyboard.press("Tab");
    for (; depth > want; depth--) await page.keyboard.press("Shift+Tab");
    await type(page, lines[i].trim(), delay);
    if (i < lines.length - 1) { await page.keyboard.press("Enter"); await page.waitForTimeout(delay ? 200 : 40); }
  }
}

/** A drawn pointer (recordings have none) and smooth moves to an element. */
export async function pointer(page, touch = false) {
  await page.evaluate((touch) => {
    const c = document.createElement("div");
    c.id = "demo-cursor";
    c.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24"><path d="M5 3l14 8-6 1.5L10 19z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
    Object.assign(c.style, { position: "fixed", zIndex: 99999, pointerEvents: "none", left: "600px", top: "400px", margin: "-3px 0 0 -5px", transition: "transform .08s" });
    if (touch) { c.innerHTML = ""; Object.assign(c.style, { width: "26px", height: "26px", margin: "-13px 0 0 -13px", borderRadius: "50%", background: "rgba(40,40,40,.28)", border: "1.5px solid rgba(255,255,255,.7)", left: "195px", top: "500px" }); }
    document.body.appendChild(c);
    window.addEventListener("mousemove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
    window.addEventListener("mousedown", () => (c.style.transform = "scale(.8)"), true);
    window.addEventListener("mouseup", () => (c.style.transform = ""), true);
  }, touch);
  if (touch) at = { x: 195, y: 500 };
  await page.mouse.move(at.x, at.y);
}
let at = { x: 600, y: 400 };
export async function moveTo(page, target, { dx = 0, dy = 0, ms = 500 } = {}) {
  const loc = typeof target === "string" ? page.locator(target).first() : target;
  const b = await loc.boundingBox();
  const to = { x: b.x + b.width / 2 + dx, y: b.y + b.height / 2 + dy };
  const steps = Math.max(8, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    const k = i / steps, e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    await page.mouse.move(at.x + (to.x - at.x) * e, at.y + (to.y - at.y) * e);
    await page.waitForTimeout(16);
  }
  at = to;
  return to;
}
export async function click(page, target, opts = {}) {
  const to = await moveTo(page, target, opts);
  await page.waitForTimeout(140);
  await page.mouse.down(); await page.waitForTimeout(70); await page.mouse.up();
  await page.waitForTimeout(opts.after ?? 350);
  return to;
}
/** Runs a scene and writes out/<name>.webm cut to the scene itself. */
export async function record(name, size, setup, scene, touch = false) {
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");
  fs.rmSync(`raw/${name}`, { recursive: true, force: true });
  const s = await open({ ...size, video: `raw/${name}` });
  await setup(s.page);
  await pointer(s.page, touch);
  await s.page.waitForTimeout(500);
  const from = s.now();
  await scene(s.page);
  const to = s.now();
  await s.ctx.close(); await s.browser.close();
  const file = `raw/${name}/` + fs.readdirSync(`raw/${name}`)[0];
  fs.mkdirSync("out", { recursive: true });
  // The recording starts a little before the page loads; measured below.
  console.log(name, "scene", from.toFixed(1), "→", to.toFixed(1), file);
  fs.writeFileSync(`raw/${name}.json`, JSON.stringify({ file, from, to }));
}
