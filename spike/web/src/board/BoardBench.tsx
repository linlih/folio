// Criterion A: can a WebView pan/zoom a board of N cards with HTML previews?
import { useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { seeded } from "../harness/ops";
import { stats } from "../bench/bench";

type CardData = { title: string; html: string; mode: "preview" | "title" };

function CardNode({ data }: NodeProps<Node<CardData>>) {
  if (data.mode === "title") return <div className="card-node title-only"><h4>{data.title}</h4></div>;
  return <div className="card-node"><h4>{data.title}</h4><div dangerouslySetInnerHTML={{ __html: data.html }} /></div>;
}
const nodeTypes = { card: CardNode };

function makeBoard(n: number, mode: CardData["mode"]) {
  const rng = seeded(9);
  const words = ["卡片笔记", "白板", "同步", "CRDT", "知识", "链接", "Tauri", "日记"];
  const text = (k: number) => Array.from({ length: k }, () => words[Math.floor(rng() * words.length)]).join("");
  const cols = Math.ceil(Math.sqrt(n));
  const nodes: Node<CardData>[] = Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    type: "card",
    position: { x: (i % cols) * 280 + rng() * 30, y: Math.floor(i / cols) * 260 + rng() * 30 },
    data: {
      title: `卡片 ${i} · ${text(2)}`,
      html: `<p>${text(14)}</p><ul><li>${text(5)}</li><li>${text(6)}</li></ul><p>${text(10)}</p>`,
      mode,
    },
  }));
  const edges: Edge[] = Array.from({ length: Math.floor(n / 2) }, (_, i) => ({
    id: `e${i}`,
    source: `c${Math.floor(rng() * n)}`,
    target: `c${Math.floor(rng() * n)}`,
  }));
  return { nodes, edges };
}

export type BoardResult = Record<string, unknown>;

function Runner({ n, mode, onDone }: { n: number; mode: CardData["mode"]; onDone: (r: BoardResult) => void }) {
  const flow = useReactFlow();
  // onDone changes on every parent render; read it through a ref so the tour
  // is not cancelled by a re-render.
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    let raf = 0;
    // Let the first render settle, then animate a pan+zoom tour for 6 s and
    // record every frame interval.
    const t = setTimeout(() => {
      const frames: number[] = [];
      let last = performance.now();
      const t0 = last;
      const tour = (now: number) => {
        frames.push(now - last);
        last = now;
        const p = (now - t0) / 6000;
        const zoom = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(p * Math.PI * 4));
        flow.setViewport({ x: -p * 4000, y: -Math.sin(p * Math.PI * 2) * 1500, zoom });
        if (now - t0 < 6000) raf = requestAnimationFrame(tour);
        else {
          const s = stats(frames.slice(5));
          done.current({ n, mode, frameMs: s, fps: +(1000 / s.mean).toFixed(1), jankPct: +((100 * frames.filter((f) => f > 20).length) / frames.length).toFixed(1) });
        }
      };
      raf = requestAnimationFrame(tour);
    }, 800);
    return () => {
      clearTimeout(t);
      cancelAnimationFrame(raf);
    };
  }, [flow, n, mode]);
  return null;
}

export function BoardBench({ auto, onResult }: { auto: boolean; onResult: (r: BoardResult[]) => void }) {
  const plan = useMemo(
    () => [
      { n: 300, mode: "preview" as const, visibleOnly: false },
      { n: 300, mode: "preview" as const, visibleOnly: true },
      { n: 300, mode: "title" as const, visibleOnly: true },
      { n: 1000, mode: "preview" as const, visibleOnly: true },
    ],
    [],
  );
  const [step, setStep] = useState(auto ? 0 : -1);
  const [results, setResults] = useState<BoardResult[]>([]);
  const cur = step >= 0 && step < plan.length ? plan[step] : null;
  const board = useMemo(() => (cur ? makeBoard(cur.n, cur.mode) : null), [cur]);

  const done = (r: BoardResult) => {
    const next = [...results, { ...r, onlyRenderVisible: cur!.visibleOnly }];
    setResults(next);
    if (step + 1 >= plan.length) onResult(next);
    setStep(step + 1);
  };

  return (
    <section>
      <div className="bar">
        <button disabled={cur !== null} onClick={() => { setResults([]); setStep(0); }}>
          运行白板帧率测试（300 / 1000 张卡片）
        </button>
        <span className="status">{cur ? `进行中：${cur.n} 张，${cur.mode === "preview" ? "预览" : "仅标题"}，${cur.visibleOnly ? "只渲染视口内" : "全部渲染"}` : results.length ? "完成" : ""}</span>
      </div>
      {results.length > 0 && <pre className="out">{JSON.stringify(results, null, 1)}</pre>}
      {cur && board && (
        <div className="board" key={step}>
          <ReactFlowProvider>
            <ReactFlow nodes={board.nodes} edges={board.edges} nodeTypes={nodeTypes} onlyRenderVisibleElements={cur.visibleOnly} minZoom={0.1} proOptions={{ hideAttribution: true }}>
              <Runner n={cur.n} mode={cur.mode} onDone={done} />
            </ReactFlow>
          </ReactFlowProvider>
        </div>
      )}
    </section>
  );
}
