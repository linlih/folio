# 应用图标（Logo）设计调研

> 日期：2026-10-24 · 目的：为应用图标设计提供依据
> 前提（已定，见 ARCHITECTURE.md 0.2）：视觉风格是“安静的纸面感”；正式名称未定（候选 “Folio 页”），所以图标最好不依赖英文名。
> 现有设计 token（`web/src/design/tokens.css`）：纸色 `#fdfaf6`、墨色 `#37352f`、强调色墨蓝 `#2f5d8a`（深色主题强调色 `#8cb4de`）。

## 0. 结论先行

1. **一个想法、一个形状**：优秀笔记类图标几乎都只有一个主体图形，占画布约 55–65%，居中，背景是纯色或很轻的渐变。
2. **负空间是最高级的手法**：Day One 的书签是“从一页纸上剪出来的”，iA Writer 只有一根光标。我们的图标优先考虑用一个形状 + 负空间讲完“卡片 / 页”。
3. **占有一个颜色**：Bear = 红、Things = 蓝、Day One = 天蓝、Agenda / Reeder = 黄、Obsidian = 紫。墨蓝与 Things、Drafts、Logseq 的冷色接近，**暖纸色背景 + 墨色主体**在这一类里反而少见，更容易被认出。
4. **为分层图标设计**：Apple 现在用分层图标（背景层 + 1–几个前景层，系统加 Liquid Glass 高光与折射）；Android 用自适应图标（前景 / 背景分开 + 单色主题图标）。所以图形要由**几块边缘清晰的实心形状**组成，不画阴影和高光。
5. **不放文字，除非是品牌本身**：Apple 指南不建议在图标里放文字；单个字母或单个汉字作为“品牌记号”是例外（Notion 的 N、Heptabase 的 h.）。「页」字可以作为备选方向，但英文用户只会把它当图形看。

## 1. 平台规范要点

| 平台 | 规范 | 对我们的影响 |
|---|---|---|
| Apple（iOS / iPadOS / macOS） | 1024×1024 方形、不带圆角（系统加遮罩）；分层：背景层 + 前景层，在 Icon Composer 里组合；需提供默认、深色、透明、着色几种外观，**各外观的核心图形保持一致**；不要自己画高光、阴影、斜面、模糊；避免极细线条和尖角；主体居中，防止遮罩裁切 | 源文件做成**方形无圆角的分层 SVG**；只用实心形状；准备深色和单色版 |
| Android 自适应图标 | 画布 108dp，前景主体放在中间 66dp 的安全圆内（系统会裁成圆、方、水滴等）；另需单色版供“主题图标” | 主体图形要能放进一个圆里，不能依赖四角 |
| Windows / Linux | 无系统遮罩，直接显示透明背景的图标 | 需要一个**带自身圆角底板**的版本 |
| 浏览器 favicon、托盘图标 | 16–32px | 主体形状在 16px 下仍能认出；托盘图标需要单色模板版本 |

来源：Apple Human Interface Guidelines “App icons”（2026-06 更新，已读原文）；Android 自适应图标规范为经验值，实施时再核对官方文档。

## 2. 优秀图标拆解（2026-10 App Store 当前图标）

| 产品 | 手法 | 可借鉴 |
|---|---|---|
| Day One | 天蓝底上一个白色书签，书签是负空间 | 一个形状讲完“日记 / 页”；颜色就是品牌 |
| iA Writer | 白底一根蓝色光标 | 极简到只剩一个元素，反而最好认 |
| Bear | 红底白色熊头剪影 | 用一个有情感的形象，而不是功能图形 |
| Things | 蓝色边框里一个对勾 | 功能直白，但靠颜色和比例做出高级感 |
| Notion | 立体方块里的衬线 N | 衬线字母 + 简单立体，传达“文档 / 出版物” |
| Heptabase | 白底 “h.” 字母 | 字母 + 句点，安静克制 |
| Obsidian | 紫色水晶 | 名字即图形（但我们的名字未定，不适用） |
| Ulysses | 黄色蝴蝶 + 笔尖 | 两个意象合一，但细节偏多 |
| Agenda | 黄色底上铅笔形成的 A | 字母与工具合一 |
| Craft | 四块彩色色块拼成 | 用几何块面表达“组合 / 积木” |

