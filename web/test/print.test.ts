import { afterEach, describe, expect, it, vi } from "vitest";
import { backend } from "../src/platform";
import { exportPdf, placeContent } from "../src/print/print";

describe("exporting a PDF", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("saves a copy of the text, styled as on screen, without the editor's furniture", async () => {
    const save = vi.spyOn(backend, "exportPdf").mockResolvedValue("/tmp/My card.pdf");
    document.body.innerHTML = `<div id="root"><div class="view"><div class="page card-page"><div class="card-body-area">
      <div class="ProseMirror prose" contenteditable="true"><p contenteditable="true">Hello</p><button>×</button><div class="drag-handle"></div></div>
    </div></div></div></div>`;
    const body = document.querySelector(".ProseMirror");
    await exportPdf("My card", body);
    expect(save).toHaveBeenCalledWith("My card");
    const root = document.getElementById("print-root")!;
    expect(root.querySelector(".page.card-page > .print-title")?.textContent).toBe("My card");
    const copy = root.querySelector(".page.card-page > .card-body-area > .ProseMirror")!;
    expect(copy.textContent).toContain("Hello");
    expect(copy.querySelector("[contenteditable], button, .drag-handle")).toBeNull();
    // The screen's own editor is untouched.
    expect(body!.getAttribute("contenteditable")).toBe("true");

    // The next export replaces the copy.
    placeContent("Other", body);
    expect(document.querySelectorAll("#print-root .print-title")).toHaveLength(1);
  });

  it("saves nothing without a body", async () => {
    const save = vi.spyOn(backend, "exportPdf").mockResolvedValue(null);
    await exportPdf("x", null);
    expect(save).not.toHaveBeenCalled();
  });
});
