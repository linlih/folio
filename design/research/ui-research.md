# UI 设计调研报告

> 日期：2026-10-23 · 目的：为“排版试验页”和设计系统提供依据
> 前提（已定，见 ARCHITECTURE.md 0.1–0.2）：先把基础记录做好、熟悉顺手不追新奇、全球化多语言、以卡片为中心、日记连续日记流、视觉风格为“安静的纸面感”。
>
> 说明：来源多为第三方评测、论坛和厂商资料，可信度标在正文里；标注“经验值”的是我的通用设计经验，未经本次调研验证，需在试验页里实测。

## 0. 结论先行

1. **纸面感的核心是排版，不是装饰**：暖米白底 + 暖近黑墨色（不用纯黑纯白）、正文衬线字、宽行距、适中行宽、一个克制的强调色、极细分隔线、无阴影无渐变。
2. **字体是最大的未决项**：英文衬线有三个 OFL 开源候选（Literata、Source Serif 4、Newsreader）；中文衬线（思源宋体 / Noto Serif CJK）体积很大，Windows 和 Android 没有好看的系统宋体。要在试验页里对比“中文用系统黑体”和“中文用打包的宋体”两种方案。
3. **多语言排版特性在两类 WebView 里支持不同**（本次实测）：中西文自动间距两边都支持；中文标点挤压只有 Chromium 支持，标点悬挂只有 WebKit 支持。设计上把这些当作“锦上添花”，在不支持的平台上自然退化。
4. **组件底层**：通用控件以 shadcn/ui 为代码起点（代码归我们所有），底层原语在 Radix 和 Base UI 之间二选一（Base UI 更活跃，建议新项目用它，待确认）；命令面板用 cmdk；图标在 Lucide 和 Phosphor 之间选，试验页里对比。
5. **动效**：优先用 CSS 过渡和 View Transitions（两类 WebView 都支持），只在退出动画、手势、可打断的布局动画上引入 Motion 库的精简版。
6. **你给的两个网站**（affectUI、uiarc）：适合以后做 AI 功能时借鉴，不适合当主界面基础；付费组件的许可证与开源兼容性需确认。
7. **交互上最值得借鉴的**：Linear 的键盘优先与“乐观更新”（操作立即生效）、Things / Trilium 式的“一键进入快速记录、内容先进收件箱”、Capacities 的“日记里显示当天创建的内容”、Heptabase 的卡片库时间线和白板整理助手。

---

## 1. 竞品界面拆解

| 产品 | 值得借鉴 | 要规避 | 来源可信度 |
|---|---|---|---|
| **Heptabase** | 卡片库与白板两个视图同步；卡片库可快速筛选、可按时间线查看（新的在上）；白板整理助手：卡片自动散开、分区随内容自动增长、适应内容、一键整理、键盘导航 | 单块白板卡片太多会变慢，官方建议拆分白板（与我们预研中 LOD 的结论一致）；价格高 | 官方 wiki + 第三方评测 |
| **Logseq** | 大纲记录的手感；日记作为默认入口；块引用 | 移动端卡顿（旧版本报告：启动约 5 秒、输入卡顿）；同步慢、冲突；大图谱时搜索变慢、索引时卡死；界面“朴素到乏味”；日记总是打开今天，规划未来日期不方便；不会写插件就很难定制 | 论坛、评测站，部分为旧版本 |
| **Obsidian** | 移动端流畅；定制性强 | 需要事先规划结构（与 Logseq 的“结构自然生长”相对） | 论坛评论 |
| **Capacities** | 按“这是什么”而不是“放在哪”组织（对象类型 + 属性，接近我们的“标签即数据库”）；日记页显示当天创建的所有内容，日历串起每一天；界面干净、快速记录方便 | 移动端明显落后于桌面端；有学习曲线；AI 功能付费且限次 | 评测与聚合站（评分 4.8，66 条评价） |
| **Bear** | 排版优先：正文 16px、行高约 27px（约 1.7）；用户可调字体、字号、行距、行宽；行内标签代替文件夹；专注模式 | — | 第三方设计拆解（数值为二手） |
| **Craft** | “精装出版物”的气质：暖米白画布、近黑“墨色”文字（不用纯黑）、大号常规粗细的衬线标题 | — | 第三方设计 token 摘要 |
| **iA Writer** | “排版就是界面”：去掉工具栏和格式面板，只留文字；专注模式（淡化当前句子或段落以外的内容） | 等宽 / 半等宽字体的取向不适合我们（我们要舒展的阅读排版） | 官方 + 评测 |
| **Linear**（交互参考） | 键盘优先：`Cmd+K` 命令面板、`j/k` 或方向键在条目间移动、回车打开；乐观更新，操作立即出现在界面上；“速度本身就是功能” | 键盘优先的设计照搬到手机上体验差，手机要单独设计；它的视觉风格被大量模仿，没有背后的理由只学样子会显得空洞 | 第三方拆解 |
| **Tana、Reflect** | — | 本次检索没有找到可用资料，未覆盖 | — |

