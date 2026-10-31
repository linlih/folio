import { Menu } from "@base-ui/react/menu";
import { ArrowDown, ArrowUp, MoreHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CARDS_CHANGED } from "../card/actions";
import type { PropValue } from "../docs/card";
import { addField, addOption, boardField, groupRows, setView, sortRows, toRow, type Database, type DbRow, type Field } from "../docs/database";
import { DOC_SAVED } from "../docs/persistence";
import { backend } from "../platform";
import { toSide, useShell } from "../shell/tabs";
import { AddField, FieldHeader } from "./Fields";
import { FieldInput, OptionChip } from "./FieldInput";
import { editDatabase, newDatabaseCard, setCardValue } from "./database";

/** The cards of a tag's database, reloaded as cards change. */
export function useRows(tag: string, active: boolean): [DbRow[] | null, (id: string, field: string, v: PropValue) => void] {
  const [rows, setRows] = useState<DbRow[] | null>(null);
  const load = useCallback(() => backend.tagCards(tag).then((r) => setRows(r.map(toRow)), () => setRows([])), [tag]);
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
  // Shown at once; the card's own save reloads the list after.
  const change = (id: string, field: string, v: PropValue) => {
    setRows((rs) => rs && rs.map((r) => (r.id === id ? { ...r, values: { ...r.values, [field]: v } } : r)));
    void setCardValue(id, field, v).catch((e) => useShell.getState().setNotice(String(e)));
  };
  return [rows, change];
}

/** A row's last line: a title typed here becomes a new card in the database. */
function NewRow({ tag, values, placeholder }: { tag: string; values?: Record<string, PropValue>; placeholder: string }) {
  const [text, setText] = useState("");
  return (
    <input
      className="db-new"
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={async (e) => {
        if (e.nativeEvent.isComposing || e.key !== "Enter" || !text.trim()) return;
        const title = text.trim();
        setText("");
        await newDatabaseCard(tag, title, values);
      }}
    />
  );
}

export function TableView({ tag, db, rows, change }: { tag: string; db: Database; rows: DbRow[]; change: (id: string, field: string, v: PropValue) => void }) {
  const { t, i18n } = useTranslation();
  const open = useShell((s) => s.open);
  const sorted = useMemo(() => sortRows(rows, db.fields, db.view, i18n.language), [rows, db, i18n.language]);
  return (
    <div className="db-table-wrap">
      <table className="db-table">
        <thead>
          <tr>
            <th className="db-title-col">
              <FieldHeader tag={tag} field={null} view={db.view} label={t("db.titleColumn")} />
            </th>
            {db.fields.map((f) => (
              <th key={f.id}>
                <FieldHeader tag={tag} field={f} view={db.view} label={f.name} />
              </th>
            ))}
            <th className="db-add-col">
              <AddField tag={tag} count={rows.length} />
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.id}>
              <td className="db-title-col">
                <button className="db-open" onClick={(e) => open({ kind: "card", cardId: r.id }, r.title, toSide(e))}>
                  {r.title || t("library.untitled")}
                </button>
              </td>
              {db.fields.map((f) => (
                <td key={f.id}>
                  <FieldInput tag={tag} field={f} value={r.values[f.id]} onChange={(v) => change(r.id, f.id, v)} />
                </td>
              ))}
              <td />
            </tr>
          ))}
          <tr>
            <td className="db-title-col" colSpan={db.fields.length + 2}>
              <NewRow tag={tag} placeholder={t("db.newRow")} />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const ROW_MIME = "application/x-folio-db-row";

/** Columns by a select field's choices. Cards move by dragging (mouse) or
 *  through each card's menu (touch). */
/** What the cards are ordered by, and which way: the same order as the
 *  table's (a column heading sets it there), kept with the tag's view. */
function SortControl({ tag, db }: { tag: string; db: Database }) {
  const { t } = useTranslation();
  const set = (view: { sortBy?: string; sortDesc?: boolean }) => void editDatabase((doc) => setView(doc, tag, view));
  const keys = [
    { id: "created", name: t("db.sortCreated") },
    { id: "updated", name: t("db.sortUpdated") },
    { id: "title", name: t("db.titleColumn") },
    ...db.fields.map((f) => ({ id: f.id, name: f.name })),
  ];
  const current = keys.some((k) => k.id === db.view.sortBy) ? db.view.sortBy : "created";
  const desc = db.view.sortDesc;
  return (
    <div className="db-sort">
      <label className="db-bar-select">
        {t("db.sortBy")}
        <select value={current} onChange={(e) => set({ sortBy: e.target.value })}>
          {keys.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
            </option>
          ))}
        </select>
      </label>
      <button className="icon-button db-sort-dir" aria-label={t(desc ? "db.sortDesc" : "db.sortAsc")} title={t(desc ? "db.sortDesc" : "db.sortAsc")} onClick={() => set({ sortDesc: !desc })}>
        {desc ? <ArrowDown size={14} /> : <ArrowUp size={14} />}
      </button>
    </div>
  );
}

