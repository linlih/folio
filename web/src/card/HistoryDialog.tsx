import { EditorContent, useEditor } from "@tiptap/react";
import { UndoManager, type LoroDoc } from "loro-crdt";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { docs } from "../app";
import { readMeta } from "../docs/card";
import { restoreTo, versionDoc, versions, type Version } from "../docs/history";
import type { DocHandle } from "../docs/hub";
import { isRemoteTx, LoroBinding } from "../editor/binding";
import { baseExtensions } from "../editor/extensions";
import { backend } from "../platform";
import { DialogFrame } from "../shell/Dialog";
import { useShell } from "../shell/tabs";
import { undoKey } from "./actions";
import "./history.css";

/** A card's earlier versions (docs/history.ts): pick one to read it as it
 *  was, and restore it as a new edit. */
export function HistoryDialog({ cardId }: { cardId: string }) {
  const { t, i18n } = useTranslation();
  const [handle, setHandle] = useState<DocHandle | null>(null);
  const [list, setList] = useState<Version[]>([]);
  const [chosen, setChosen] = useState(0);

  useEffect(() => {
    let gone = false;
    const hub = docs();
    void Promise.all([hub.open(cardId), backend.appInfo().catch(() => null)]).then(([h, info]) => {
      if (gone) return void hub.release(cardId);
      setHandle(h);
      setList(versions(h.doc, new Set([h.doc.peerIdStr, ...(info ? [info.frontendPeer, info.apiPeer, info.storePeer] : [])])));
    });
    return () => {
      gone = true;
      void hub.release(cardId);
    };
  }, [cardId]);

  const when = useMemo(() => new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }), [i18n.language]);
  const label = (v: Version) => (v.at === null ? t("history.undated") : when.format(v.at));
  const version = list[chosen];
  const old = useMemo(() => (handle && version ? versionDoc(handle.doc, version.frontiers) : null), [handle, version]);

  const restore = () => {
    if (!handle || !version) return;
    restoreTo(handle, version.frontiers);
    useShell.getState().setDialog(null);
    useShell.getState().setNotice(t("history.restored", { when: label(version), undo: undoKey() }));
  };

  return (
    <DialogFrame title={t("history.title")} description={t("history.description")} wide>
      <div className="history">
        <ol className="history-list">
          {list.map((v, i) => (
            <li key={i}>
              <button className="history-item" aria-pressed={i === chosen} onClick={() => setChosen(i)}>
                <span className="history-when">{label(v)}</span>
                <span className="history-who">{i === 0 ? t("history.current") : t(v.here ? "history.here" : "history.elsewhere")}</span>
              </button>
            </li>
          ))}
        </ol>
        <div className="history-preview">
          {old && (
            <>
              <h2 className="history-title">{readMeta(old).title || t("library.untitled")}</h2>
              <VersionBody key={chosen} doc={old} />
            </>
          )}
        </div>
      </div>
      <div className="history-actions">
        <button className="button primary" disabled={chosen === 0 || !version} onClick={restore}>
          {t("history.restore")}
        </button>
      </div>
    </DialogFrame>
  );
}

/** The body of a version, read-only, drawn by the same editor as cards. */
function VersionBody({ doc }: { doc: LoroDoc }) {
  const mode = readMeta(doc).editorMode;
  const editor = useEditor(
    {
      extensions: [...baseExtensions(isRemoteTx, "", mode), LoroBinding(doc, new UndoManager(doc, {}))],
      editable: false,
      immediatelyRender: false,
      editorProps: { attributes: { class: `prose card-body mode-${mode}` } },
    },
    [doc],
  );
  return <EditorContent editor={editor} />;
}
