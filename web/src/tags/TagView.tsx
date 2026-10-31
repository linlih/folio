import { Menu } from "@base-ui/react/menu";
import { Columns3, Hash, MoreHorizontal, Rows3, Table2 } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Backlink } from "../bindings/commands";
import { byCard, Group } from "../card/Backlinks";
import { CARDS_CHANGED } from "../card/actions";
import { setView, tagKey, type ViewMode } from "../docs/database";
import { DOC_SAVED } from "../docs/persistence";
import { backend } from "../platform";
import { ChooseTopic, NameInput } from "../library/TopicGrid";
import { EmptyState } from "../shell/EmptyState";
import { useShell } from "../shell/tabs";
import { AddField } from "./Fields";
import { BoardView, TableView, useRows } from "./DatabaseViews";
import { editDatabase, useDatabase } from "./database";
import { cleanTagName, renameTag, validTagName } from "./rename";
import "../library/library.css";
import "./tags.css";

/** A tag's page (design/inbox-and-tags.md §3): its cards as a database, in
 *  a table or a board by a select field, or every block tagged with it,
 *  grouped by card (Logseq's tag page). */
export function TagView({ name, active }: { name: string; active: boolean }) {
  const { t } = useTranslation();
  const db = useDatabase(name);
  const [rows, change] = useRows(name, active);
  const mode = db?.view.mode ?? "blocks";
  const modes: { mode: ViewMode; icon: ReactNode }[] = [
    { mode: "table", icon: <Table2 size={14} /> },
    { mode: "board", icon: <Columns3 size={14} /> },
    { mode: "blocks", icon: <Rows3 size={14} /> },
  ];
  return (
    <div className={`page tag-page${mode === "blocks" ? "" : " wide"}`}>
      <header className="page-header">
        <TagTitle name={name} />
        {/* The table's count: it leaves out journal days, which 段落 counts below. */}
        {rows && mode !== "blocks" && <span className="page-meta">{t("db.cards", { count: rows.length })}</span>}
      </header>
      <div className="db-toolbar">
        <div className="db-modes" role="tablist">
          {modes.map((m) => (
            <button
              key={m.mode}
              role="tab"
              aria-selected={mode === m.mode}
              className={`db-mode${mode === m.mode ? " on" : ""}`}
              onClick={() => void editDatabase((doc) => setView(doc, name, { mode: m.mode }))}
            >
              {m.icon}
              {t(`db.mode.${m.mode}`)}
            </button>
          ))}
        </div>
        {mode !== "blocks" && db && <AddField tag={name} label={t("db.addField")} count={rows?.length} />}
      </div>
      {mode !== "blocks" && db && db.fields.length === 0 && rows && rows.length > 0 && <p className="sync-hint db-intro">{t("db.intro", { name })}</p>}
      {mode === "blocks" ? (
        <TaggedBlocks name={name} active={active} />
      ) : rows?.length === 0 ? (
        <EmptyState icon={<Hash size={28} strokeWidth={1.5} />} title={t("db.empty")} hint={t("db.emptyHint", { name })} />
      ) : (
        db &&
        rows &&
        (mode === "board" ? <BoardView tag={name} db={db} rows={rows} change={change} /> : <TableView tag={name} db={db} rows={rows} change={change} />)
      )}
    </div>
  );
}

/** The tag's name, with its menu: rename it (double-click too), or merge it
 *  into another tag. A new name already in use is a merge, asked first. */