**对我们的启示**
- 我们的核心模型（日记收件箱 → 提炼成卡片 → 白板组织）正好处在 Logseq（记录强、组织弱）和 Heptabase（组织强、记录弱）之间，应各取所长。
- Logseq 用户最大的抱怨（慢、同步冲突、大库卡顿、手机卡）在我们的架构里都有针对性设计（Rust 核心、CRDT、索引、性能预算），这些本身就是界面体验的一部分。
- 新增两条小设计：日记日历允许打开**未来日期**（用于规划）；日记的右侧面板借鉴 Capacities，显示**当天创建或修改的卡片**。

## 2. 视觉语言

### 2.1 颜色：纸面调色板

| 参考 | 浅色：底 / 文字 | 深色：底 / 文字 |
|---|---|---|
| Ember Paper 设计系统 | `#FDFAF6` / `#37352F` | `#1C1A17` / `#F4F0EA` |
| Obsidian 主题 Warm Paper | `#F5F2ED` / `#1C1B19` | `#1E1D1B` / `#EDEAE4` |
| Convictional 品牌手册 | `#FFFDF5`（暖米白）+ 石色阶梯 | 要求所有颜色两种模式都能用，用语义 token 而非写死色值 |

原则（来自 E-Ink 设计套件、W3C 邮件列表的“纸面阅读”讨论、Ember Paper 的质量标准）：
- 暖米白底（约 `#FBF8F2`–`#FDFAF6`）+ 暖近黑墨色（约 `#1C1B19`–`#37352F`）；避免纯黑配纯白，长时间阅读刺眼。
- 至多一个低饱和的强调色（用于链接、选中）；分隔线用极细线；不用光晕和渐变。
- **次要文字在米白底上也要满足 4.5:1 对比度**（容易被忽略）。
- W3C 讨论里的一个细节：整片米白底会被眼睛“适应”成白色，界面上可能需要少量纯白元素作参照；深色模式的文字亮度要相对背景来定。
- 深色模式用暖炭灰底 + 柔和米白字，不做纯黑。

### 2.2 字体

**英文正文衬线**（均为 OFL 开源、可商用、有可变字体与光学尺寸轴）：

| 字体 | 特点 |
|---|---|
| Literata | 为 Google Play 图书设计，专为长时间屏幕阅读；有光学尺寸轴，资料中最偏“阅读” |
| Source Serif 4 | Adobe 出品，跨平台渲染一致性最好（hinting 做得好）；过渡体衬线 |
| Newsreader | 偏报刊编辑风格；资料较少 |

**中文正文**：
- 系统字体：macOS / iOS 有苹方（黑体）和宋体-简；Windows 默认是微软雅黑（黑体），系统宋体（SimSun）在屏幕上效果差（经验值）；Android / Linux 通常是 Noto Sans CJK（黑体）。
- 打包宋体：思源宋体 / Noto Serif CJK，OFL 许可，允许打包和裁剪字符集。**体积是主要问题**：一个包含五种语言变体的可变字体包约 56.8 MB；只要简体中文、单一字重能小很多，但具体大小需要实测。用户输入的内容不可预知，不能只裁出“用到的字”，只能按 GB 18030 等标准字集裁剪，或者首次使用时按需下载。
- 待试验页决定的组合：
  - A：英文衬线 + 中文系统黑体（体积零增加，四个平台都好看，但中英文风格不完全统一）；
  - B：英文衬线 + 中文打包宋体（最“纸面”，但安装包大幅增加或需要按需下载）；
  - C：全部使用系统字体（最轻，纸面感最弱）。
- 界面字体（侧栏、菜单）用系统无衬线字体即可，和正文区分开。
- 代码用等宽字体（如 JetBrains Mono、IBM Plex Mono，经验值，均为开源）。

**版式参数**（起点，试验页里调）：
- 英文正文约 16px、行高约 1.6–1.7、行宽约 65 个字符（E-Ink 套件与 Bear 的数值）。
- 中文行高通常要比英文更大，行宽以 30–40 个汉字为宜（经验值）。
- 标题用常规粗细的大号字（Craft 的做法），不靠加粗制造层级。

### 2.3 图标

| 图标库 | 特点 | 许可 |
|---|---|---|
| Lucide | 源自 Feather，24px 网格、2px 线条，简洁；React / Vue 项目最常用 | ISC / MIT（各来源说法不一） |
| Tabler | 风格同 Lucide，数量最多（约 5,000–6,000），有填充版本；常用于后台和仪表盘 | MIT |
| Phosphor | 六种粗细（含 Thin、Light），风格变化最多 | MIT |

