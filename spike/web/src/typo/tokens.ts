// Typography lab: the tunable parameters, their candidate values, and the
// derived design tokens. Candidates come from design/research/ui-research.md.

export type Mode = "light" | "dark";

export interface Palette {
  id: string;
  name: string;
  note: string;
  light: { bg: string; text: string };
  dark: { bg: string; text: string };
}

export const PALETTES: Palette[] = [
  { id: "ember", name: "Ember Paper", note: "暖米白 + 暖墨色（Ember Paper 设计系统）", light: { bg: "#FDFAF6", text: "#37352F" }, dark: { bg: "#1C1A17", text: "#F4F0EA" } },
  { id: "warm", name: "Warm Paper", note: "略深的纸色 + 近黑（Obsidian Warm Paper 主题）", light: { bg: "#F5F2ED", text: "#1C1B19" }, dark: { bg: "#1E1D1B", text: "#EDEAE4" } },
  { id: "cream", name: "Cream Stone", note: "奶油白 + 石色（Convictional 手册的思路）", light: { bg: "#FFFDF5", text: "#292524" }, dark: { bg: "#1C1917", text: "#E7E5E4" } },
  { id: "neutral", name: "Neutral", note: "对照组：近白 + 近黑，无暖色", light: { bg: "#FAFAFA", text: "#1F1F1F" }, dark: { bg: "#18181B", text: "#E4E4E7" } },
];

export interface Accent {
  id: string;
  name: string;
  light: string;
  dark: string;
}

export const ACCENTS: Accent[] = [
  { id: "ink", name: "墨蓝", light: "#2F5D8A", dark: "#8CB4DE" },
  { id: "moss", name: "苔绿", light: "#55693A", dark: "#A9BC8A" },
  { id: "terracotta", name: "赭红", light: "#A4502F", dark: "#E2A383" },
];

export interface FontChoice {
  id: string;
  name: string;
  stack: string;
  note: string;
}

export const LATIN_FONTS: FontChoice[] = [
  { id: "literata", name: "Literata", stack: '"Literata"', note: "为屏幕长时间阅读设计，有光学尺寸轴（OFL）" },
  { id: "sourceSerif", name: "Source Serif 4", stack: '"Source Serif 4"', note: "跨平台渲染最稳（OFL）" },
  { id: "newsreader", name: "Newsreader", stack: '"Newsreader"', note: "报刊编辑风格（OFL）" },
  { id: "systemSerif", name: "系统衬线", stack: 'ui-serif, "New York", Georgia', note: "macOS 为 New York，其他平台多为 Georgia" },
  { id: "systemSans", name: "系统无衬线", stack: 'system-ui, -apple-system, "Segoe UI", Roboto', note: "对照组" },
];