function TagTitle({ name }: { name: string }) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const [asking, setAsking] = useState<{ kind: "merge"; to: string } | { kind: "choose"; tags: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const notice = useShell((s) => s.setNotice);

  const apply = async (to: string, merge: boolean) => {
    setAsking(null);
    setBusy(true);
    try {
      const count = await renameTag(name, to);
      useShell.getState().renameTag(name, to);
      notice(t(merge ? "tags.merged" : "tags.renamed", { count, from: name, to }));
    } catch (e) {
      notice(t("error.generic", { message: String(e) }));
    } finally {
      setBusy(false);
    }
  };
  const submit = async (typed: string) => {
    setRenaming(false);
    const to = cleanTagName(typed);
    if (!to || to === name) return;
    if (!validTagName(to)) return notice(t("tags.badName"));
    const taken = tagKey(to) !== tagKey(name) && (await backend.tags(100000)).some((x) => x.key === tagKey(to));
    if (taken) setAsking({ kind: "merge", to });
    else await apply(to, false);
  };
  const choose = async () => {
    const tags = (await backend.tags(100000)).filter((x) => x.key !== tagKey(name)).map((x) => x.name);
    setAsking({ kind: "choose", tags });
  };

  return (
    <>
      <h1 className="tag-title" data-page-title>
        <Hash size={22} strokeWidth={1.75} />
        {renaming ? (
          <NameInput initial={name} onDone={(v) => void submit(v)} big />
        ) : (
          <span onDoubleClick={() => !busy && setRenaming(true)}>{name}</span>
        )}
      </h1>
      {busy ? (
        <span className="page-meta">{t("tags.renaming")}</span>
      ) : (
        <Menu.Root>
          <Menu.Trigger className="icon-button" aria-label={t("tags.menu")} title={t("tags.menu")}>
            <MoreHorizontal size={16} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="start" sideOffset={4}>
              <Menu.Popup className="popup">
                <Menu.Item className="popup-item" onClick={() => setRenaming(true)}>
                  {t("tags.rename")}
                </Menu.Item>
                <Menu.Item className="popup-item" onClick={() => void choose()}>
                  {t("tags.merge")}
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      )}
      {asking?.kind === "merge" && (
        <div className="topic-confirm">
          <p>{t("tags.mergeConfirm", { from: name, to: asking.to })}</p>
          <button className="button" onClick={() => setAsking(null)}>
            {t("dialog.cancel")}
          </button>
          <button className="button primary" onClick={() => void apply(asking.to, true)}>
            {t("tags.mergeDo")}
          </button>
        </div>
      )}
      {asking?.kind === "choose" &&
        (asking.tags.length === 0 ? (
          <div className="topic-confirm">
            <p>{t("tags.mergeNone")}</p>
            <button className="button" onClick={() => setAsking(null)}>
              {t("dialog.close")}
            </button>
          </div>
        ) : (
          <ChooseTopic
            text={t("tags.mergeInto", { from: name })}
            options={asking.tags.map((x) => ({ id: x, label: `#${x}` }))}
            action={t("tags.mergeDo")}
            onCancel={() => setAsking(null)}
            onChoose={(to) => void apply(to, true)}
          />
        ))}
    </>
  );
}

/** Every block tagged with it, grouped by card, newest first. */
function TaggedBlocks({ name, active }: { name: string; active: boolean }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Backlink[] | null>(null);
  const load = useCallback(() => backend.tagged(name).then(setRows, () => setRows([])), [name]);
  useEffect(() => {
    if (!active) return;
    void load();
    const onChange = () => void load();
    window.addEventListener(CARDS_CHANGED, onChange);
    window.addEventListener(DOC_SAVED, onChange);
    return () => {
      window.removeEventListener(CARDS_CHANGED, onChange);
      window.removeEventListener(DOC_SAVED, onChange);
    };
  }, [active, load]);
  // A tagged block under another one shows there, not again on its own.
  const nested = new Set(rows?.flatMap((r) => (r.children ?? []).map((c) => `${r.cardId}:${c.bid}`)));
  const shown = rows?.filter((r) => !nested.has(`${r.cardId}:${r.bid}`));
  const groups = shown ? byCard(shown) : [];
  return (
    <>
      {shown && <p className="page-meta db-intro">{t("tags.count", { blocks: shown.length, cards: groups.length })}</p>}
      {rows?.length === 0 && <EmptyState icon={<Hash size={28} strokeWidth={1.5} />} title={t("tags.empty")} hint={t("tags.emptyHint", { name })} />}
      {groups.length > 0 && (
        <section className="backlinks tag-blocks">
          <ul>
            {groups.map((g) => (
              <Group key={g.cardId} group={g} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