纸面风格倾向“细、轻、少”：**Lucide（细线条）或 Phosphor 的 Light 粗细**最可能合适，在试验页里对比。

### 2.4 动效

- CSS 过渡和原生 View Transitions：**两类 WebView 本次实测都支持**，不增加任何体积，优先使用。View Transitions 默认不可打断，不适合小交互。
- Motion 库（原 Framer Motion）：完整版约 34–50 KB（gzip，各来源不一），精简加载方式约 4.6 KB；擅长退出动画、手势、可打断的布局动画和弹簧效果。只在这些场景引入。
- 所有动效遵守 0.2 节：≤ 200 ms、可打断、尊重“减少动态效果”。

## 3. 组件技术栈

| 层 | 建议 | 理由 |
|---|---|---|
| 通用控件代码 | **shadcn/ui** 作为起点 | 代码复制进项目、归我们所有，不是依赖包；与“工具掌握在自己手里”一致。默认外观要用纸面风格的 token 彻底改造 |
| 无样式原语 | **Base UI 或 Radix**（建议 Base UI，待确认） | 两者都提供可访问的弹窗、菜单、标签页等。Base UI 由 MUI 维护，据介绍 2026 年发布 1.0，更新更活跃；Radix 部分复杂组件（如组合框）更新变慢。shadcn/ui 现在两者都支持。ARCHITECTURE.md 目前写的是 Radix，确认后同步修改 |
| 命令面板 | **cmdk** | 使用最广（周下载约 3,380 万，v1.1.1），给出原语、由我们决定外观和过滤逻辑；kbar 仍是 beta |
| 编辑器 / 白板 | TipTap / xyflow（已定） | 两个参考网站都没有富文本编辑器和侧栏组件，这部分无论如何都要自己做 |

**你提到的两个网站**

| | affectUI | uiarc（Arc） |
|---|---|---|
| 内容 | 面向 AI 产品的 React 组件、页面和区块，116+；AI 回答、对话输入框、“思考中”状态、写作助手、命令菜单、日期选择、提示条等 | 183 个带动效的组件、110 个区块；命令面板、提示条、确认交互、数据表格等 |
| 接入 | 复制代码，支持 shadcn 命令行和 MCP，可交给 AI 工具安装 | 同上 |
| 定价 | 40 个免费；Pro 个人一次性 $199，团队 $499 | 部分免费；Pro 一次性 $249 |
| 风格 | 干净现代 | 动效很重 |
| 建议 | M6 做应用内 AI 功能时参考它的 AI 组件交互 | 参考命令面板等交互思路；动效风格与纸面感不符 |

**许可证风险**：本项目计划开源。付费的 Pro 组件通常不允许随开源项目再分发源码；两者的具体许可条款本次未找到，使用前必须确认。

## 4. 交互模式

1. **键盘优先**（Linear）：`Mod+K` 命令面板覆盖搜索、跳转、执行操作；列表里方向键或 `j/k` 移动、回车打开；所有常用操作有快捷键。手机端另行设计，不照搬。
2. **乐观更新**（Linear）：任何操作立即反映在界面上。我们的本地优先架构天然支持：先写本地，同步在后台进行。
3. **快速记录**（Things、Trilium、NotePlan 用户反馈）：
   - 一个快捷键**直接进入输入**，不经过菜单；
   - 记录窗口在点到别处时**保留未写完的内容**；
   - 内容默认进入“收件箱”（我们的日记），整理可以晚点做；
   - 记录入口始终可见（手机上的悬浮按钮）。
4. **日记**（Capacities、Logseq 用户反馈）：日历可打开未来日期；日记右侧面板显示当天创建或修改的卡片。
5. **卡片库**（Heptabase）：可按时间线查看（新的在上），筛选要快。
6. **白板**（Heptabase）：整理助手（自动散开、分区自动增长、适应内容、一键整理）、键盘导航；卡片很多时提示拆分白板。属于 M5，此处先记录。

## 5. 多语言排版：WebView 支持实测

2026-10-23 在本机实测（`CSS.supports`）。Chromium 152 代表 Windows 的 WebView2 和 Android WebView；macOS WKWebView 代表 iOS（同一引擎）。Linux 的 WebKitGTK 未测。原始数据：`spike/results/webview-css.json`、`spike/results/chromium-css.json`。