export function BoardView({ tag, db, rows, change }: { tag: string; db: Database; rows: DbRow[]; change: (id: string, field: string, v: PropValue) => void }) {
  const { t, i18n } = useTranslation();
  const open = useShell((s) => s.open);
  const [over, setOver] = useState<string | null>(null);
  const field = boardField(db);
  if (!field) {
    // A board needs a select field: offer the usual one.
    const make = () =>
      editDatabase((doc) => {
        const id = addField(doc, tag, t("db.status"), "select");
        for (const name of [t("db.statusTodo"), t("db.statusDoing"), t("db.statusDone")]) addOption(doc, tag, id, name);
        setView(doc, tag, { groupBy: id });
      });
    return (
      <div className="db-board-empty">
        <p>{t("db.boardNeedsSelect")}</p>
        <button className="button primary" onClick={() => void make()}>
          {t("db.addStatus")}
        </button>
      </div>
    );
  }
  const selects = db.fields.filter((f) => f.type === "select");
  const columns = groupRows(sortRows(rows, db.fields, db.view, i18n.language), field);
  const move = (id: string, option: string | null) => change(id, field.id, option);
  return (
    <>
      <div className="db-board-bar">
        <label className="db-bar-select">
          {t("db.groupBy")}
          <select value={field.id} onChange={(e) => void editDatabase((doc) => setView(doc, tag, { groupBy: e.target.value }))}>
            {selects.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <SortControl tag={tag} db={db} />
      </div>
      {selects.length === 1 && <p className="db-bar-hint">{t("db.groupByHint")}</p>}
      <div className="db-board">
        {columns.map(({ option, rows: cards }) => {
          const key = option?.id ?? "";
          return (
            <section
              key={key || "none"}
              className={`db-column${over === key ? " over" : ""}`}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(ROW_MIME)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setOver(key);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
              }}
              onDrop={(e) => {
                const id = e.dataTransfer.getData(ROW_MIME);
                setOver(null);
                if (id) {
                  e.preventDefault();
                  move(id, option?.id ?? null);
                }
              }}
            >
              <h3 className="db-column-head">
                {option ? <OptionChip field={field} id={option.id} /> : <span className="db-empty">{t("db.noValue", { name: field.name })}</span>}
                <span className="db-count">{cards.length}</span>
              </h3>
              {cards.map((r) => (
                // The menu sits beside the draggable card, not in it: a
                // draggable element keeps a press from opening a menu.
                <div key={r.id} className="db-card-wrap">
                  <article
                    className="db-card"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(ROW_MIME, r.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                  >
                    <button className="db-card-open" onClick={(e) => open({ kind: "card", cardId: r.id }, r.title, toSide(e))}>
                      <span className="db-card-title">{r.title || t("library.untitled")}</span>
                      {r.preview && <span className="db-card-preview">{r.preview}</span>}
                    </button>
                    <BoardFields db={db} skip={field} row={r} />
                  </article>
                  <Menu.Root>
                    <Menu.Trigger className="icon-button db-card-menu" aria-label={t("db.moveTo")} title={t("db.moveTo")}>
                      <MoreHorizontal size={14} />
                    </Menu.Trigger>
                    <Menu.Portal>
                      <Menu.Positioner side="bottom" align="end" sideOffset={4}>
                        <Menu.Popup className="popup">
                          <div className="popup-label">{t("db.moveTo")}</div>
                          {field.options.map((o) => (
                            <Menu.Item key={o.id} className="popup-item" disabled={r.values[field.id] === o.id} onClick={() => move(r.id, o.id)}>
                              <span className={`db-chip db-color-${o.color}`}>{o.name}</span>
                            </Menu.Item>
                          ))}
                          <Menu.Item className="popup-item" onClick={() => move(r.id, null)}>
                            {t("db.noValue", { name: field.name })}
                          </Menu.Item>
                        </Menu.Popup>
                      </Menu.Positioner>
                    </Menu.Portal>
                  </Menu.Root>
                </div>
              ))}
              <NewRow tag={tag} values={option ? { [field.id]: option.id } : {}} placeholder={t("db.newCard")} />
            </section>
          );
        })}
      </div>
    </>
  );
}

/** A board card's other filled values, read-only and short. */
function BoardFields({ db, skip, row }: { db: Database; skip: Field; row: DbRow }) {
  const { t } = useTranslation();
  const shown = db.fields.filter((f) => f.id !== skip.id && row.values[f.id] !== undefined && row.values[f.id] !== null && row.values[f.id] !== false);
  if (shown.length === 0) return null;
  return (
    <span className="db-card-fields">
      {shown.slice(0, 4).map((f) => (
        <span key={f.id} className="db-card-field" title={f.name}>
          {f.type === "select" ? <OptionChip field={f} id={String(row.values[f.id])} /> : f.type === "checkbox" ? `✓ ${f.name}` : String(row.values[f.id])}
        </span>
      ))}
      {shown.length > 4 && <span className="db-card-field">{t("db.more", { count: shown.length - 4 })}</span>}
    </span>
  );
}