export const CJK_FONTS: FontChoice[] = [
  { id: "sysSans", name: "系统黑体", stack: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC"', note: "四个平台都有，体积零增加" },
  { id: "sysSerif", name: "系统宋体", stack: '"Songti SC", "STSong", "Noto Serif CJK SC", "SimSun"', note: "只有 macOS / iOS 的宋体好看" },
  { id: "notoSerif", name: "思源宋体", stack: '"Noto Serif SC"', note: "需随应用打包或按需下载（此处从 Google Fonts 加载预览）" },
  { id: "notoSans", name: "思源黑体", stack: '"Noto Sans SC"', note: "比苹方、微软雅黑更中性精致；需打包或按需下载（此处从 Google Fonts 加载）" },
  { id: "wenkai", name: "霞鹜文楷", stack: '"LXGW WenKai Screen"', note: "楷体风格、有书写感，中文笔记用户常用的开源字体（屏幕优化版）；需打包或按需下载" },
];

export const MONO_STACK = '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';
export const UI_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

export type IconSet = "lucide" | "phosphor" | "tabler";

export interface Features {
  autospace: boolean;
  spacingTrim: boolean;
  hangingPunctuation: boolean;
  textWrapPretty: boolean;
  hyphens: boolean;
  strictLineBreak: boolean;
}

export interface LabState {
  palette: string;
  mode: Mode;
  accent: string;
  latin: string;
  cjk: string;
  fontSize: number;
  lineHeight: number;
  /** Chinese/Japanese/Korean blocks get their own line height (Outline does the same). */
  cjkLineHeight: number;
  paragraphGap: number;
  measure: number;
  headingWeight: 400 | 500;
  secondaryStrength: number;
  features: Features;
  icons: IconSet;
  iconStroke: number;
}

/** Recommended starting point; reasons in design/research/ui-research.md §9. */
export const DEFAULT_STATE: LabState = {
  palette: "ember",
  mode: "light",
  accent: "ink",
  // Chosen 2026-10-23: Source Han Serif's Latin glyphs derive from Source Serif.
  latin: "sourceSerif",
  cjk: "notoSerif",
  fontSize: 16,
  lineHeight: 1.6,
  cjkLineHeight: 1.8,
  paragraphGap: 0.75,
  measure: 680,
  headingWeight: 500,
  // 0.68 measured 4.49:1 in light mode (4.22:1 on the sidebar); 0.72 clears 4.5:1 on both.
  secondaryStrength: 0.72,
  features: { autospace: true, spacingTrim: true, hangingPunctuation: true, textWrapPretty: true, hyphens: true, strictLineBreak: true },
  icons: "lucide",
  iconStroke: 1.5,
};

/** The three font combinations from ui-research.md §2.2. */
export const PRESETS: { id: string; name: string; note: string; patch: Partial<LabState> }[] = [
  { id: "A", name: "方案 A", note: "英文衬线 + 中文系统黑体", patch: { latin: "literata", cjk: "sysSans" } },
  { id: "B", name: "方案 B（已选）", note: "Source Serif 4 + 思源宋体：同属 Adobe 的 Source 字体家族，中英文笔画最协调", patch: { latin: "sourceSerif", cjk: "notoSerif" } },
  { id: "C", name: "方案 C", note: "全部系统字体", patch: { latin: "systemSans", cjk: "sysSans" } },
  { id: "D", name: "方案 D", note: "英文衬线 + 中文霞鹜文楷", patch: { latin: "literata", cjk: "wenkai" } },
  { id: "E", name: "方案 E", note: "英文无衬线 + 中文思源黑体", patch: { latin: "systemSans", cjk: "notoSans" } },
];

// ---- color math ----

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** `t` of `a` blended over `b` (sRGB, like CSS color-mix). */
export function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex([0, 1, 2].map((i) => ca[i] * t + cb[i] * (1 - t)) as [number, number, number]);
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio. */
export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

export interface Colors {
  bg: string;
  surface: string;
  text: string;
  secondary: string;
  muted: string;
  border: string;
  accent: string;
  accentBg: string;
}

export function colorsFor(s: LabState): Colors {
  const p = PALETTES.find((x) => x.id === s.palette) ?? PALETTES[0];
  const a = ACCENTS.find((x) => x.id === s.accent) ?? ACCENTS[0];
  const { bg, text } = p[s.mode];
  const accent = a[s.mode];
  return {
    bg,
    // Sidebar / panels sit a hair away from the page so the page reads as paper.
    surface: mix(text, bg, s.mode === "light" ? 0.035 : 0.05),
    text,
    secondary: mix(text, bg, s.secondaryStrength),
    // 0.55 keeps placeholders at ≥ 3:1 in light mode (0.45 measured 2.47:1).
    muted: mix(text, bg, 0.55),
    border: mix(text, bg, 0.12),
    accent,
    accentBg: mix(accent, bg, 0.14),
  };
}

export function fontStack(s: LabState): string {
  const latin = LATIN_FONTS.find((f) => f.id === s.latin) ?? LATIN_FONTS[0];
  const cjk = CJK_FONTS.find((f) => f.id === s.cjk) ?? CJK_FONTS[0];
  const generic = s.latin === "systemSans" ? "sans-serif" : "serif";
  return `${latin.stack}, ${cjk.stack}, ${generic}`;
}

/** The tokens the design system would ship, as CSS custom properties. */
export function cssVariables(s: LabState): string {
  const c = colorsFor(s);
  const lines = [
    `--color-bg: ${c.bg};`,
    `--color-surface: ${c.surface};`,
    `--color-text: ${c.text};`,
    `--color-text-secondary: ${c.secondary};`,
    `--color-text-muted: ${c.muted};`,
    `--color-border: ${c.border};`,
    `--color-accent: ${c.accent};`,
    `--color-accent-bg: ${c.accentBg};`,
    `--font-body: ${fontStack(s)};`,
    `--font-ui: ${UI_STACK};`,
    `--font-mono: ${MONO_STACK};`,
    `--font-size-body: ${s.fontSize}px;`,
    `--line-height-body: ${s.lineHeight};`,
    `--line-height-body-cjk: ${s.cjkLineHeight};`,
    `--space-paragraph: ${s.paragraphGap}em;`,
    `--measure: ${s.measure}px;`,
    `--font-weight-heading: ${s.headingWeight};`,
  ];
  return `/* ${s.mode} */\n:root {\n  ${lines.join("\n  ")}\n}`;
}

const LATIN_SAMPLE = "The mind runs on two systems. System one is fast, automatic and intuitive; system two is slow.";

/** Characters per line for the chosen measure, measured with the actual fonts. */
export function charsPerLine(s: LabState) {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return { latin: Math.round(s.measure / (s.fontSize * 0.5)), cjk: Math.round(s.measure / s.fontSize) };
  ctx.font = `${s.fontSize}px ${fontStack(s)}`;
  const latinAvg = ctx.measureText(LATIN_SAMPLE).width / LATIN_SAMPLE.length;
  const cjkWidth = ctx.measureText("汉字排版测试").width / 6;
  return { latin: Math.round(s.measure / latinAvg), cjk: Math.round(s.measure / cjkWidth) };
}
