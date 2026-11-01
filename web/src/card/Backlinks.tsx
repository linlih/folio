import { ChevronRight, Link2, Search } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Backlink } from "../bindings/commands";
import { backend } from "../platform";
import { appUndo, docs } from "../app";
import { linkMention, unlinkMention } from "../editor/linkMention";
import { CARDS_CHANGED, cardsChanged } from "./actions";
import { toSide, useShell } from "../shell/tabs";
import { cardName, openAt } from "./reveal";

/** Groups backlinks by the card they are in, keeping the order. */
export function byCard(rows: Backlink[]) {
  const groups = new Map<string, { cardId: string; title: string; rows: Backlink[] }>();
  for (const r of rows) {
    const g = groups.get(r.cardId) ?? { cardId: r.cardId, title: cardName(r.cardId, r.cardTitle), rows: [] };
    if (!g.rows.some((x) => x.bid === r.bid && x.via === r.via)) g.rows.push(r);
    groups.set(r.cardId, g);
  }
  return [...groups.values()];
}

type Groups = ReturnType<typeof byCard>;

/** How backlinks are ordered: by when the linking card was last edited
 *  (newest first, as they come), the other way round, or by card name. */
export type BacklinkSort = "recent" | "oldest" | "title";
const SORT_SETTING = "backlinks.sort";

/** The groups, keeping the rows whose text, card name or nested blocks
 *  contain `query` (any case), in `sort` order. */
export function sieve(groups: Groups, query: string, sort: BacklinkSort): Groups {
  const q = query.trim().toLowerCase();
  const has = (s: string) => s.toLowerCase().includes(q);
  const kept = !q
    ? groups
    : groups.flatMap((g) => {
        const rows = has(g.title) ? g.rows : g.rows.filter((r) => has(r.text) || r.children?.some((c) => has(c.text)));
        return rows.length ? [{ ...g, rows }] : [];
      });
  if (sort === "oldest") return [...kept].reverse();
  if (sort === "title") return [...kept].sort((a, b) => a.title.localeCompare(b.title));
  return kept;
}

/** `onLink`: unlinked mentions get a button that turns them into links.
 *  `folded` / `onFold`: the group shows only its card's name. */
export function Group({
  group,
  onLink,
  folded = false,
  onFold,
}: {
  group: Groups[number];
  onLink?: (rows: Backlink[]) => void;
  folded?: boolean;
  onFold?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="backlink-group">
      <div className="backlink-head">
        {onFold && (
          <button className="backlink-fold" aria-expanded={!folded} aria-label={t(folded ? "backlinks.unfold" : "backlinks.fold")} onClick={onFold}>
            <ChevronRight size={13} className={folded ? "" : "open"} />
          </button>
        )}
        <button className="backlink-card" onClick={(e) => openAt(group.cardId, group.title, null, toSide(e))}>
          {group.title}
        </button>
        {folded && <span className="backlink-count">{group.rows.length}</span>}
      </div>
      {!folded && <ul>
        {group.rows.map((r) => (
          <li key={`${r.via}:${r.bid}`} className={onLink ? "backlink-mention" : undefined}>
            {r.children?.length ? (
              <BlockTree row={r} title={group.title} />
            ) : (
              <button className="backlink-block" onClick={(e) => openAt(r.cardId, group.title, r.bid, toSide(e))}>
                {r.via === "ref" && <span className="backlink-via">{t("backlinks.ref")}</span>}
                {r.text || t(r.via === "link" || r.via === "ref" ? "backlinks.onlyRef" : "backlinks.emptyBlock")}
              </button>
            )}
            {onLink && (
              <button className="button backlink-link" title={t("backlinks.linkHint")} onClick={() => onLink([r])}>
                <Link2 size={13} />
                {t("backlinks.link")}
              </button>
            )}
          </li>
        ))}
      </ul>}
    </li>
  );
}

/** How many blocks under a block show before 显示全部. */
const CHILDREN_SHOWN = 8;

/** A block with the blocks nested under it, indented as in the card: a tag
 *  written alone on a line, with the note itself below it. */
function BlockTree({ row, title }: { row: Backlink; title: string }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const children = row.children ?? [];
  const shown = all ? children : children.slice(0, CHILDREN_SHOWN);
  return (
    <div className="backlink-tree">
      <button className="backlink-block" onClick={(e) => openAt(row.cardId, title, row.bid, toSide(e))}>
        {row.text || t("backlinks.emptyBlock")}
      </button>
      {shown.map((c) => (
        <button
          key={c.bid}
          className="backlink-block backlink-child"
          style={{ "--depth": c.depth } as CSSProperties}
          onClick={(e) => openAt(row.cardId, title, c.bid, toSide(e))}
        >
          {c.text || t("backlinks.emptyBlock")}
        </button>
      ))}
      {children.length > CHILDREN_SHOWN && (
        <button className="backlink-more" onClick={() => setAll((v) => !v)}>
          {all ? t("backlinks.showLess") : t("backlinks.showAll", { count: children.length })}
        </button>
      )}
    </div>
  );
}

