// Task status icons, drawn for Folio after the shapes Logseq uses for its
// built-in statuses (design/outliner.md "任务"): round, 20×20 viewBox,
// coloured by CSS (currentColor).

export type TaskStatus = "backlog" | "todo" | "doing" | "review" | "done" | "canceled";

export const STATUSES: TaskStatus[] = ["backlog", "todo", "doing", "review", "done", "canceled"];

const svg = (body: string) =>
  `<svg viewBox="0 0 20 20" width="1em" height="1em" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const STATUS_ICON: Record<TaskStatus, string> = {
  backlog: svg(`<circle cx="10" cy="10" r="7.5" stroke-width="2" stroke-dasharray="3.2 3.2"/>`),
  todo: svg(`<circle cx="10" cy="10" r="7.5" stroke-width="2"/>`),
  doing: svg(`<circle cx="10" cy="10" r="7.5" stroke-width="2"/><path d="M10 5a5 5 0 0 1 0 10z" fill="currentColor" stroke="none"/>`),
  review: svg(
    `<circle cx="10" cy="10" r="8.5" fill="currentColor" stroke="none"/><path d="M6.5 7.5h7v4h-4.2l-2.8 2v-6z" stroke="var(--paper)" stroke-width="1.5"/>`,
  ),
  done: svg(`<circle cx="10" cy="10" r="8.5" fill="currentColor" stroke="none"/><path d="M6.3 10.2l2.5 2.5 4.9-5" stroke="var(--paper)" stroke-width="1.9"/>`),
  canceled: svg(
    `<circle cx="10" cy="10" r="8.5" fill="currentColor" stroke="none"/><path d="M7.2 7.2l5.6 5.6M12.8 7.2l-5.6 5.6" stroke="var(--paper)" stroke-width="1.9"/>`,
  ),
};

export type Priority = "low" | "medium" | "high" | "urgent";

export const PRIORITIES: Priority[] = ["low", "medium", "high", "urgent"];

/** Signal bars, like Logseq's priority icons. */
export const PRIORITY_ICON: Record<Priority, string> = {
  low: svg(`<path d="M5 15v-2" stroke-width="2.2"/><path d="M10 15v-5M15 15V7" stroke-width="2.2" opacity=".25"/>`),
  medium: svg(`<path d="M5 15v-2M10 15v-5" stroke-width="2.2"/><path d="M15 15V7" stroke-width="2.2" opacity=".25"/>`),
  high: svg(`<path d="M5 15v-2M10 15v-5M15 15V7" stroke-width="2.2"/>`),
  urgent: svg(`<rect x="3.5" y="3.5" width="13" height="13" rx="3" fill="currentColor" stroke="none"/><path d="M10 6.5v4.5" stroke="var(--paper)" stroke-width="2"/><circle cx="10" cy="13.6" r="1.1" fill="var(--paper)" stroke="none"/>`),
};
