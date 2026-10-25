// Editing formulas: a click on a math node opens its LaTeX source.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import i18n from "../i18n";
import { askText } from "./outliner/popover";

export const MathEditing = Extension.create({
  name: "mathEditing",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("mathEditing"),
        props: {
          handleClickOn(view, _pos, node, nodePos) {
            if (node.type.name !== "blockMath" && node.type.name !== "inlineMath") return false;
            const dom = view.nodeDOM(nodePos);
            if (!(dom instanceof HTMLElement)) return false;
            void askText(dom, { label: i18n.t("slash.mathEdit"), value: node.attrs.latex as string, multiline: true }).then((latex) => {
              const now = view.state.doc.nodeAt(nodePos);
              if (latex === null || !now || now.type !== node.type) return view.focus();
              view.dispatch(view.state.tr.setNodeAttribute(nodePos, "latex", latex));
              view.focus();
            });
            return true;
          },
        },
      }),
    ];
  },
});
