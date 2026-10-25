# Folio

本地优先、以卡片为中心的笔记应用。Tauri 2 + React + Rust，数据存在 SQLite，用 Loro CRDT 做多设备同步。

- 方案与决策：[`design/ARCHITECTURE.md`](design/ARCHITECTURE.md)，ADR 在 [`design/adr/`](design/adr/)，调研在 [`design/research/`](design/research/)
- M0 技术预研的代码与数据：[`spike/`](spike/README.md)（只作参考与回归测试来源，不属于产品代码）

## 目录

```
crates/
  folio-core/     领域模型：文档 id、卡片文档结构（Loro）、内容提取；无 IO
  folio-store/    SQLite：唯一写入者、增量日志、派生索引、本机设置
  folio-sync/     客户端同步（M3）
  folio-io/       导入导出（M2 / M6）
  folio-mcp/      MCP 服务（M2）
  folio-server/   同步中继服务（M3）
src-tauri/      Tauri 2 外壳：IPC 命令、窗口、日志与诊断
web/            React 前端：设计系统、国际化、应用外壳、平台抽象
packages/       插件 SDK 与脚手架（M7）
plugins/        内置插件（M7）
scripts/        字体获取、测试等脚本
design/         方案文档
spike/          预研代码
```

## 开发

需要：Rust（stable）、Node.js、macOS 上的 Xcode Command Line Tools。

```bash
./scripts/fetch-fonts.sh
```

```bash
npm install
```

只看前端（浏览器 + 内存里的模拟后端）：

```bash
npm run dev
```

桌面应用（Tauri）：

```bash
npm run tauri dev
```

全部测试（Rust + 前端类型检查与单测）：

```bash
npm test
```

## 打包（GitHub Actions）

- `CI`：每次推送到 `main` 跑全部测试。
- `Build apps`：在 Actions 页面点 “Run workflow”，或推送 `v0.1.0` 这样的标签（同时生成草稿 Release）。产物在这次运行的 Artifacts 里，保留 14 天：
  - macOS（通用版 `.dmg`，未签名：首次打开需在“系统设置 → 隐私与安全性”里允许）、Windows（`.msi` / `.exe`）、Linux（`.deb` / `.rpm` / `.AppImage`）；
  - 安卓 `.apk`（arm64，用仓库 Secrets 里的 `ANDROID_KEYSTORE_B64` / `ANDROID_KEYSTORE_PASSWORD` 签名，密钥别名 `folio`）；
  - iOS 目前只检查能否编译；装到 iPhone 需要苹果开发者账号与签名（见 `design/ARCHITECTURE.md` 7.2）。
