# Folio

[English](README.md) · **简体中文**

本地优先、以卡片为中心的笔记应用。笔记存在你自己设备上的 SQLite 里，用 Loro CRDT 在多台设备之间同步、不产生冲突。基于 Tauri 2、React 和 Rust。

- **卡片与日记**：同一个编辑器，支持大纲、待办、代码块、数学公式和卡片之间的链接。
- **卡片库与主题**：浏览、搜索、给卡片分组。
- **白板**：摆放卡片、连线、用小节框起来，用文字或卡片搭思维导图。
- **同步**（开发中）：端到端加密，经过你自己部署的服务器。
- **桌面与手机版式**：macOS、Windows、Linux、安卓，iOS 在计划中。

## 下载

在 [Releases](https://github.com/linlih/folio/releases/latest) 下载最新版本：

| 平台 | 文件 |
|---|---|
| macOS（Apple 芯片与 Intel） | `Folio_x.y.z_universal.dmg` |
| Windows | `Folio_x.y.z_x64-setup.exe` 或 `.msi` |
| Linux | `.AppImage`、`.deb` 或 `.rpm` |
| 安卓（arm64） | `folio-android-arm64.apk` |

桌面应用每天检查一次更新，安装前会先询问（Linux 上是 AppImage；`.deb` / `.rpm` 通过系统的包管理器更新）。安卓应用会在有新 APK 时提示。

安装包暂未经过苹果和微软签名。macOS 首次打开需在“系统设置 → 隐私与安全性”里允许；Windows 上点“更多信息 → 仍要运行”。

## 目录

```
crates/
  folio-core/     领域模型：文档 id、卡片文档结构（Loro）、内容提取；无 IO
  folio-store/    SQLite：唯一写入者、增量日志、派生索引、本机设置
  folio-sync/     客户端同步
  folio-io/       导入导出
  folio-mcp/      MCP 服务（让 AI 访问笔记）
  folio-server/   同步中继服务
src-tauri/      Tauri 2 外壳：IPC 命令、窗口、日志与诊断
web/            React 前端：设计系统、国际化、应用外壳、平台抽象
scripts/        字体、测试、发布等脚本
design/         方案与决策文档
spike/          早期技术预研，留作参考
```

计划中：`packages/`（插件 SDK）与 `plugins/`（内置插件）。

方案与决策：[`design/ARCHITECTURE.md`](design/ARCHITECTURE.md)，ADR 在 [`design/adr/`](design/adr/)，调研在 [`design/research/`](design/research/)。

## 开发

需要：Rust（stable）、Node.js 22+，macOS 上还需要 Xcode Command Line Tools。

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

全部测试（Rust，然后是前端类型检查与单测）：

```bash
npm test
```

## 构建与发布（GitHub Actions）

- **CI**：每次推送到 `main` 跑全部测试。
- **发布新版本**：`./scripts/release.sh 0.2.0 -m "更新说明" --push`。脚本更新所有版本号、提交，并推送一个标签，标签说明就是发布说明。标签会构建并发布 Release：安装包、签名的更新包、`latest.json`（已安装的应用据此检查更新）和安卓 APK。详见 `design/ARCHITECTURE.md` 7.3。
- **Build apps** 也可以在 Actions 页面手动运行：只构建、不发布，产物在这次运行的 Artifacts 里保留 14 天。
- **iOS** 目前只检查能否编译；装到 iPhone 需要苹果开发者账号与签名（见 7.2）。

签名密钥在仓库 Secrets 里：更新签名用 `TAURI_SIGNING_PRIVATE_KEY` 及其密码，APK 签名用 `ANDROID_KEYSTORE_B64` 和 `ANDROID_KEYSTORE_PASSWORD`。