/** Linked and unlinked references at the bottom of a card (Logseq,
 *  Heptabase): what links to this card or its blocks, and where its title is
 *  mentioned without a link. */
export function Backlinks({ cardId, active }: { cardId: string; active: boolean }) {
  const { t } = useTranslation();
  const [linked, setLinked] = useState<Backlink[]>([]);
  const [unlinked, setUnlinked] = useState<Backlink[] | null>(null);
  const [showUnlinked, setShowUnlinked] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<BacklinkSort>("recent");
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    void backend
      .getLocalSetting<BacklinkSort>(SORT_SETTING)
      .then((s) => s && setSort(s))
      .catch(() => {});
  }, []);
  const changeSort = (s: BacklinkSort) => {
    setSort(s);
    void backend.setLocalSetting(SORT_SETTING, s).catch(() => {});
  };
  const fold = (id: string) =>
    setFolded((old) => {
      const next = new Set(old);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const load = useCallback(async () => {
    try {
      setLinked(await backend.backlinks(cardId));
      if (showUnlinked) setUnlinked(await backend.unlinkedReferences(cardId));
    } catch {
      // A card that is not written yet has no references.
    }
  }, [cardId, showUnlinked]);

  useEffect(() => {
    if (active) void load();
    const onChange = () => void load();
    window.addEventListener(CARDS_CHANGED, onChange);
    return () => window.removeEventListener(CARDS_CHANGED, onChange);
  }, [active, load]);

  /** Links mentions; Mod+Z (outside editors) unlinks them again. */
  const linkRows = async (rows: Backlink[]) => {
    const shell = useShell.getState();
    try {
      const title = (await backend.titles([cardId]))[0]?.[1] ?? "";
      if (!title.trim()) return;
      const hub = docs();
      const target = { cardId, title };
      const done: { row: Backlink; text: string }[] = [];
      for (const row of rows) {
        const text = await linkMention(hub, row.cardId, row.bid, target);
        if (text !== null) done.push({ row, text });
      }
      await hub.flushAll();
      await load();
      if (done.length === 0) return;
      appUndo.push({
        label: "link-mentions",
        undo: async () => {
          for (const { row, text } of done) await unlinkMention(hub, row.cardId, row.bid, cardId, text);
          await hub.flushAll();
          cardsChanged();
        },
        redo: async () => {
          for (const { row } of done) await linkMention(hub, row.cardId, row.bid, target);
          await hub.flushAll();
          cardsChanged();
        },
      });
      shell.setNotice(t("backlinks.linkedDone", { count: done.length }), { undo: true });
      cardsChanged();
    } catch (e) {
      shell.setNotice(t("error.generic", { message: String(e) }));
    }
  };

  const all = byCard(linked);
  const total = all.reduce((n, g) => n + g.rows.length, 0);
  const groups = sieve(all, query, sort);
  const count = groups.reduce((n, g) => n + g.rows.length, 0);
  const unlinkedGroups = unlinked ? sieve(byCard(unlinked), query, sort) : [];
  const searching = query.trim() !== "";
  return (
    <section className="backlinks">
      <div className="backlinks-bar">
        <h2>
          <Link2 size={14} strokeWidth={1.75} />
          {searching ? t("backlinks.found", { count, total }) : t("backlinks.linked", { count: total })}
        </h2>
        {/* Worth it once there is more than a handful. */}
        {(total > 3 || searching) && (
          <>
            <label className="backlinks-search">
              <Search size={13} />
              <input type="search" value={query} placeholder={t("backlinks.search")} aria-label={t("backlinks.search")} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <select className="backlinks-sort" value={sort} aria-label={t("backlinks.sort")} onChange={(e) => changeSort(e.target.value as BacklinkSort)}>
              {(["recent", "oldest", "title"] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`backlinks.sorts.${s}`)}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
      {groups.length === 0 ? (
        <p className="backlinks-empty">{t(searching && total ? "backlinks.noneFound" : "backlinks.none")}</p>
      ) : (
        <ul>
          {groups.map((g) => (
            <Group key={g.cardId} group={g} folded={folded.has(g.cardId)} onFold={() => fold(g.cardId)} />
          ))}
        </ul>
      )}
      <button className="backlinks-toggle" aria-expanded={showUnlinked} onClick={() => setShowUnlinked((v) => !v)}>
        <ChevronRight size={14} className={showUnlinked ? "open" : ""} />
        {unlinked && showUnlinked ? t("backlinks.unlinkedCount", { count: unlinked.length }) : t("backlinks.unlinked")}
      </button>
      {showUnlinked && unlinked && unlinked.length > 1 && (
        <button className="button backlinks-link-all" onClick={() => void linkRows(unlinked)}>
          <Link2 size={13} />
          {t("backlinks.linkAll", { count: unlinked.length })}
        </button>
      )}
      {showUnlinked &&
        unlinked &&
        (unlinked.length === 0 ? (
          <p className="backlinks-empty">{t("backlinks.noneUnlinked")}</p>
        ) : (
          <ul>
            {unlinkedGroups.map((g) => (
              <Group key={g.cardId} group={g} onLink={(rows) => void linkRows(rows)} />
            ))}
          </ul>
        ))}
    </section>
  );
}
