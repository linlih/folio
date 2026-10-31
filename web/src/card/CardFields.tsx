import { Hash, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { bodyFacts, readProps, setProp, type PropValue } from "../docs/card";
import { readDatabase, type Database } from "../docs/database";
import type { DocHandle } from "../docs/hub";
import { workspaceDoc } from "../docs/topics";
import { useShell } from "../shell/tabs";
import { FieldInput } from "../tags/FieldInput";
import "../tags/tags.css";

/** Under the title: the card's database fields, for each of its tags that
 *  has any (design/inbox-and-tags.md §3). Values are written straight into
 *  the card's replica. */
export function CardFields({ handle }: { handle: DocHandle }) {
  const { t } = useTranslation();
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
  const open = (tag: string) => useShell.getState().open({ kind: "tag", name: tag });
  return (
    <div className="card-fields">
      {dbs.map(({ tag, db }) => (
        <section key={tag} className="card-fields-group">
          {/* Fields belong to the tag, not the card: they are added, renamed
              and removed on the tag's page, where every card they affect is. */}
          <div className="card-fields-head">
            <button className="card-fields-tag" onClick={() => open(tag)}>
              <Hash size={12} />
              {tag}
            </button>
            <button className="card-fields-manage" onClick={() => open(tag)}>
              <Settings2 size={12} />
              {t("db.manageFields")}
            </button>
          </div>
          {db.fields.map((f) => (
            <div key={f.id} className="card-field">
              <span className="card-field-name">{f.name}</span>
              <FieldInput
                tag={tag}
                field={f}
                value={values[f.id]}
                onChange={(v) => {
                  setValues((x) => ({ ...x, [f.id]: v }));
                  setProp(handle.doc, f.id, v);
                }}
              />
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
