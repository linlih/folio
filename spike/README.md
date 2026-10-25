# M0 预研：Loro vs Yjs

对应 `design/ARCHITECTURE.md` §8.1。两套原型功能相同，只换 CRDT 层；结论写在 `design/adr/0001-crdt-choice.md`。

## 目录

| 路径 | 内容 |
|---|---|
| `web/src/editor/extensions.ts` | 共享的 TipTap 扩展：StarterKit、任务列表、图片、块 id（`bid`）规范化 |
| `web/src/engines/{loro,yjs}.ts` | 两个 CRDT 适配层（`Peer` 接口），只有这里不同 |
| `web/src/harness/` | 随机编辑操作、不变量检查、模拟网络（离线 / 乱序 / 重连握手） |
| `web/src/bench/bench.ts` | 打开耗时、按键耗时、一年期存储增长 |
| `web/src/board/BoardBench.tsx` | xyflow 白板帧率（300 / 1000 张卡片） |
| `web/src/main.tsx` | 浏览器页面：编辑实验室（手动 / 输入法）、性能、白板帧率 |
| `web/patches/y-prosemirror/` | 修复 NodeSelection 崩溃的一行补丁版（仅 `YPM_PATCH=1` 时启用） |
| `rust/` | Rust 侧 `DocEngine`（loro / yrs）、SQLite store、白板收敛、互通、加载耗时 |
| `tauri/` | 最小 Tauri 2 外壳，在 macOS WKWebView 里自动跑性能 + 白板测试 |
| `fixtures/` | JS ↔ Rust 互通用的数据 |
| `results/` | 所有测试输出（JSON） |

## 复现

Rust 工具链用 Homebrew 的 rustup：`export PATH=/opt/homebrew/opt/rustup/bin:$PATH`。

```bash
cd spike/web && npm install
```

标准 1、2（编辑器正确性 50×60 步；三副本并发合并 200×500 = 10 万步）：

```bash
ENGINE=loro npx vitest run test/criteria12.test.ts
```

```bash
ENGINE=yjs npx vitest run test/criteria12.test.ts
```

```bash
YPM_PATCH=1 ENGINE=yjs npx vitest run test/criteria12.test.ts
```

标准 3、4（jsdom 下的性能、一年期存储增长）：

```bash
BENCH=perf npx vitest run test/criteria34.test.ts
```

```bash
BENCH=growth npx vitest run test/criteria34.test.ts
```

Rust 侧（白板收敛 10 万步、SQLite 存取、一年期卡片加载）：

```bash
cd spike/rust && cargo test --release -- --nocapture --test-threads=1
```

标准 5（互通，三步，顺序执行）：

```bash
cd spike/web && INTEROP=export npx vitest run test/interop.test.ts
```

```bash
cd spike/rust && cargo test --release --test interop -- --nocapture
```

```bash
cd spike/web && INTEROP=verify npx vitest run test/interop.test.ts
```

（再跑一次 Rust 的 interop 会验证“JS 在 Rust 写入后继续编辑”的回程。）

浏览器页面（编辑实验室 / 性能 / 白板）：

```bash
cd spike/web && npm run dev
```

macOS WKWebView 自动跑性能 + 白板（需先启动上面的 dev server），结果写到 `results/webview-*.json`：

```bash
cd spike/tauri/src-tauri && cargo run
```

用环境变量 `SPIKE_AUTO` 选择页面（`typo` 排版试验、`css` 排版特性检测、`perf`、`board`），例如在 WKWebView 里打开排版试验页：

```bash
cd spike/tauri/src-tauri && SPIKE_AUTO=typo cargo run
```

## 排版试验页

对应 `design/research/ui-research.md` 第 6 节，代码在 `web/src/typo/`。在浏览器打开 `http://localhost:5199/?auto=typo`，或用上面的命令在 WKWebView 里打开。

- 左侧调参数：快速方案（A/B/C 三种字体组合）、英文/中文正文字体、标题字重、字号、行高、段间距、行宽、调色板（含一个无暖色的对照组）、浅色/深色、强调色、次要文字深浅、排版特性开关（标注当前 WebView 是否支持）、图标库与线宽。
- 右侧是应用窗口的切片：侧栏、标签栏、日记、两张卡片（中文、英文）、右侧面板，以及排版难点（连续标点、行首行尾标点、中西文混排、日文、长英文单词）。正文区可以直接编辑，可以粘贴自己的笔记、试输入法。
- 颜色区实时显示 WCAG 对比度，正文和次要文字要求 ≥ 4.5:1。
- “导出 token”：在 Tauri 里保存到 `results/webview-typography-tokens.json`，在浏览器里下载为 JSON；“复制 CSS 变量”得到可直接用于设计系统的变量。设置会记在本机，刷新不丢。
- 英文衬线字体和思源宋体从 Google Fonts 加载，需要联网；离线时会回退到系统字体，预览就不准了。

## 已知限制

- **没有真机数据**：本机没有完整 Xcode 和 Android SDK，标准 3 的移动端数字缺失。macOS WKWebView 与 iOS 同引擎，可作参考；Android WebView 与 Chromium 同引擎。
- **中文输入法**需要真实键盘组合事件，只能在“编辑实验室”页面手动测试。
- jsdom 下的耗时只用于两库之间的相对比较，绝对值以 WebView 数据为准。
