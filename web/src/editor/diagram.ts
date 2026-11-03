// Drawing a diagram from its Mermaid source (a code block in "mermaid"),
// with Pele (Obsidian's Mermaid renderer: small, no code run from the
// source, colours from CSS). Each kind of diagram is loaded the first time
// one is shown.

/** The font diagrams are measured and drawn in: the app's own. */
const font = () => getComputedStyle(document.documentElement).getPropertyValue("--font-ui").trim() || "sans-serif";

/** The diagram as SVG markup, or why it cannot be drawn. */
export async function drawDiagram(source: string): Promise<{ svg: string } | { error: string }> {
  try {
    const { renderAsync } = await import("pele/lazy");
    // No links or pictures from the source: it may come from a paste or
    // another device, and a picture would be fetched from the web.
    const { svg } = await renderAsync(source, { fontFamily: font(), links: false, images: false });
    return { svg };
  } catch (e) {
    const where = e && typeof e === "object" && "line" in e && typeof e.line === "number" && e.line > 0 ? ` (line ${e.line})` : "";
    const message = e instanceof Error ? e.message : String(e);
    return { error: message.split("\n").slice(0, 3).join("\n") + where };
  }
}
