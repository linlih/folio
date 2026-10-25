import { describe, expect, it } from "vitest";
import { bodyJson, initCard } from "../src/docs/card";
import { bind, device, settle, sync, typeText } from "./helpers";

/** The code blocks' languages, as stored in the Loro body. */
function languages(doc: ReturnType<typeof device>): (string | null)[] {
  const out: (string | null)[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const node = n as { nodeName?: string; attributes?: Record<string, unknown>; children?: unknown[] };
    if (node.nodeName === "codeBlock") out.push((node.attributes?.language as string | undefined) ?? null);
    node.children?.forEach(walk);
  };
  walk(bodyJson(doc));
  return out;
}

describe("code blocks", () => {
  it("```go makes a Go block; the language is stored and syncs", async () => {
    const aDoc = device(1n);
    initCard(aDoc, "note", "代码", 1);
    const a = await bind(aDoc);
    a.editor.commands.focus("end");
    typeText(a.editor, "```go ");
    typeText(a.editor, "func main() {}");
    await settle();
    expect(a.editor.getJSON().content?.find((n) => n.type === "codeBlock")?.attrs?.language).toBe("go");
    expect(languages(aDoc)).toEqual(["go"]);

    const bDoc = device(2n);
    sync(aDoc, bDoc);
    const b = await bind(bDoc);
    const block = b.editor.getJSON().content?.find((n) => n.type === "codeBlock");
    expect(block?.attrs?.language).toBe("go");
    expect(b.editor.state.doc.textContent).toContain("func main() {}");
  });

  it("highlights by language with lowlight", async () => {
    const doc = device(3n);
    initCard(doc, "note", "", 1);
    const { editor } = await bind(doc);
    editor.commands.setContent('<pre><code class="language-cpp">int main() { return 0; }</code></pre>');
    await settle();
    expect(editor.getJSON().content?.[0]?.attrs?.language).toBe("cpp");
    expect(editor.view.dom.querySelector(".hljs-keyword, .hljs-type")).not.toBeNull();
  });
});
