// Drawing a diagram from its Mermaid source (a code block in "mermaid").
// Mermaid is large, so it is loaded the first time a diagram is shown.

type Mermaid = typeof import("mermaid").default;

let loading: Promise<Mermaid> | null = null;
let theme = "";
let n = 0;

const dark = () => {
  const set = document.documentElement.dataset.theme;
  return set ? set === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
};

async function mermaid(): Promise<Mermaid> {
  loading ??= import("mermaid").then((m) => m.default);
  const m = await loading;
  const want = dark() ? "dark" : "neutral";
  if (want !== theme) {
    theme = want;
    // Strict: no scripts, links or HTML from the source (it may come from
    // a paste or another device).
    m.initialize({ startOnLoad: false, securityLevel: "strict", theme: want, fontFamily: "inherit" });
  }
  return m;
}

/** The diagram as SVG markup, or why it cannot be drawn. */
export async function drawDiagram(source: string): Promise<{ svg: string } | { error: string }> {
  try {
    const m = await mermaid();
    // Checked first: drawing a wrong source gives a picture of the error.
    await m.parse(source);
    const { svg } = await m.render(`folio-diagram-${++n}`, source);
    return { svg };
  } catch (e) {
    // Mermaid leaves its scratch element behind when the source is wrong.
    document.getElementById(`dfolio-diagram-${n}`)?.remove();
    const message = e instanceof Error ? e.message : String(e);
    return { error: message.split("\n").slice(0, 3).join("\n") };
  }
}
