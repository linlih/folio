import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { ArrowDown, ArrowUp, Calendar, CheckSquare, Hash as NumberIcon, Link, List, Plus, Type } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { appUndo } from "../app";
import { undoKey } from "../card/actions";
import { addField, deleteField, FIELD_TYPES, renameField, restoreField, setView, type DbView, type Field, type FieldType } from "../docs/database";
import { useShell } from "../shell/tabs";
import { editDatabase } from "./database";

export const TYPE_ICON: Record<FieldType, ReactNode> = {
  text: <Type size={13} />,
  number: <NumberIcon size={13} />,
  select: <List size={13} />,
  date: <Calendar size={13} />,
  checkbox: <CheckSquare size={13} />,
  url: <Link size={13} />,
};

/** "+": a new field, named and typed. */
export function AddField({ tag, label, count }: { tag: string; label?: string; count?: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<FieldType>("select");
  const add = async () => {
    const n = name.trim() || t(`db.type.${type}`);
    await editDatabase((doc) => addField(doc, tag, n, type));
    setOpen(false);
    setName("");
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={label ? "button db-add-field" : "icon-button db-add-field"} title={t("db.addField")} aria-label={t("db.addField")}>
        <Plus size={14} />
        {label}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4}>
          <Popover.Popup className="popup db-field-form">
            <input
              autoFocus
              value={name}
              placeholder={t("db.fieldName")}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  void add();
                }
              }}
            />
            {count !== undefined && <div className="db-field-scope">{t("db.fieldScope", { count, name: tag })}</div>}
            <div className="popup-label">{t("db.fieldType")}</div>
            {FIELD_TYPES.map((x) => (
              <button key={x} className="popup-item" aria-pressed={x === type} data-highlighted={x === type ? "" : undefined} onClick={() => setType(x)}>
                {TYPE_ICON[x]}
                {t(`db.type.${x}`)}
              </button>
            ))}
            <div className="db-field-form-actions">
              <button className="button primary" onClick={() => void add()}>
                {t("db.add")}
              </button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Removes a field as one undoable step: the values stay on the cards. */
export async function removeField(tag: string, field: Field, t: (k: string, o?: Record<string, unknown>) => string) {
  await editDatabase((doc) => deleteField(doc, tag, field.id));
  appUndo.push({
    label: "field",
    undo: () => editDatabase((doc) => restoreField(doc, tag, field.id)),
    redo: () => editDatabase((doc) => deleteField(doc, tag, field.id)),
  });
  useShell.getState().setNotice(t("db.fieldDeleted", { name: field.name, undo: undoKey() }));
}

/** A column's heading: its name, and a menu to sort by it, rename it or
 *  remove it. `field` null is the title column. */
export function FieldHeader({ tag, field, view, label }: { tag: string; field: Field | null; view: DbView; label: string }) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const key = field?.id ?? "title";
  const sorted = view.sortBy === key;
  const sort = (desc: boolean) => void editDatabase((doc) => setView(doc, tag, { sortBy: key, sortDesc: desc }));
  if (renaming && field) {
    return (
      <input
        className="db-rename"
        autoFocus
        defaultValue={field.name}
        onBlur={(e) => {
          const v = e.currentTarget.value;
          void editDatabase((doc) => renameField(doc, tag, field.id, v));
          setRenaming(false);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setRenaming(false);
        }}
      />
    );
  }
  return (
    <Menu.Root>
      <Menu.Trigger className="db-head">
        {field && TYPE_ICON[field.type]}
        <span>{label}</span>
        {sorted && (view.sortDesc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={4}>
          <Menu.Popup className="popup">
            <Menu.Item className="popup-item" onClick={() => sort(false)}>
              <ArrowUp size={14} />
              {t("db.sortAsc")}
            </Menu.Item>
            <Menu.Item className="popup-item" onClick={() => sort(true)}>
              <ArrowDown size={14} />
              {t("db.sortDesc")}
            </Menu.Item>
            {field && (
              <>
                <Menu.Separator className="popup-separator" />
                <Menu.Item className="popup-item" onClick={() => setRenaming(true)}>
                  {t("db.renameField")}
                </Menu.Item>
                <Menu.Item className="popup-item" onClick={() => void removeField(tag, field, t)}>
                  {t("db.deleteField")}
                </Menu.Item>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
