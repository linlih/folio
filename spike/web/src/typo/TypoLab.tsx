// Typography lab (design/research/ui-research.md §6): tune fonts, sizes,
// colors and typesetting features against real content, then export tokens.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { publish } from "../publish";
import { Sample } from "./Sample";
import {
  ACCENTS,
  CJK_FONTS,
  DEFAULT_STATE,
  LATIN_FONTS,
  MONO_STACK,
  PALETTES,
  PRESETS,
  UI_STACK,
  charsPerLine,
  colorsFor,
  contrast,
  cssVariables,
  fontStack,
  type Features,
  type IconSet,
  type LabState,
} from "./tokens";
import "./typo.css";

const STORAGE_KEY = "typo-lab-v5";
const FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,400;0,7..72,500;1,7..72,400" +
  "&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,500;1,8..60,400" +
  "&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400" +
  "&family=Noto+Serif+SC:wght@400;500&family=Noto+Sans+SC:wght@400;500&family=JetBrains+Mono:wght@400&display=swap";
// LXGW WenKai (screen-optimized, simplified-Chinese glyphs), split into unicode-range subsets.
const WENKAI_HREF = "https://cdn.jsdelivr.net/npm/lxgw-wenkai-screen-webfont@1.7.0/lxgwwenkaigbscreen.css";

function loadState(): LabState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_STATE, ...JSON.parse(raw), features: { ...DEFAULT_STATE.features, ...JSON.parse(raw).features } };
  } catch {
    // Private mode or blocked storage: start from defaults.
  }
  return DEFAULT_STATE;
}

function useWebFonts() {
  useEffect(() => {
    for (const [id, href] of [["typo-lab-fonts", FONTS_HREF], ["typo-lab-wenkai", WENKAI_HREF]]) {
      if (document.getElementById(id)) continue;
      const link = document.createElement("link");
      link.id = id;
      link.rel = "stylesheet";
      link.href = href;
      document.head.appendChild(link);
    }
  }, []);
}

const FEATURE_INFO: { key: keyof Features; label: string; prop: string; on: string; off: string }[] = [
  { key: "autospace", label: "中西文自动间距", prop: "text-autospace", on: "normal", off: "no-autospace" },
  { key: "spacingTrim", label: "中文标点挤压", prop: "text-spacing-trim", on: "normal", off: "space-all" },
  { key: "hangingPunctuation", label: "标点悬挂", prop: "hanging-punctuation", on: "first last", off: "none" },
  { key: "textWrapPretty", label: "更好的断行（pretty）", prop: "text-wrap", on: "pretty", off: "wrap" },
  { key: "hyphens", label: "英文断词", prop: "hyphens", on: "auto", off: "manual" },
  { key: "strictLineBreak", label: "严格避头尾", prop: "line-break", on: "strict", off: "auto" },
];

function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="tc-row">
      <div className="tc-label">{label}</div>
      <div className="tc-control">{children}</div>
      {hint && <div className="tc-hint">{hint}</div>}
    </div>
  );
}

