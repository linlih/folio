import { Menu } from "@base-ui/react/menu";
import { LayoutDashboard, MoreHorizontal, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { newBoard, useBoards, workspaceDoc } from "../docs/topics";
import { deleteBoard, renameBoard } from "../docs/workspace";
import { EmptyState } from "../shell/EmptyState";
import { toSide, useShell } from "../shell/tabs";
import "../library/library.css";
import "./board.css";

/** All whiteboards (§4.3), a page beside the journal and the card library:
 *  open one, make one, rename or delete one. */
export function BoardsView() {
  const { t, i18n } = useTranslation();
  const boards = useBoards((s) => s.boards);
  const open = useShell((s) => s.open);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" });

  const create = async () => open({ kind: "board", boardId: await newBoard(t("board.untitled")) });
  const doomed = boards.find((b) => b.id === deleting);

  return (
    <div className="page boards-page">
      <header className="page-header">
        <h1>{t("nav.boards")}</h1>
        <span className="page-meta">{t("board.count", { count: boards.length })}</span>
        <button className="button primary" onClick={() => void create()}>
          <Plus size={14} />
          {t("board.new")}
        </button>
      </header>
      {doomed && (
        <div className="topic-confirm">
          <p>{t("board.deleteConfirm", { name: doomed.name || t("board.untitled") })}</p>
          <button className="button" onClick={() => setDeleting(null)}>
            {t("dialog.cancel")}
          </button>
          <button
            className="button danger"
            onClick={async () => {
              setDeleting(null);
              deleteBoard((await workspaceDoc()).doc, doomed.id);
              useShell.getState().close(`board:${doomed.id}`);
            }}
          >
            {t("board.delete")}
          </button>
        </div>
      )}
      {boards.length === 0 ? (
        <EmptyState icon={<LayoutDashboard size={28} strokeWidth={1.5} />} title={t("board.none")} hint={t("board.noneHint")} />
      ) : (
        <ul className="topic-grid">
          {boards.map((b) => (
            <li key={b.id} className="topic-tile board-tile">
              {renaming === b.id ? (
                <input
                  className="topic-name-input board-tile-rename"
                  autoFocus
                  defaultValue={b.name}
                  onBlur={async (e) => {
                    // Read before awaiting: the event is gone after.
                    const name = e.currentTarget.value;
                    setRenaming(null);
                    renameBoard((await workspaceDoc()).doc, b.id, name);
                  }}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === "Escape") && e.currentTarget.blur()}
                />
              ) : (
                <button className="topic-tile-open" onClick={(e) => open({ kind: "board", boardId: b.id }, null, toSide(e))}>
                  <span className="topic-tile-head">
                    <LayoutDashboard size={15} strokeWidth={1.75} />
                    <span className="topic-tile-name">{b.name || t("board.untitled")}</span>
                  </span>
                  <span className="board-tile-preview" aria-hidden />
                  <time className="library-tile-date">{t("board.createdOn", { date: date.format(b.createdAt) })}</time>
                </button>
              )}
              <Menu.Root>
                <Menu.Trigger className="icon-button board-tile-menu" aria-label={t("board.menu")} title={t("board.menu")}>
                  <MoreHorizontal size={15} />
                </Menu.Trigger>
                <Menu.Portal>
                  <Menu.Positioner side="bottom" align="end" sideOffset={4}>
                    <Menu.Popup className="popup">
                      <Menu.Item className="popup-item" onClick={() => setRenaming(b.id)}>
                        {t("board.rename")}
                      </Menu.Item>
                      <Menu.Item className="popup-item" onClick={() => setDeleting(b.id)}>
                        {t("board.delete")}
                      </Menu.Item>
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.Root>
            </li>
          ))}
          <li className="topic-tile new">
            <button className="topic-tile-open" onClick={() => void create()}>
              <Plus size={16} />
              {t("board.new")}
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
