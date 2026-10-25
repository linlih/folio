/**
 * Counts "silent drops": merged CRDT content that the binding could not turn
 * into a schema-valid ProseMirror node and therefore discarded, and how many
 * characters of text went with it (an empty list item is harmless; a
 * paragraph of text is data loss).
 *
 * - y-prosemirror deletes the offending Y item inside a ySyncPluginKey
 *   transaction while it renders a remote change (yjs.ts measures the text).
 * - loro-prosemirror catches the schema error in createNodeFromLoroObj,
 *   logs it with console.error and leaves the node out of the editor; the
 *   error message lists the content, which is where the text count comes from.
 */
export const drops = { count: 0, chars: 0, samples: [] as string[] };

export function recordDrop(detail: string, chars: number) {
  drops.count++;
  drops.chars += chars;
  if (drops.samples.length < 10) drops.samples.push(`${chars} chars: ${detail.slice(0, 200)}`);
}

/** Characters inside the quoted text runs of a ProseMirror Fragment string. */
function quotedChars(msg: string): number {
  let n = 0;
  for (const m of msg.matchAll(/"((?:[^"\\]|\\.)*)"/g)) n += m[1].length;
  return n;
}

let patched = false;

/** loro-prosemirror reports schema failures only through console.error. */
export function watchConsoleForLoroDrops() {
  if (patched) return;
  patched = true;
  const orig = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const first = args[0];
    if (first instanceof Error && /Invalid content|Invalid nodeName|Unknown node|No node type|Invalid text node|Empty text/i.test(first.message)) {
      recordDrop(first.message, quotedChars(first.message));
      return;
    }
    if (first === "Cannot find the loroNode") return; // cursor-mapping noise, not data
    orig(...args);
  };
}