function Choice<T extends string | number>({ value, options, onChange }: { value: T; options: { id: T; name: string; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="tc-choice">
      {options.map((o) => (
        <button key={String(o.id)} title={o.title} className={o.id === value ? "on" : ""} onClick={() => onChange(o.id)}>
          {o.name}
        </button>
      ))}
    </div>
  );
}

function Slider({ value, min, max, step, unit, onChange }: { value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <div className="tc-slider">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span>
        {Number(value.toFixed(2))}
        {unit}
      </span>
    </div>
  );
}

function Ratio({ label, fg, bg, min }: { label: string; fg: string; bg: string; min: number }) {
  const r = contrast(fg, bg);
  return (
    <div className={`tc-ratio ${r >= min ? "ok" : "bad"}`}>
      <span className="tc-swatch" style={{ background: fg }} />
      {label} {r.toFixed(2)} : 1 {r >= min ? "✓" : `✗（需 ≥ ${min}）`}
    </div>
  );
}

export function TypoLab() {
  useWebFonts();
  const [s, setS] = useState<LabState>(loadState);
  const [saved, setSaved] = useState("");
  // Only matters in narrow windows; wide layouts always show the panel.
  const [panelOpen, setPanelOpen] = useState(true);
  const set = <K extends keyof LabState>(k: K, v: LabState[K]) => setS((p) => ({ ...p, [k]: v }));
  const setFeature = (k: keyof Features, v: boolean) => setS((p) => ({ ...p, features: { ...p.features, [k]: v } }));

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
      // Not persisting is fine; the lab still works.
    }
  }, [s]);

  // Re-measure line length once the web fonts have arrived.
  const [fontsReady, setFontsReady] = useState(0);
  useEffect(() => {
    void document.fonts.ready.then(() => setFontsReady((n) => n + 1));
    const onLoad = () => setFontsReady((n) => n + 1);
    document.fonts.addEventListener("loadingdone", onLoad);
    return () => document.fonts.removeEventListener("loadingdone", onLoad);
  }, []);
  const c = colorsFor(s);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cpl = useMemo(() => charsPerLine(s), [s, fontsReady]);
  const supported = useMemo(() => Object.fromEntries(FEATURE_INFO.map((f) => [f.key, CSS.supports(f.prop, f.on)])), []);

  const previewStyle = {
    "--bg": c.bg,
    "--surface": c.surface,
    "--text": c.text,
    "--secondary": c.secondary,
    "--muted": c.muted,
    "--border": c.border,
    "--accent": c.accent,
    "--accent-bg": c.accentBg,
    "--font-body": fontStack(s),
    "--font-ui": UI_STACK,
    "--font-mono": MONO_STACK,
    "--size": `${s.fontSize}px`,
    "--leading": s.lineHeight,
    "--leading-cjk": s.cjkLineHeight,
    "--para": `${s.paragraphGap}em`,
    "--measure": `${s.measure}px`,
    "--heading-weight": s.headingWeight,
    colorScheme: s.mode,
  } as CSSProperties;

  // Each feature is applied only when switched on; "off" sets the explicit opposite.
  const docStyle = Object.fromEntries(
    FEATURE_INFO.map((f) => [f.prop.replace(/-([a-z])/g, (_m, ch: string) => ch.toUpperCase()), s.features[f.key] ? f.on : f.off]),
  ) as CSSProperties;

  const tokens = { ...s, colors: c, fontStackBody: fontStack(s), fontStackUi: UI_STACK, fontStackMono: MONO_STACK, css: cssVariables(s) };

  const exportTokens = async () => {
    await publish("typography-tokens", tokens);
    const blob = new Blob([JSON.stringify(tokens, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "typography-tokens.json";
    a.click();
    URL.revokeObjectURL(a.href);
    setSaved(window.__TAURI_INTERNALS__ ? "已保存到 spike/results/webview-typography-tokens.json" : "已下载 typography-tokens.json");
  };
  const copyCss = async () => {
    try {
      await navigator.clipboard.writeText(cssVariables(s));
      setSaved("CSS 变量已复制");
    } catch {
      setSaved("复制失败，请手动选中下方文本");
    }
  };

  return (
    <div className="tl-lab">
      <button className="tc-toggle" onClick={() => setPanelOpen((o) => !o)}>
        <span>{panelOpen ? "收起参数" : "展开参数"}</span>
        <span>{panelOpen ? "▲" : "▼"}</span>
      </button>
      <div className={panelOpen ? "tc-panel" : "tc-panel tc-closed"}>
        <Row label="快速方案" hint={PRESETS.map((p) => `${p.name}：${p.note}`).join("；")}>
          <Choice
            value={PRESETS.find((p) => p.patch.latin === s.latin && p.patch.cjk === s.cjk)?.id ?? ""}
            options={PRESETS.map((p) => ({ id: p.id, name: p.name, title: p.note }))}
            onChange={(id) => setS((p) => ({ ...p, ...PRESETS.find((x) => x.id === id)!.patch }))}
          />
        </Row>

        <div className="tc-group">字体</div>
        <Row label="英文正文" hint={LATIN_FONTS.find((f) => f.id === s.latin)?.note}>
          <Choice value={s.latin} options={LATIN_FONTS} onChange={(v) => set("latin", v)} />
        </Row>
        <Row label="中文正文" hint={CJK_FONTS.find((f) => f.id === s.cjk)?.note}>
          <Choice value={s.cjk} options={CJK_FONTS} onChange={(v) => set("cjk", v)} />
        </Row>
        <Row label="标题字重">
          <Choice value={s.headingWeight} options={[{ id: 400, name: "常规" }, { id: 500, name: "中等" }]} onChange={(v) => set("headingWeight", v)} />
        </Row>

        <div className="tc-group">版式</div>
        <Row label="字号">
          <Slider value={s.fontSize} min={14} max={20} step={0.5} unit="px" onChange={(v) => set("fontSize", v)} />
        </Row>
        <Row label="行高（英文等）">
          <Slider value={s.lineHeight} min={1.4} max={2.1} step={0.05} onChange={(v) => set("lineHeight", v)} />
        </Row>
        <Row label="行高（中日韩）" hint="中日韩文字笔画密，通常需要比英文更大的行高">
          <Slider value={s.cjkLineHeight} min={1.4} max={2.2} step={0.05} onChange={(v) => set("cjkLineHeight", v)} />
        </Row>
        <Row label="段间距">
          <Slider value={s.paragraphGap} min={0.2} max={1.4} step={0.1} unit="em" onChange={(v) => set("paragraphGap", v)} />
        </Row>
        <Row label="行宽" hint={`约 ${cpl.latin} 个英文字符 / ${cpl.cjk} 个汉字每行（参考：英文约 65，中文 30–40）`}>
          <Slider value={s.measure} min={420} max={900} step={10} unit="px" onChange={(v) => set("measure", v)} />
        </Row>

        <div className="tc-group">颜色</div>
        <Row label="调色板" hint={PALETTES.find((p) => p.id === s.palette)?.note}>
          <Choice value={s.palette} options={PALETTES} onChange={(v) => set("palette", v)} />
        </Row>
        <Row label="模式">
          <Choice value={s.mode} options={[{ id: "light", name: "浅色" }, { id: "dark", name: "深色" }]} onChange={(v) => set("mode", v)} />
        </Row>
        <Row label="强调色">
          <Choice value={s.accent} options={ACCENTS} onChange={(v) => set("accent", v)} />
        </Row>
        <Row label="次要文字深浅">
          <Slider value={s.secondaryStrength} min={0.45} max={0.9} step={0.01} onChange={(v) => set("secondaryStrength", v)} />
        </Row>
        <div className="tc-ratios">
          <Ratio label="正文" fg={c.text} bg={c.bg} min={4.5} />
          <Ratio label="次要文字" fg={c.secondary} bg={c.bg} min={4.5} />
          <Ratio label="侧栏次要文字" fg={c.secondary} bg={c.surface} min={4.5} />
          <Ratio label="强调色" fg={c.accent} bg={c.bg} min={4.5} />
          <Ratio label="占位 / 提示文字" fg={c.muted} bg={c.bg} min={3} />
        </div>

        <div className="tc-group">排版特性（✓ = 当前 WebView 支持）</div>
        {FEATURE_INFO.map((f) => (
          <label key={f.key} className="tc-check">
            <input type="checkbox" checked={s.features[f.key]} onChange={(e) => setFeature(f.key, e.target.checked)} />
            {f.label}
            <span className={supported[f.key] ? "tc-yes" : "tc-no"}>{supported[f.key] ? "✓" : "不支持"}</span>
          </label>
        ))}

        <div className="tc-group">图标</div>
        <Row label="图标库">
          <Choice<IconSet>
            value={s.icons}
            options={[
              { id: "lucide", name: "Lucide" },
              { id: "phosphor", name: "Phosphor Light" },
              { id: "tabler", name: "Tabler" },
            ]}
            onChange={(v) => set("icons", v)}
          />
        </Row>
        {s.icons !== "phosphor" && (
          <Row label="线宽">
            <Slider value={s.iconStroke} min={1} max={2} step={0.25} onChange={(v) => set("iconStroke", v)} />
          </Row>
        )}

        <div className="tc-group">导出</div>
        <div className="tc-actions">
          <button onClick={exportTokens}>导出 token</button>
          <button onClick={copyCss}>复制 CSS 变量</button>
          <button onClick={() => setS(DEFAULT_STATE)}>恢复推荐值</button>
        </div>
        {saved && <div className="tc-hint">{saved}</div>}
        <pre className="tc-css">{cssVariables(s)}</pre>
      </div>

      <div className="tl-preview" style={previewStyle}>
        <div className="tl-doc-features" style={docStyle}>
          <Sample icons={s.icons} stroke={s.iconStroke} />
        </div>
      </div>
    </div>
  );
}