| 特性 | 作用 | Chromium | WKWebView | 我们的用法 |
|---|---|---|---|---|
| `text-autospace: normal` | 中西文、数字之间自动加间距 | ✅ | ✅ | 默认开启 |
| `text-autospace` 细粒度值 | 分别控制字母和数字的间距 | ❌ | ✅ | 不依赖 |
| `text-spacing-trim` | 中文标点挤压（连续标点、行首行尾） | ✅ | ❌ | 渐进增强；WebKit 下尝试字体特性 `chws` 作为替代（需确认所选字体是否包含该特性） |
| `font-feature-settings: 'chws'` | 字体级的标点间距调整 | ✅ | ✅ | 同上 |
| `hanging-punctuation` | 标点悬挂到行外，版心更齐 | ❌ | ✅ | 渐进增强 |
| `text-wrap: pretty` | 避免段末孤字等，更好的断行 | ✅ | ✅ | 正文开启 |
| `text-wrap: balance` | 标题各行长度均衡 | ✅ | ✅ | 标题开启 |
| `line-break: strict` | 更严格的中日文断行（避头尾） | ✅ | ✅ | 开启 |
| `word-break: auto-phrase` | 日文按词组断行 | ✅ | ❌ | 仅日文，渐进增强 |
| `hyphens: auto` | 英文断词 | ✅ | ✅ | 正文开启（需正确的 `lang` 属性） |
| `font-optical-sizing` | 可变字体光学尺寸 | ✅ | ✅ | 开启 |
| View Transitions | 原生页面转场 | ✅ | ✅ | 用于标签页、视图切换 |

**启示**：每个块要带正确的 `lang` 属性（中文、英文、日文），断行、断词、间距规则才能生效。块的语言可以按内容自动检测、允许手动指定。

## 6. 排版试验页的设计

**要能实时调整的变量**
- 正文英文字体：Literata / Source Serif 4 / Newsreader / 系统衬线 / 系统无衬线；
- 正文中文字体：系统黑体 / 系统宋体（仅 macOS）/ 打包的思源宋体；
- 字号、行高、段间距、行宽（版心宽度）；
- 调色板：3–4 套纸面配色（含上表参考值），浅色、深色切换；强调色；
- 排版特性开关：自动间距、标点挤压、标点悬挂、`text-wrap: pretty`；
- 图标：Lucide / Phosphor Light / Tabler 并排。

**示例内容**（中、英、混排都要有）
- 一段日记（大纲：多级列表、任务、标签、链接）；
- 一张卡片（标题、段落、小标题、引用、列表、代码块、块引用）；
- 侧栏和右侧面板的片段，用来看界面字体和正文字体的搭配；
- 刻意构造的排版难点：连续标点、行首行尾标点、中英数字混排、长英文单词、日文。

**输出**：一组设计 token（颜色、字体栈、字号阶梯、行高、间距、圆角、动效时长），可导出为 CSS 变量，作为 M0 设计系统初版的输入。

## 7. 待决定与风险

1. **中文字体方案**（A / B / C，见 2.2）及其安装包体积；如选打包宋体，是随安装包附带还是首次使用时下载。
2. **Base UI 还是 Radix**；确认后同步修改 ARCHITECTURE.md 技术选型表。
3. **图标库**。
4. **WebKitGTK（Linux）** 的排版特性支持未测，M0 在 Linux 上补测。
5. **付费组件许可**：若要使用 affectUI / uiarc 的 Pro 组件，先确认许可证与开源是否兼容。
6. Tana、Reflect 的界面资料本次未找到；如需要，可以另做一次针对性调研。

## 8. 第一版推荐参数（已被第 9 节取代）

2026-10-23 的第一版推荐，只依据排版原则、没有参考同类软件的实际默认值。第 9 节用同类软件的数据修订了字体、行高、段距、行宽；颜色和对比度部分仍然有效。

| 参数 | 推荐值 | 理由 |
|---|---|---|
| 字体方案 | **A：Literata + 中文系统黑体** | 英文衬线带来纸面感；Literata 专为屏幕长时间阅读设计。中文用系统黑体：四个平台都有、安装包零增加；Windows 和 Android 没有好看的系统宋体，打包思源宋体要几十 MB。思源宋体可以以后作为可下载的“阅读主题”提供 |
| 标题字重 | 常规（400） | 纸面风格靠字号而不是加粗区分层级（Craft 的做法）；若中文标题显得发虚，改为中等（500） |
| 字号 | 16 px | 与 Bear 一致的行业常用值；中文 16 px 在各平台都清晰 |
| 行高 | 1.75 | 英文舒适区约 1.6–1.7，中文约 1.7–1.9（经验值）；混排取中间值 |
| 段间距 | 0.6 em | 行高已经较宽；笔记里短段落多，段距再大会显得松散 |
| 行宽 | 560 px | 实测约 74 个英文字符 / 35 个汉字每行，两种语言都落在舒适区间（英文 45–75，中文 30–40）。600 px 时英文约 80 字符，偏长 |
| 调色板 | Ember Paper | 暖米白 `#FDFAF6` + 暖墨色 `#37352F`，对比度 11.78 : 1，柔和又清楚；Warm Paper 的底色更暗、偏灰，Cream Stone 偏黄 |
| 强调色 | 墨蓝 `#2F5D8A`（深色 `#8CB4DE`） | 链接一眼能认出来；呼应“墨色”的意象；对比度 6.61 : 1 |
| 次要文字深浅 | 0.72 | 原默认 0.68 在浅色模式下实测 4.49 : 1、侧栏上 4.22 : 1，低于 4.5；0.72 实测 5.04 / 4.74 : 1 |
| 提示文字 | 0.55（固定） | 原 0.45 浅色下仅 2.47 : 1；0.55 实测 3.15 : 1（浅色）、5.46 : 1（深色） |
| 排版特性 | 全部开启 | 都是渐进增强，不支持的平台自动忽略 |
| 图标 | Lucide，线宽 1.5 | 最常用、风格统一；默认 2 px 线宽在衬线正文旁显得粗重。Phosphor Light 更精致，但在非高分屏上可能发虚（经验值），可对比 |

