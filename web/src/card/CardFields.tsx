import { Menu } from "@base-ui/react/menu";
import { ChevronDown, ChevronRight, Hash } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { bodyFacts, readProps, setProp, type PropValue } from "../docs/card";
import { readDatabase, renameField, type Database, type Field } from "../docs/database";
import type { DocHandle } from "../docs/hub";
import { workspaceDoc } from "../docs/topics";
import { backend } from "../platform";
import { usePhone } from "../shell/phone";
import { useShell } from "../shell/tabs";
import { editDatabase } from "../tags/database";
import { AddField, removeField, TYPE_ICON } from "../tags/Fields";
import { FieldInput, OptionChip } from "../tags/FieldInput";
import "../tags/tags.css";

/** Which tags' fields are folded on cards, by tag key; a tag not in it
 *  follows the default (folded on a phone, open elsewhere). Per device. */
const FOLDS = "card.fieldFolds";
let folds: Record<string, boolean> | null = null;
const foldListeners = new Set<() => void>();

function useFolds(): Record<string, boolean> {
  const [, redraw] = useState(0);
  useEffect(() => {
    const again = () => redraw((n) => n + 1);
    foldListeners.add(again);
    if (folds === null)
      void backend
        .getLocalSetting<Record<string, boolean>>(FOLDS)
        .catch(() => null)
        .then((saved) => {
          folds ??= saved ?? {};
          foldListeners.forEach((l) => l());
        });
    return () => void foldListeners.delete(again);
  }, []);
  return folds ?? {};
}

function setFold(tag: string, folded: boolean) {
  folds = { ...folds, [tag.trim().toLowerCase()]: folded };
  foldListeners.forEach((l) => l());
  void backend.setLocalSetting(FOLDS, folds).catch(() => {});
}

const isEmpty = (v: PropValue | undefined) => v === undefined || v === null || v === "" || v === false;

/** Under the title: the card's database fields, for each of its tags that
 *  has any (design/inbox-and-tags.md §3). Values are written straight into
 *  the card's replica. Fields without a value wait behind "+N empty", and
 *  a tag's fields fold to one line of their values. */
export function CardFields({ handle }: { handle: DocHandle }) {
  const [tags, setTags] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, PropValue>>({});
  const [dbs, setDbs] = useState<{ tag: string; db: Database }[]>([]);

  // The tags in the body change as it is typed: read them after a pause.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      setTags(bodyFacts(handle.doc).tags);
      setValues(readProps(handle.doc));
    };
    read();
    const off = handle.doc.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(read, 250);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [handle]);

  useEffect(() => {
    let gone = false;
    let off = () => {};
    void workspaceDoc().then((ws) => {
      if (gone) return;
      const read = () => setDbs(tags.map((tag) => ({ tag, db: readDatabase(ws.doc, tag) })).filter((x) => x.db.fields.length > 0));
      read();
      off = ws.doc.subscribe(read);
    });
    return () => {
      gone = true;
      off();
    };
  }, [tags.join("\n")]);

  if (dbs.length === 0) return null;
  return (
    <div className="card-fields">
      {dbs.map(({ tag, db }) => (
        <FieldGroup
          key={tag}
          tag={tag}
          db={db}
          values={values}
          onChange={(f, v) => {
            setValues((x) => ({ ...x, [f.id]: v }));
            setProp(handle.doc, f.id, v);
          }}
        />
      ))}
    </div>
  );
}

function FieldGroup({
  tag,
  db,
  values,
  onChange,
}: {
  tag: string;
  db: Database;
  values: Record<string, PropValue>;
  onChange: (f: Field, v: PropValue) => void;
}) {
  const { t } = useTranslation();
  const phone = usePhone();
  const saved = useFolds()[tag.trim().toLowerCase()];
  const folded = saved ?? phone;
  const [showEmpty, setShowEmpty] = useState(false);
  // A field filled or cleared here stays where it is until the card closes.
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const shown = db.fields.filter((f) => showEmpty || touched.has(f.id) || !isEmpty(values[f.id]));
  const hidden = db.fields.length - shown.length;
  const filled = db.fields.filter((f) => !isEmpty(values[f.id]));
  const open = () => useShell.getState().open({ kind: "tag", name: tag });
  // How many cards a new field would show on, said where it is added.
  const [count, setCount] = useState<number>();
  useEffect(() => {
    if (folded) return;
    let gone = false;
    void backend.tagCards(tag).then((rows) => !gone && setCount(rows.length), () => {});
    return () => void (gone = true);
  }, [tag, folded]);

  return (
    <section className={`card-fields-group${folded ? " folded" : ""}`}>
      <div className="card-fields-head">
        <button
          className="card-fields-fold"
          aria-expanded={!folded}
          aria-label={t(folded ? "db.showFields" : "db.hideFields")}
          title={t(folded ? "db.showFields" : "db.hideFields")}
          onClick={() => setFold(tag, !folded)}
        >
          {folded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
        {/* Every card with the tag, in its table. */}
        <button className="card-fields-tag" title={t("db.openTag", { name: tag })} onClick={open}>
          <Hash size={12} />
          {tag}
        </button>
        {folded ? (
          <button className="card-fields-summary" onClick={() => setFold(tag, false)}>
            {filled.length === 0
              ? t("db.fieldCount", { count: db.fields.length })
              : filled.map((f) => (
                  <span key={f.id} className="card-fields-value" title={f.name}>
                    {f.type === "select" ? <OptionChip field={f} id={String(values[f.id])} /> : f.type === "checkbox" ? `✓ ${f.name}` : String(values[f.id])}
                  </span>
                ))}
          </button>
        ) : (
          <AddField tag={tag} label={t("db.addField")} count={count} />
        )}
      </div>
      {!folded && (
        <>
          {shown.map((f) => (
            <div key={f.id} className="card-field">
              <FieldName tag={tag} field={f} />
              <FieldInput
                tag={tag}
                field={f}
                value={values[f.id]}
                onChange={(v) => {
                  setTouched((x) => new Set(x).add(f.id));
                  onChange(f, v);
                }}
              />
            </div>
          ))}
          {hidden > 0 && (
            <button className="card-fields-more" onClick={() => setShowEmpty(true)}>
              {t("db.emptyFields", { count: hidden })}
            </button>
          )}
        </>
      )}
    </section>
  );
}

/** A field's name on a card: a menu to rename or remove it (it is the
 *  tag's field, so this changes it on every card with the tag). */
function FieldName({ tag, field }: { tag: string; field: Field }) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  if (renaming)
    return (
      <input
        className="card-field-name db-rename"
        autoFocus
        defaultValue={field.name}
        // Starts with the whole name selected, to type over it (after the
        // menu it came from has closed and handed focus back).
        ref={(el) => void (el && requestAnimationFrame(() => document.activeElement === el && el.select()))}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => {
          const v = e.currentTarget.value.trim();
          if (v && v !== field.name) void editDatabase((doc) => renameField(doc, tag, field.id, v));
          setRenaming(false);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setRenaming(false);
        }}
      />
    );
  return (
    <Menu.Root>
      <Menu.Trigger className="card-field-name">
        {TYPE_ICON[field.type]}
        <span>{field.name}</span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={4}>
          <Menu.Popup className="popup">
            <div className="popup-label">{t("db.fieldOfTag", { name: tag })}</div>
            <Menu.Item className="popup-item" onClick={() => setRenaming(true)}>
              {t("db.renameField")}
            </Menu.Item>
            <Menu.Item className="popup-item" onClick={() => void removeField(tag, field, t)}>
              {t("db.deleteField")}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
