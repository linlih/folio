import { Columns3, Hash, Rows3, Table2 } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Backlink } from "../bindings/commands";
import { byCard, Group } from "../card/Backlinks";
import { CARDS_CHANGED } from "../card/actions";
import { setView, type ViewMode } from "../docs/database";
import { DOC_SAVED } from "../docs/persistence";
import { backend } from "../platform";
import { EmptyState } from "../shell/EmptyState";
import { AddField } from "./Fields";
import { BoardView, TableView, useRows } from "./DatabaseViews";
import { editDatabase, useDatabase } from "./database";
import "./tags.css";

/** A tag's page (design/inbox-and-tags.md §3): its cards as a database, in
 *  a table or a board by a select field, or every block tagged with it,
 *  grouped by card (Logseq's tag page). */
export function TagView({ name, active }: { name: string; active: boolean }) {
  const { t } = useTranslation();
  const db = useDatabase(name);
  const [rows, change] = useRows(name, active);
  const mode = db?.view.mode ?? "table";
  const modes: { mode: ViewMode; icon: ReactNode }[] = [
    { mode: "table", icon: <Table2 size={14} /> },
    { mode: "board", icon: <Columns3 size={14} /> },
    { mode: "blocks", icon: <Rows3 size={14} /> },
  ];
  return (
    <div className={`page tag-page${mode === "blocks" ? "" : " wide"}`}>
      <header className="page-header">
        <h1 className="tag-title">
          <Hash size={22} strokeWidth={1.75} />
          {name}
        </h1>
        {rows && <span className="page-meta">{t("db.cards", { count: rows.length })}</span>}
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
  const groups = rows ? byCard(rows) : [];
  return (
    <>
      {rows && <p className="page-meta db-intro">{t("tags.count", { blocks: rows.length, cards: groups.length })}</p>}
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
