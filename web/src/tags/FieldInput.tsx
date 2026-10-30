import { Popover } from "@base-ui/react/popover";
import { Check, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PropValue } from "../docs/card";
import { addOption, type Field } from "../docs/database";
import { backend } from "../platform";
import { editDatabase } from "./database";

/** A select field's choice as a coloured chip. */
export function OptionChip({ field, id }: { field: Field; id: string }) {
  const o = field.options.find((x) => x.id === id);
  if (!o) return null;
  return <span className={`db-chip db-color-${o.color}`}>{o.name}</span>;
}

/** Edits one value of a card, by the field's type. Text-like values are
 *  saved when the box loses focus or on Enter, not on every key. */
export function FieldInput({ tag, field, value, onChange }: { tag: string; field: Field; value: PropValue | undefined; onChange: (v: PropValue) => void }) {
  switch (field.type) {
    case "checkbox":
      return <input type="checkbox" className="db-check" checked={value === true} aria-label={field.name} onChange={(e) => onChange(e.target.checked)} />;
    case "select":
      return <SelectInput tag={tag} field={field} value={typeof value === "string" ? value : null} onChange={onChange} />;
    case "number":
      return <TextInput type="number" field={field} value={typeof value === "number" ? String(value) : ""} onCommit={(s) => onChange(s.trim() === "" || !Number.isFinite(Number(s)) ? null : Number(s))} />;
    case "date":
      return <TextInput type="date" field={field} value={typeof value === "string" ? value : ""} onCommit={(s) => onChange(s || null)} />;
    case "url":
      return <UrlInput field={field} value={typeof value === "string" ? value : ""} onChange={onChange} />;
    default:
      return <TextInput type="text" field={field} value={typeof value === "string" ? value : value == null ? "" : String(value)} onCommit={(s) => onChange(s.trim() || null)} />;
  }
}

function TextInput({ type, field, value, onCommit }: { type: "text" | "number" | "date"; field: Field; value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  // Changed elsewhere (another device, the other pane) while not being typed in.
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onCommit(draft);
  return (
    <input
      className="db-input"
      type={type}
      value={draft}
      aria-label={field.name}
      onChange={(e) => {
        setDraft(e.target.value);
        // A date is picked, not typed: save it at once.
        if (type === "date") onCommit(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(value);
          setTimeout(() => (e.target as HTMLInputElement).blur());
        }
      }}
    />
  );
}

function UrlInput({ field, value, onChange }: { field: Field; value: string; onChange: (v: PropValue) => void }) {
  const { t } = useTranslation();
  const link = /^https?:\/\//i.test(value.trim());
  return (
    <span className="db-url">
      <TextInput type="text" field={field} value={value} onCommit={(s) => onChange(s.trim() || null)} />
      {link && (
        <button className="icon-button" title={t("inbox.openSource")} aria-label={t("inbox.openSource")} onClick={() => void backend.openLink(value.trim())}>
          <ExternalLink size={13} />
        </button>
      )}
    </span>
  );
}

/** Picks one choice, or types a new one. */
function SelectInput({ tag, field, value, onChange }: { tag: string; field: Field; value: string | null; onChange: (v: PropValue) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const shown = field.options.filter((o) => o.name.toLowerCase().includes(text.trim().toLowerCase()));
  const exact = field.options.find((o) => o.name.trim().toLowerCase() === text.trim().toLowerCase());
  const pick = (id: string | null) => {
    onChange(id === value ? null : id);
    setOpen(false);
    setText("");
  };
  const create = async () => {
    if (!text.trim()) return;
    if (exact) return pick(exact.id);
    const id = await editDatabase((doc) => addOption(doc, tag, field.id, text));
    if (id) pick(id);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="db-select" aria-label={field.name}>
        {value ? <OptionChip field={field} id={value} /> : <span className="db-empty">{t("db.choose")}</span>}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={4}>
          <Popover.Popup className="popup db-select-popup">
            <input
              className="db-select-search"
              autoFocus
              value={text}
              placeholder={t("db.optionPlaceholder")}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  void create();
                }
              }}
            />
            {shown.map((o) => (
              <button key={o.id} className="popup-item db-option" onClick={() => pick(o.id)}>
                <span className={`db-chip db-color-${o.color}`}>{o.name}</span>
                {o.id === value && <Check size={14} className="check" />}
              </button>
            ))}
            {text.trim() && !exact && (
              <button className="popup-item db-option" onClick={() => void create()}>
                {t("db.newOption", { name: text.trim() })}
              </button>
            )}
            {!text.trim() && field.options.length === 0 && <p className="db-hint">{t("db.noOptions")}</p>}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