共同点：主体单一、轮廓清晰、16px 下仍然能认；颜色饱和度适中；近两年普遍带一点柔和渐变或玻璃质感（由系统或设计稿提供），但底层都是简单的实心形状。

## 2.1 第二轮：为什么前两轮草图“不好看”（2026-10-24）

第二次对比了 22 个公认做得好的图标（Flighty、Halide、Mercury Weather、CARROT、Structured、Things、Craft、Bear、Day One、Ivory、Mela、Notability、Noteshelf、Paper、Tot、Drafts、Timery、Crouton、Sofa、Gentler Streak、Overcast、Cardhop），把我们的草图放在旁边看，差距主要在“做工”，不在创意：

| 好图标的做法 | 我们前两轮草图 |
|---|---|
| **主体大**：占画布 65–80%，有的直接出血到边缘（Bear、Day One、Paper） | 主体只占 45–55%，显得拘谨、空 |
| **有光**：背景是上亮下暗的纵向渐变（Bear 的红、Things 的蓝、Sofa 的蓝） | 纯色平涂，显得闷 |
| **有材质**：前景像一个真实物件——Mela 的盘子、Crouton 的卡片抽屉、Cardhop 的一叠彩色卡片、Things 的板子；物件有轻微渐变、边缘有一圈亮边、下方有柔和投影 | 纯色几何块，像系统 UI 符号（文件、复制、列表） |
| **颜色饱满且有层次**：同色系里有 3–4 个明度；常有一个对比色做点睛 | 墨蓝偏灰、偏暗，只有 2 个明度 |
| **形状柔软**：粗笔画、大圆角、有“体积感” | 细节偏硬、偏平 |
| **有性格**：Bear 的熊、Ivory 的大象、Gentler 的软糖心 | 都是功能符号，没有情绪 |

精修手法（来自 Michael Flarup 的图标设计文章与 Apple Icon Composer 文档）：

- 先做很多变体排成一排比较，再删细节直到概念快要失效，然后只加回必需的部分。
- 在真实环境里测：Dock、手机桌面、App Store 搜索结果、设置列表，以及不同壁纸。1024 画布上的效果有欺骗性。
- 避免用滥的隐喻（例如通用的对勾）；用颜色或材质给熟悉的概念换个说法。
- Apple 平台：分层源文件里不烘焙阴影和高光，由 Icon Composer 加 Liquid Glass 效果；但 Windows / Android / 网页用的“扁平导出版”需要自己画好光影。所以要准备两套：**分层源文件**（干净形状）和**渲染版**（带渐变、亮边、投影）。
- 主体放在画布中央约 70% 的范围内。

来源：[Smashing Magazine — Eye-Catching App Icon Design](https://www.smashingmagazine.com/2017/01/designing-better-app-icons/)（Michael Flarup）；[Apple — Creating your app icon using Icon Composer](https://developer.apple.com/documentation/xcode/creating-your-app-icon-using-icon-composer)；[Create with Swift — Crafting Liquid Glass app icons](https://www.createwithswift.com/crafting-liquid-glass-app-icons-with-icon-composer/)（第三方）。

## 3. 对我们的设计要求

1. 不依赖英文名；表达“卡片 / 页 / 积累”。
2. 主体由 1–3 块实心形状组成，16px 可辨认。
3. 配色来自现有 token：纸色、墨色、墨蓝；深色模式用深纸色 `#1c1a17` 与浅墨蓝 `#8cb4de`。
4. 源文件为 1024 方形分层 SVG（背景层、前景层分开），另导出带圆角底板的通用版本和单色版本。
5. 最终定稿前在 Icon Composer（Apple）和 Android Studio 的自适应图标预览里实测。
