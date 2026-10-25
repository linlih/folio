// A small floating panel next to something in the editor: a list to choose
// from (task status) or a field to fill in (link, image, date, formula).

import { computePosition, flip, offset, shift } from "@floating-ui/dom";

type Anchor = { getBoundingClientRect: () => DOMRect };

function place(el: HTMLElement, anchor: Anchor) {
  void computePosition(anchor, el, { placement: "bottom-start", middleware: [offset(6), flip(), shift({ padding: 8 })] }).then(({ x, y }) =>
    Object.assign(el.style, { left: `${x}px`, top: `${y}px` }),
  );
}

let open: (() => void) | null = null;

/** Closes whatever popover is open. */
export function closePopover() {
  open?.();
}

function mount(anchor: Anchor, build: (el: HTMLDivElement, done: () => void) => void) {
  closePopover();
  const el = document.createElement("div");
  el.className = "popup folio-popover";
  document.body.append(el);
  const outside = (e: MouseEvent) => !el.contains(e.target as Node) && done();
  const done = () => {
    el.remove();
    document.removeEventListener("mousedown", outside, true);
    if (open === done) open = null;
  };
  open = done;
  build(el, done);
  place(el, anchor);
  setTimeout(() => document.addEventListener("mousedown", outside, true));
}

export interface Option<T> {
  value: T;
  label: string;
  icon?: string;
  className?: string;
}

/** A list; resolves with the chosen value, or null when dismissed. */
export function chooseFrom<T>(anchor: Anchor, options: Option<T>[], current?: T): Promise<T | null> {
  return new Promise((resolve) => {
    mount(anchor, (el, done) => {
      let index = Math.max(0, options.findIndex((o) => o.value === current));
      const rows: HTMLButtonElement[] = [];
      const finish = (v: T | null) => {
        done();
        document.removeEventListener("keydown", keys, true);
        resolve(v);
      };
      const mark = () => rows.forEach((r, i) => r.classList.toggle("active", i === index));
      options.forEach((o, i) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = `popup-item suggest-item ${o.className ?? ""}`;
        row.innerHTML = `${o.icon ? `<span class="popover-icon">${o.icon}</span>` : ""}<span></span>`;
        row.lastElementChild!.textContent = o.label;
        row.addEventListener("mousedown", (e) => e.preventDefault());
        row.addEventListener("click", () => finish(o.value));
        row.addEventListener("mouseenter", () => ((index = i), mark()));
        rows.push(row);
        el.append(row);
      });
      mark();
      const keys = (e: KeyboardEvent) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          index = (index + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
          mark();
        } else if (e.key === "Enter") finish(options[index].value);
        else if (e.key === "Escape") finish(null);
        else return;
        e.preventDefault();
        e.stopPropagation();
      };
      document.addEventListener("keydown", keys, true);
      const prev = open!;
      open = () => {
        prev();
        document.removeEventListener("keydown", keys, true);
        resolve(null);
      };
    });
  });
}

/** A field; resolves with its value on Enter, or null when dismissed. */
export function askText(
  anchor: Anchor,
  opts: { label: string; value?: string; type?: "text" | "url" | "date"; multiline?: boolean; placeholder?: string },
): Promise<string | null> {
  return new Promise((resolve) => {
    mount(anchor, (el, done) => {
      el.classList.add("folio-ask");
      const label = document.createElement("label");
      label.textContent = opts.label;
      const field = opts.multiline ? document.createElement("textarea") : document.createElement("input");
      if (field instanceof HTMLInputElement) field.type = opts.type ?? "text";
      field.value = opts.value ?? "";
      field.placeholder = opts.placeholder ?? "";
      field.spellcheck = false;
      label.append(field);
      el.append(label);
      let settled = false;
      const finish = (v: string | null) => {
        if (settled) return;
        settled = true;
        done();
        resolve(v);
      };
      field.addEventListener("keydown", (e) => {
        const ke = e as KeyboardEvent;
        if (ke.isComposing) return;
        if (ke.key === "Enter" && (!opts.multiline || ke.metaKey || ke.ctrlKey)) {
          e.preventDefault();
          finish(field.value);
        } else if (ke.key === "Escape") {
          e.preventDefault();
          finish(null);
        }
      });
      if (field instanceof HTMLInputElement && field.type === "date") field.addEventListener("change", () => field.value && finish(field.value));
      const prev = open!;
      open = () => {
        prev();
        finish(null);
      };
      setTimeout(() => field.focus());
    });
  });
}

/** The position of the text cursor, as an anchor for a popover. */
export function caretAnchor(view: { coordsAtPos: (pos: number) => { left: number; right: number; top: number; bottom: number } }, pos: number): Anchor {
  return {
    getBoundingClientRect: () => {
      const c = view.coordsAtPos(pos);
      return new DOMRect(c.left, c.top, Math.max(1, c.right - c.left), c.bottom - c.top);
    },
  };
}
