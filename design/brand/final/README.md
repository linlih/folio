# 应用图标定稿（2026-10-25）

定稿：扁平双色叶子（源自 `concepts/4-leaf-page.svg`）。“叶”与“页”同音，英文 leaf 也有“书页”之意。
颜色：纸色 `#fdfaf6`、墨蓝 `#2f5d8a`、浅墨蓝 `#8cb4de`、深纸色 `#1c1a17`。不加渐变、阴影、高光。

| 文件 | 用途 |
|---|---|
| `icon.svg` | 默认外观，1024 方形无圆角（iOS / App Store，系统加遮罩） |
| `icon-dark.svg` | 深色外观：深纸色底，两半深浅对调 |
| `icon-mono.svg` | 单色：透明底，浅半边 45% 透明度；用于着色外观、Android 主题图标、菜单栏模板图 |
| `icon-small.svg` / `icon-small-dark.svg` | 16–32px 专用：叶子放大 1.2 倍、去掉叶柄 |
| `icon-desktop.svg` | 桌面版（macOS / Windows / Linux 无系统遮罩）：824 圆角底板 + 柔和投影 |
| `icon-desktop-small.svg` | 桌面版的小尺寸版本（ICO 的 16/24/32） |
| `layers/` | Apple Icon Composer 分层源文件：背景、深色半叶（含叶柄）、浅色半叶 |
| `android/` | Android 自适应图标：前景已缩进 66dp 安全圆内、背景、单色 |
| `manifest.json` | `npx tauri icon design/brand/final/manifest.json` 的输入 |

## 重新生成 `src-tauri/icons/`

1. `npx tauri icon design/brand/final/manifest.json` —— 生成桌面、Windows Store、Android 全套。
2. iOS 要用全出血方形，不用桌面底板：`npx tauri icon design/brand/final/icon.svg -o <临时目录>`，把其中 `ios/` 复制到 `src-tauri/icons/ios/`。
3. 小尺寸：`icon-desktop-small.svg` 渲染 16/24/32，覆盖 `32x32.png`，并与 `icon-desktop.svg` 的 48/64/256 合成 `icon.ico`。

## 待办

- 上架 Apple 平台前，在 Icon Composer 里用 `layers/` 组装 `.icon`，检查默认 / 深色 / 透明 / 着色四种外观。
- 在真实桌面、不同壁纸、App Store 搜索结果里看一次。
