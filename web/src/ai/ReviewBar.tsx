// Above a card's text while the assistant's changes to it wait for an
// answer: how many, going through them, how they are shown, and answering
// them all (the changes themselves are drawn by editor/aiReview.ts).

import { ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { diffText } from "./diff";
import { decideAll, decideChange, goToChange, setReviewView, useCardChanges, useReview, type CardChange, type ReviewView } from "./review";
import "./review.css";

const VIEWS: ReviewView[] = ["inline", "lines", "after"];

export function ReviewBar({ cardId }: { cardId: string }) {
  const { t } = useTranslation();
  const changes = useCardChanges(cardId);
  const { view, current } = useReview();
  const waiting = changes.filter((c) => c.allowed === undefined);
  if (!waiting.length) return null;
  const at = Math.max(0, waiting.findIndex((c) => c.id === current));
  const go = (step: number) => goToChange(waiting[(at + step + waiting.length) % waiting.length].id);
  return (
    <div className="ai-review-bar" role="toolbar" aria-label={t("ai.review.title")}>
      <span className="ai-review-label">
        <Sparkles size={13} />
        {t("ai.review.summary", { count: changes.length })}
        {waiting.length < changes.length && <span className="ai-review-left">{t("ai.review.left", { count: waiting.length })}</span>}
      </span>
      {waiting.length > 1 && (
        <span className="ai-review-nav">
          <button className="icon-button" aria-label={t("ai.review.prev")} title={t("ai.review.prev")} onClick={() => go(-1)}>
            <ChevronLeft size={15} />
          </button>
          <span className="ai-review-pos">
            {at + 1} / {waiting.length}
          </span>
          <button className="icon-button" aria-label={t("ai.review.next")} title={t("ai.review.next")} onClick={() => go(1)}>
            <ChevronRight size={15} />
          </button>
        </span>
      )}
      {changes.some((c) => c.name === "update_block") && (
        <span className="segmented ai-review-views" role="group" aria-label={t("ai.review.view")}>
          {VIEWS.map((v) => (
            <button key={v} className={view === v ? "on" : ""} aria-pressed={view === v} onClick={() => setReviewView(v)}>
              {t(`ai.review.views.${v}`)}
            </button>
          ))}
        </span>
      )}
      <span className="ai-review-spacer" />
      <button className="button ai-review-all" onClick={() => decideAll(changes, false)}>
        {t("ai.review.rejectAll")}
      </button>
      <button className="button primary ai-review-all" onClick={() => decideAll(changes, true)}>
        {t("ai.review.acceptAll")}
      </button>
    </div>
  );
}

/** A proposed new title, under the card's title. */
export function TitleChange({ cardId }: { cardId: string }) {
  const { t } = useTranslation();
  const changes = useCardChanges(cardId);
  const { current } = useReview();
  const change = changes.find((c) => c.name === "rename_card" && c.allowed !== false);
  if (!change) return null;
  return (
    <div className={`ai-title-change${change.id === current ? " current" : ""}${change.allowed ? " accepted" : ""}`} data-ai-change={change.id}>
      <span className="ai-head">
        <span className="ai-who">✦ {t("ai.review.rename")}</span>
        <TitleActions change={change} all={changes} />
      </span>
      <span className="ai-title-diff">
        {change.allowed
          ? change.proposal.after
          : diffText(change.proposal.before ?? "", change.proposal.after ?? "").map((o, i) =>
              o.t === "=" ? (
                <span key={i}>{o.s}</span>
              ) : o.t === "-" ? (
                <del key={i} className="ai-del">
                  {o.s}
                </del>
              ) : (
                <ins key={i} className="ai-ins">
                  {o.s}
                </ins>
              ),
            )}
      </span>
    </div>
  );
}

function TitleActions({ change, all }: { change: CardChange; all: CardChange[] }) {
  const { t } = useTranslation();
  if (change.allowed) {
    return (
      <>
        <span className="ai-state">{t("ai.review.accepted")}</span>
        {all.some((c) => c.allowed === undefined) && (
          <button className="ai-act ai-undo" onClick={() => decideChange(change, undefined, all)}>
            {t("ai.review.takeBack")}
          </button>
        )}
      </>
    );
  }
  return (
    <>
      <button className="ai-act ai-yes" onClick={() => decideChange(change, true, all)}>
        {t("ai.review.accept")}
      </button>
      <button className="ai-act ai-no" onClick={() => decideChange(change, false, all)}>
        {t("ai.review.reject")}
      </button>
    </>
  );
}
