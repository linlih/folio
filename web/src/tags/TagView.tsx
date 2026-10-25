import { Hash } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Backlink } from "../bindings/commands";
import { byCard, Group } from "../card/Backlinks";
import { CARDS_CHANGED } from "../card/actions";
import { DOC_SAVED } from "../docs/persistence";
import { backend } from "../platform";
import "./tags.css";
import { EmptyState } from "../shell/EmptyState";

/** A tag's page: every block tagged with it, grouped by card, newest first
 *  (Logseq's tag page; Heptabase's tag database views come in M6). */
export function TagView({ name, active }: { name: string; active: boolean }) {
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
    <div className="page tag-page">
      <header className="page-header">
        <h1 className="tag-title">
          <Hash size={22} strokeWidth={1.75} />
          {name}
        </h1>
        {rows && <span className="page-meta">{t("tags.count", { blocks: rows.length, cards: groups.length })}</span>}
      </header>
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
    </div>
  );
}
