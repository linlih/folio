import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import type { Engine, EngineName } from "./engines/types";
import { Net } from "./harness/net";
import { checkInvariants } from "./harness/ops";
import { makeReplicas, type Replica } from "./harness/runner";
import { benchKeystrokes, benchOpen, buildCardSnapshot } from "./bench/bench";
import { BoardBench } from "./board/BoardBench";
import { publish } from "./publish";
import { TypoLab } from "./typo/TypoLab";
import "./style.css";

// Dynamic imports keep each engine in its own chunk, so the build reports
// each one's bundle cost separately.
const loaders: Record<EngineName, () => Promise<Engine>> = {
  loro: () => import("./engines/loro").then((m) => m.loroEngine),
  yjs: () => import("./engines/yjs").then((m) => m.yjsEngine),
};

declare const __RESULTS_DIR__: string;

/** One-year card from the growth bench, if it has been run. */
async function agedCard(name: EngineName, kind: "snapshot" | "compact"): Promise<Uint8Array | null> {
  const res = await fetch(`/@fs${__RESULTS_DIR__}/blobs/growth-${name}.${kind}`).catch(() => null);
  if (!res?.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}


function EditorLab() {
  const [engineName, setEngineName] = useState<EngineName>("loro");
  const [online, setOnline] = useState(true);
  const [status, setStatus] = useState("");
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const state = useRef<{ rs: Replica[]; net: Net } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const engine = await loaders[engineName]();
      const rs = await makeReplicas(engine, 2, "<h2>两个副本</h2><p>在左右两边分别输入，试试中文输入法、拖动、撤销。</p><ul><li><p>列表</p></li></ul>");
      if (cancelled) {
        rs.forEach((r) => r.editor.destroy());
        return;
      }
      left.current!.replaceChildren(rs[0].editor.view.dom);
      right.current!.replaceChildren(rs[1].editor.view.dom);
      const net = new Net(rs.map((r) => r.peer));
      state.current = { rs, net };
      const check = () => {
        const fails = rs.flatMap((r, i) => checkInvariants(r.editor.state.doc).map((f) => `副本${i}: ${f.kind}`));
        const same = JSON.stringify(rs[0].editor.getJSON()) === JSON.stringify(rs[1].editor.getJSON());
        setStatus(`${same ? "两边一致" : "两边不一致（离线时正常）"}${fails.length ? " · " + fails.join("; ") : " · 块 id 正常"}`);
      };
      rs.forEach((r) => r.editor.on("update", check));
      check();
    })();
    return () => {
      cancelled = true;
      state.current?.net.dispose();
      state.current?.rs.forEach((r) => r.editor.destroy());
      state.current = null;
    };
  }, [engineName]);

  const toggleOnline = () => {
    const s = state.current;
    if (!s) return;
    const next = !online;
    s.net.setOnline(1, next);
    setOnline(next);
  };
  const run = (i: number, f: (e: Editor, r: Replica) => void) => {
    const r = state.current?.rs[i];
    if (r) f(r.editor, r);
  };

  return (
    <section>
      <div className="bar">
        <label>
          引擎{" "}
          <select value={engineName} onChange={(e) => setEngineName(e.target.value as EngineName)}>
            <option value="loro">Loro</option>
            <option value="yjs">Yjs</option>
          </select>
        </label>
        <button onClick={toggleOnline}>{online ? "右侧断网" : "右侧联网"}</button>
        <span className="status">{status}</span>
      </div>
      <div className="panes">
        {[left, right].map((ref, i) => (
          <div key={i} className="pane">
            <div className="pane-bar">
              副本 {i}
              <button onClick={() => run(i, (_e, r) => r.peer.undo(r.editor))}>撤销</button>
              <button onClick={() => run(i, (_e, r) => r.peer.redo(r.editor))}>重做</button>
              <button onClick={() => run(i, (e) => e.chain().focus().toggleBulletList().run())}>列表</button>
              <button onClick={() => run(i, (e) => e.chain().focus().sinkListItem("listItem").run())}>缩进</button>
              <button onClick={() => run(i, (e) => e.chain().focus().liftListItem("listItem").run())}>反缩进</button>
            </div>
            <div ref={ref} className="editor" />
          </div>
        ))}
      </div>
    </section>
  );
}

