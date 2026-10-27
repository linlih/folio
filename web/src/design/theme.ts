// Light, dark or following the system (tokens.css reads `data-theme`).

import { backend } from "../platform";

export const THEME_SETTING = "ui.theme";
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const isTheme = (v: unknown): v is Theme => THEMES.includes(v as Theme);

export function applyTheme(theme: Theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  // The phone's status bar and keyboard follow the app, not the system.
  void backend.setAppearance(theme).catch(() => {});
}

// Reading: how wide and how large card text is (tokens --measure, --body-size;
// headings are in em and follow the size).

export const TEXT_WIDTH_SETTING = "ui.textWidth";
export const TEXT_SIZE_SETTING = "ui.textSize";
export const TEXT_WIDTHS = { narrow: "600px", medium: "680px", wide: "860px" } as const;
export const TEXT_SIZES = { small: "15px", medium: "16px", large: "18px" } as const;
export type TextWidth = keyof typeof TEXT_WIDTHS;
export type TextSize = keyof typeof TEXT_SIZES;

export const isTextWidth = (v: unknown): v is TextWidth => typeof v === "string" && v in TEXT_WIDTHS;
export const isTextSize = (v: unknown): v is TextSize => typeof v === "string" && v in TEXT_SIZES;

export function applyTextWidth(w: TextWidth) {
  document.documentElement.style.setProperty("--measure", TEXT_WIDTHS[w]);
}

export function applyTextSize(s: TextSize) {
  document.documentElement.style.setProperty("--body-size", TEXT_SIZES[s]);
}