## 9. 同类软件的默认排版（实测 / 读源码）与修订后的推荐

2026-10-23 调研。开源软件读源码里的默认值；闭源软件在内置浏览器里打开它们**公开发布的页面**测量实际渲染样式（与应用内编辑器可能略有差异）；Craft、Bear 只有官网营销页的二手拆解，可信度最低。

| 软件 | 正文字体（默认） | 字号 | 行高 | 版心宽度 | 段距 | 可选字体样式 | 数据来源 |
|---|---|---|---|---|---|---|---|
| Logseq | Inter | 16 px | 1.5 | 960 px（含大纲缩进） | — | 无衬线 / 衬线（Lyon Text → Georgia）/ 等宽（iA Writer Mono） | 源码 |
| tine | Inter | 16 px | 1.5 | 810 px | — | — | 源码 |
| AFFiNE | Inter | **15 px** | ≈1.53（1em + 8px） | 944 px | — | 无衬线 / 衬线（Source Serif 4）/ 等宽 | `@toeverything/theme` 包 |
| Outline | 系统字体（-apple-system、Inter、Segoe UI…） | 16 px | 1.5；**中日韩 1.8** | 52 em ≈ 832 px | 中日韩 0.8 em | — | 源码 |
| 思源笔记 | 系统字体 | 16 px（界面 14 px） | 约 1.625 | 默认全宽 | — | 可自定义字体、字号 | 源码 |
| Joplin | 系统字体 | 编辑器 15 px / 阅读 16 px | — | 默认全宽（设置说明推荐 600） | — | 可自定义 | 源码 |
| AppFlowy | 系统字体 | 16 px | 1.4 | 可调 480–1920 px | — | 可选字体 | 源码 |
| Obsidian | 系统字体（ui-sans-serif、-apple-system…、Inter） | 16 px | 1.5 | **700 px** | 1 rem | 可选字体 | 官方帮助站（Obsidian Publish）实测 |
| Notion | 系统字体（含 PingFang SC、Microsoft YaHei） | 16 px | 1.5 | **720 px** | — | 默认 / 衬线 / 等宽、小字号、全宽 | 公开页面实测（1440 px 宽视口） |
| Heptabase | Inter | 16 px | **1.8** | 720 px | 16 px | — | 公开 wiki 实测（非应用内编辑器） |
| Craft（官网） | Untitled Sans；标题 Untitled Serif | 16 px | 1.6 | 正文 680 px | — | — | 第三方拆解，二手 |
| Bear（官网） | Bear Sans | 16 px | 1.7 | 约 800 px | — | — | 第三方拆解，二手 |

文字颜色：Notion `#2C2C2B`、Heptabase `#2E2E2E`、Obsidian `#222222`；背景几乎都是纯白，只有 Craft 官网用暖米白 `#FCF9F7`。

**规律**
1. **字号：16 px 几乎是共识**（只有 AFFiNE 15 px、Joplin 编辑器 15 px）。
2. **字体：同类软件几乎都默认无衬线**（Inter 或系统字体），**衬线只作为可选项**。Logseq、AFFiNE、Notion 都提供“无衬线 / 衬线 / 等宽”三选一。我们第一版推荐的“默认衬线”与惯例相反。
3. **系统字体 vs 打包 Inter**：Notion、Obsidian、Outline、思源、AppFlowy 用系统字体；Logseq、tine、AFFiNE、Heptabase 打包 Inter。系统字体零体积、在各系统上渲染最自然，中文本来就会回退到系统字体（苹方、微软雅黑）。
4. **行高分两派**：工具型 1.5（Obsidian、Notion、Logseq、Outline），阅读型 1.6–1.8（Craft、Bear、Heptabase、思源）。Outline 对中日韩单独提高到 1.8。
5. **版心：文档型 680–720 px**（Craft、Obsidian、Notion、Heptabase），大纲型更宽（810–960 px，要给缩进留空间）。这比排版理论的最佳行长（英文 45–75 字符）要宽：按 16 px 系统字体，680 px 约 94 个英文字符、43 个汉字（试验页实测）。主流产品选择了“空间利用”而不是“最佳行长”。
6. **允许用户调整是惯例**：字体样式、字号、全宽几乎每家都有。