function PerfBench({ auto, onDone }: { auto: boolean; onDone?: () => void }) {
  const [out, setOut] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const runAll = async () => {
    setBusy(true);
    const all: Record<string, unknown> = {};
    for (const name of ["loro", "yjs"] as EngineName[]) {
      setOut((o) => o + `运行 ${name}…\n`);
      // First load includes fetching and compiling Loro's 3.4 MB wasm.
      const tLoad = performance.now();
      const engine = await loaders[name]();
      engine.createPeer();
      const engineLoadMs = +(performance.now() - tLoad).toFixed(1);
      const { snapshot, chars } = await buildCardSnapshot(engine);
      const host = document.getElementById("bench-host")!;
      const mk = () => host.appendChild(document.createElement("div"));
      const open = await benchOpen(engine, snapshot, 30, mk);
      const el = mk();
      const keys = await benchKeystrokes(engine, snapshot, 1000, el);
      el.remove();
      const aged: Record<string, unknown> = {};
      for (const kind of ["snapshot", "compact"] as const) {
        const bytes = await agedCard(name, kind);
        if (!bytes) continue;
        const o = await benchOpen(engine, bytes, 10, mk);
        const k = await benchKeystrokes(engine, bytes, 300, mk());
        aged[kind] = { bytes: bytes.byteLength, ...o, ...k };
      }
      all[name] = { engineLoadMs, cardChars: chars, snapshotBytes: snapshot.byteLength, ...open, ...keys, agedOneYearCard: aged };
    }
    const result = { ua: navigator.userAgent, ...all };
    setOut(JSON.stringify(result, null, 1));
    await publish("perf", result);
    setBusy(false);
    onDone?.();
  };
  useEffect(() => {
    if (auto) void runAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <section>
      <div className="bar">
        <button disabled={busy} onClick={runAll}>运行性能测试（打开 5,000 字卡片 ×30，按键 ×1000）</button>
      </div>
      <pre className="out">{out}</pre>
      <div id="bench-host" className="bench-host" />
    </section>
  );
}

/** CSS typography features we may rely on, checked in the actual WebView. */
const CSS_CHECKS: Record<string, [string, string]> = {
  "text-autospace: normal": ["text-autospace", "normal"],
  "text-autospace: ideograph-alpha ideograph-numeric": ["text-autospace", "ideograph-alpha ideograph-numeric"],
  "text-spacing-trim: normal": ["text-spacing-trim", "normal"],
  "text-spacing-trim: trim-start": ["text-spacing-trim", "trim-start"],
  "hanging-punctuation: first last": ["hanging-punctuation", "first last"],
  "text-wrap: pretty": ["text-wrap", "pretty"],
  "text-wrap: balance": ["text-wrap", "balance"],
  "line-break: strict": ["line-break", "strict"],
  "word-break: auto-phrase": ["word-break", "auto-phrase"],
  "hyphens: auto": ["hyphens", "auto"],
  "font-feature-settings: 'chws'": ["font-feature-settings", "'chws'"],
  "font-optical-sizing: auto": ["font-optical-sizing", "auto"],
  "view-transition-name": ["view-transition-name", "a"],
};

function cssSupport() {
  const out: Record<string, boolean | string> = { ua: navigator.userAgent };
  for (const [k, [p, v]] of Object.entries(CSS_CHECKS)) out[k] = CSS.supports(p, v);
  out.startViewTransition = typeof (document as { startViewTransition?: unknown }).startViewTransition === "function";
  return out;
}

function App() {
  const params = new URLSearchParams(location.search);
  const auto = params.get("auto");
  useEffect(() => {
    if (auto !== "css") return;
    void publish("css", cssSupport()).then(() => window.__TAURI_INTERNALS__?.invoke("finish", {}));
  }, [auto]);
  // auto=all (used by the Tauri shell): perf, then board, then quit.
  const [tab, setTab] = useState(
    auto === "board" ? "board" : auto === "perf" || auto === "all" ? "perf" : auto === "typo" ? "typo" : "lab",
  );
  const finish = () => window.__TAURI_INTERNALS__?.invoke("finish", {});
  return (
    <main>
      <nav>
        {[
          ["lab", "编辑实验室"],
          ["perf", "性能"],
          ["board", "白板帧率"],
          ["typo", "排版试验"],
        ].map(([k, label]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </nav>
      {tab === "lab" && <EditorLab />}
      {tab === "perf" && <PerfBench auto={auto === "perf" || auto === "all"} onDone={auto === "all" ? () => setTab("board") : undefined} />}
      {tab === "typo" && <TypoLab />}
      {tab === "board" && (
        <BoardBench
          auto={auto === "board" || auto === "all"}
          onResult={async (r) => {
            await publish("board", r);
            if (auto === "all") await finish();
          }}
        />
      )}
    </main>
  );
}

// No StrictMode: its double-invoked effects would run the auto benchmarks twice.
createRoot(document.getElementById("root")!).render(<App />);