**修订后的推荐（已设为试验页默认值）**

| 参数 | 第一版 | 修订后 | 理由 |
|---|---|---|---|
| 正文字体 | Literata + 中文系统黑体 | **系统无衬线 + 中文系统黑体**（方案 C） | 符合同类软件惯例与“熟悉顺手”原则；零体积；各平台最自然。衬线（Literata / Source Serif 4，可配思源宋体）和等宽作为可选样式，与 Logseq、AFFiNE、Notion 一致 |
| 标题字重 | 400 | **500** | 无衬线标题用常规粗细显得发虚；同类软件标题多为 500–600 |
| 行高 | 1.75（统一） | **英文 1.6，中日韩 1.8** | 位于“阅读型”一派，比工具型的 1.5 舒展，契合纸面感；按语言区分是 Outline 的做法，中文笔画密需要更大行高 |
| 段距 | 0.6 em | **0.75 em** | 同类软件约 1 em（Obsidian、Heptabase）或 0.8 em（Outline 中日韩）；行高已较大，取略小值 |
| 行宽 | 560 px | **680 px** | 与 Craft 一致，接近 Obsidian 700、Notion 720，用户熟悉；大纲缩进会吃掉一部分宽度。代价是一行较长，可以提供“窄版心”或“全宽”选项 |
| 调色板、强调色、对比度 | 不变 | 不变 | 纸面感主要由暖米白底色和留白承担，这也是与纯白底的同类软件最直观的区别 |

**最终选择（2026-10-23，用户决定）**：对比思源黑体、苹方、霞鹜文楷、思源宋体后，正文选定**思源宋体 + Source Serif 4**（同属 Source 家族）。因此上表“正文字体”一行以此为准；无衬线（系统字体）改为可选样式。其余参数（标题 500、行高英文 1.6 / 中日韩 1.8、段距 0.75 em、版心 680 px、配色）不变，作为试验页默认值。体积：Noto Serif SC 可变字体约 24 MB，Source Serif 4 约 2 MB（google/fonts 仓库实测文件大小）。分发方式已定：桌面端随安装包内置，手机端首次启动按需下载（见 ARCHITECTURE.md 0.2 第 7 条）。

**对“用户可自定义”的启示**：按惯例提供三种正文样式（默认无衬线 / 衬线 / 等宽）、字号、版心宽度（默认 / 窄 / 全宽）、浅色深色与调色板。

---

## 来源

竞品与交互
- Heptabase：[官方 1.0 介绍](https://wiki.heptabase.com/version-one)、[公开路线图](https://wiki.heptabase.com/roadmap)、[2023-12 通讯](https://wiki.heptabase.com/newsletters/2023-12-28)、[Outliner Software 论坛](https://outlinersoftware.com/topics/viewt/9723)、[Tooliverse 评测](https://tooliverse.ai/tools/heptabase)、[Tana 的对比文章（有立场）](https://tana.inc/blog/best-heptabase-alternatives-2026)、[用 Heptabase 写日记](https://katisplaying.substack.com/p/heptabase-diary)、[devtoollab](https://devtoollab.com/ai-tools/heptabase)、[vantaige](https://vantaige.io/ai-tool/heptabase)
- Logseq / Obsidian：[Logseq 论坛：Android 很慢](https://discuss.logseq.com/t/android-app-very-slow-which-evolution/16608)、[Logseq vs Obsidian 讨论](https://discuss.logseq.com/t/thoughts-on-logseq-vs-obsidian/8614)、[Making Obsidian play nice with Logseq](https://discuss.logseq.com/t/making-obsidian-play-nice-with-logseq/1185?page=4)、[toolguide 评测](https://toolguide.io/en/tool/logseq/)、[DEV 文章](https://dev.to/koshirok096/the-daily-list-dilemma-logseq-obsidian-and-other-contenders-bite-size-article-218j)、[Lemmy 讨论](https://feddit.it/post/371116)、[hackliberty](https://links.hackliberty.org/post/761844/1584222)、[agnos](https://forum.agnos.is/post/https%3A%2F%2Flemm.ee%2Fcomment%2F18400628)
- Capacities：[官网](https://capacities.io/)、[入门文档](https://docs.capacities.io/tutorials/getting-started)、[Saner 评测](https://www.saner.ai/blogs/capacities-review)、[Tooliverse 评测](https://tooliverse.ai/tools/capacities)、[Product Hunt](https://www.producthunt.com/products/capacities/shoutouts)、[Yahoo 文章](https://tech.yahoo.com/articles/little-known-android-productivity-app-101810173.html)、[G2](https://www.g2.com/sellers/capacities)、[yespress](https://yespress.io/capacities)、[choppingblock](https://www.choppingblock.ai/companies/capacities)
- Bear / Craft：[Bear 设计研究](https://blakecrosley.com/guides/design/bear)、[Bear 设计 token](https://www.shadcn.io/design/bear/raw)、[Bear 设计 md](https://www.webdesignhot.com/design.md/bear-app/)、[Craft 设计 token](https://www.webdesignhot.com/api/design-md/craft.md)、[Bear 社区](https://community.bear.app/t/typewriter-mode-themes/19298)、[Craft vs Bear](https://www.craft.do/it/compare/bear)、[Fabric 对比（厂商）](https://fabric.so/comparison/best-aesthetic-notes-app)、[极简笔记合集](https://rigorousthemes.com/blog/best-minimalist-note-taking-apps/)
- iA Writer：[Writer vs Word](https://ia.net/topics/writer-vs-word)、[ia.net 2017](https://ia.net/topics/2017)、[ia.net](https://ia.net/?p=27484)、[ia.net Fast Company 引用](https://ia.net/?p=1599)、[ia.net](https://ia.net/?p=261)、[tonsky 博客](https://tonsky.me/blog/sublime-writer/)、[Hack Design](https://www.hackdesign.org/toolkit/ia-writer/)、[Macworld 评测](https://www.macworld.com/article/2985482/ia-writer-3-0-1-review-mac-app-gets-back-to-basics-for-focused-writing.html)
- Linear：[925studios 拆解](https://www.925studios.co/blog/linear-design-breakdown-saas-ui-2026)、[buildmvpfast](https://www.buildmvpfast.com/blog/linear-aesthetic-tokens-density-keyboard-first-ux-2026)、[Blake Crosley 指南](https://blakecrosley.com/guides/design/linear)、[skills.sh 设计原则](https://www.skills.sh/tylergibbs1/tyler-skills/linear-design-principles)、[Intercom 播客](https://www.intercom.com/blog/podcasts/intercom-on-product-ep05/)
- 快速记录：[NotePlan 反馈](https://feedback.noteplan.co/board/p/inbox-note-as-fixed-element-in-the-sidebar)、[Trilium 收件箱](https://docs.triliumnotes.org/user-guide/concepts/notes/note-inbox)、[Shard（厂商）](https://apps.apple.com/app/shard-notes-capture/id6758519331)、[Obsidian 论坛](https://forum.obsidian.md/t/obsiddy-in/111422)、[Portside](https://www.producthunt.com/products/portside-inbox-notes-todo/makers)

视觉语言
- 颜色：[Ember Paper](https://www.visily.ai/design-systems/ember-paper)、[Convictional 手册](https://get.convictional.com/handbook/brand/color/)、[Warm Paper 主题](https://community.obsidian.md/themes/warm-paper)、[E-Ink 设计套件](https://cdn.jsdelivr.net/npm/@wrongstack/core@0.295.1/design-kits/e-ink/KIT.md)、[W3C 邮件列表](https://lists.w3.org/Archives/Public/public-css-archive/2023Nov/0123.html)、[Readwise Reader 设计](https://blakecrosley.com/guides/design/readwise-reader)、[Settled Ink](https://www.obsidianstats.com/themes/obsidian-settled-ink)、[Ink Paper](https://community.obsidian.md/themes/ink-paper)
- 字体：[Tiempos 替代（阅读）](https://fontalternatives.com/alternatives/tiempos/with/readable/)、[Lyon 替代（阅读）](https://fontalternatives.com/alternatives/lyon/with/readable/)、[Source Serif](https://best-of-web.builder.io/library/adobe-fonts/source-serif)、[Source Han Serif（维基百科）](https://en.wikipedia.org/wiki/Source_Han_Serif)、[Noto CJK Serif](https://github.com/notofonts/noto-cjk/tree/main/Serif)、[Source Han Serif README](https://mirror.iscas.ac.cn/adobe-fonts/source-han-serif/SourceHanSerifReadMe.pdf)、[Oracle Linux 包大小](https://yum.oracle.com/repowatch/oraclelinux10.x86_64/ol10_appstream/042b9e8ffffe50e67b0dcc5b4d104e096db5f47a)、[Adobe 简中子集](https://fonts.adobe.com/fonts/source-han-serif-simplified-chinese-subset-variable)
- 图标：[Lucide vs Tabler vs Phosphor](https://dev.to/svgicons/lucide-vs-tabler-vs-phosphor-which-free-icon-set-fits-your-ui-4ocl)、[allsvgicons](https://allsvgicons.com/blog/best-free-svg-icon-libraries-2026/)、[OpenReplay](https://blog.openreplay.com/svg-icon-libraries-web-apps/)
- 动效：[LogRocket：ViewTransition vs Motion](https://blog.logrocket.com/react-viewtransition-vs-motion-comparing-animation-approaches/)、[UI Things](https://uithings.com/framer-motion)、[CodersCop](https://blog.codercops.com/blog/web-animation-gsap-framer-motion-css-2026)、[skills.cat Motion](https://skills.cat/skills/fellipeutaka/leon/motion)

组件技术栈
- [GreatFrontEnd：Headless UI 库 2026](https://www.greatfrontend.com/blog/top-headless-ui-libraries-for-react-in-2026)、[HeroUI 对比](https://heroui.com/blog/best-react-ui-component-libraries)、[Base UI 替代品](https://designrevision.com/alternatives/base-ui)、[shadcn 组件库对比](https://medium.com/codetodeploy/best-shadcn-ui-component-libraries-compared-cab727f6be49)、[UXPin](https://www.uxpin.com/studio/blog/top-react-component-libraries/)
- [cmdk vs kbar vs Mantine Spotlight](https://www.pkgpulse.com/guides/cmdk-vs-kbar-vs-mantine-spotlight-2026)
- [affectUI](https://www.affectui.com)、[affectUI 定价](https://www.affectui.com/pricing)、[uiarc](https://uiarc.dev)

同类软件的默认排版（第 9 节）
- 源码：[Logseq](https://github.com/logseq/logseq)（`src/main/frontend/shui/vars-classic.css`、`common.css`、`components/theme.css`）、[tine](https://github.com/martinkoutecky/tine)（`src/styles/theme.css`、`app.css`）、[AFFiNE 主题包 @toeverything/theme](https://www.npmjs.com/package/@toeverything/theme)、[Outline Styles.ts](https://github.com/outline/outline/blob/main/shared/editor/components/Styles.ts)、[Outline globals.ts](https://github.com/outline/outline/blob/main/shared/styles/globals.ts)、[Outline EditorStyleHelper.ts](https://github.com/outline/outline/blob/main/shared/editor/styles/EditorStyleHelper.ts)、[思源 editor.go](https://github.com/siyuan-note/siyuan/blob/master/kernel/conf/editor.go)、[思源 _wysiwyg.scss](https://github.com/siyuan-note/siyuan/blob/master/app/src/assets/scss/protyle/_wysiwyg.scss)、[Joplin builtInMetadata.ts](https://github.com/laurent22/joplin/blob/dev/packages/lib/models/settings/builtInMetadata.ts)、[AppFlowy document_appearance_cubit.dart](https://github.com/AppFlowy-IO/AppFlowy/blob/main/frontend/appflowy_flutter/lib/plugins/document/application/document_appearance_cubit.dart)、[AppFlowy editor_style.dart](https://github.com/AppFlowy-IO/AppFlowy/blob/main/frontend/appflowy_flutter/lib/plugins/document/presentation/editor_style.dart)
- 实测页面：[Obsidian 帮助站](https://help.obsidian.md/Getting+started/Create+a+vault)、[Notion 官方公开页](https://notion.notion.site)、[Heptabase 公开 wiki](https://wiki.heptabase.com/version-one)；[Obsidian 排版 CSS 变量文档](https://docs.obsidian.md/Reference/CSS+variables/Foundations/Typography)
- 二手拆解：[Craft](https://www.webdesignhot.com/api/design-md/craft.md)、[Bear](https://www.shadcn.io/design/bear/raw)；Notion 页面宽度的第三方资料：[thebricks](https://thebricks.com/resources/how-to-make-notion-page-wider)、[huggingface 上的 notion.css](https://huggingface.co/spaces/sandy-try/blog/blob/main/styles/notion.css)

多语言排版
- MDN：[text-autospace](https://developer.mozilla.org/en-US/docs/Web/CSS/text-autospace)、[text-spacing-trim](https://developer.mozilla.org/en-US/docs/Web/CSS/text-spacing-trim)、[text-wrap](https://developer.mozilla.org/en-US/docs/Web/CSS/text-wrap)、[hanging-punctuation](https://developer.mozilla.org/en-US/docs/Web/CSS/hanging-punctuation)
- 本机实测数据：`spike/results/webview-css.json`（WKWebView）、`spike/results/chromium-css.json`（Chromium）
