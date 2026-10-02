# JSON GRID

> jsongrid.com 的 1:1 复刻 —— 单 HTML 文件的 JSON 格式化 / 网格查看器，纯前端零后端。
>
> A 1:1 rebuild of jsongrid.com — a single-file JSON formatter and grid viewer. Pure front-end, zero backend.

**在线体验 / Live demo:** <https://yuelwish.github.io/JsonGridWeb/>

---

## 中文

把一坨 JSON 文本变成可以点、可以搜、可以导出的表格。所有计算都跑在 Web Worker 里，主线程只管渲染，大文件也不卡。

### 功能

| 功能 | 说明 |
|------|------|
| **格式化** | 传统全量展开；另有**紧凑模式**，整行不超过 100 列就折叠成一行，尽量减少行数同时保持可读 |
| **紧凑模式** | 顶栏开关，可持久化。切换后立即按新模式重排当前文档 |
| **网格视图** | 对象数组排成横向表格（按键的并集，缺字段显示 `×`），虚拟滚动只渲染可视区 |
| **网格搜索** | 面板内匹配计数与逐个跳转，命中上限 5000+ 并显式提示截断 |
| **单元格导航** | 点 `#` 选中整行、再次点击取消；选中状态与左侧编辑器双向同步 |
| **展开 / 折叠** | 全部展开或全部折叠，状态随文档保持 |
| **导出 CSV** | 网格内容导出为 CSV，对象与数组保留完整序列化 |
| **压缩 / 校验** | 一键压缩；校验失败给出行列位置并高亮 |
| **深色主题** | 跟随源站配色，含编辑器行号、语法高亮、网格表格全套 |
| **布局切换** | 左右分屏 / JSON 全屏 / GRID 全屏，分隔条可拖拽调宽 |
| **URL 参数** | `?json=<内容>` 或 `?url=<地址>` 直接载入数据 |

### 技术特点

- **单文件产物**：`vite-plugin-singlefile` 把 JS / CSS 全部内联，产物只有一个 `index.html`，约 **517 kB**（gzip **164 kB**），可直接丢到任意静态服务器或用浏览器打开
- **零后端**：没有服务端、没有数据库、没有构建期数据请求
- **Worker 承担全部 JSON 计算**：解析、格式化、压缩、校验、搜索、单元格更新都在 Web Worker 中，主线程只做渲染
- **紧凑格式化的深度守卫**：紧凑路径每层需拼接整棵子树的扁平串，链式嵌套下是 O(深度²)。超过 **200 层**自动回退原生序列化（状态栏标注「层级过深，已展开」），避免占死 Worker
- **零 polyfill**：不使用需要 polyfill 的 API

### 浏览器支持

Chrome 60+ / Firefox 60+ / iOS Safari 12+ / Android Chrome 60+（构建目标 ES2017）

### 本地开发

```bash
mise install          # 按 mise.toml 安装 Node
npm install
npm run dev           # 开发服务器
npm run build         # 构建 -> dist/index.html（先跑 tsc 类型检查）
npm run preview       # 预览构建产物
```

### 部署

推送即部署，无需手动配置：

- 推送到 `master` → GitHub Actions 构建并部署到 GitHub Pages
- 打 `v*.*.*` 标签 → 额外生成 `dist.zip` 并创建 Release

工作流见 `.github/workflows/deploy.yml`。因为产物完全自包含（0 个外部资源引用），无需设置 `base` 路径。

### 项目结构

```
index.html            页面骨架（工具栏、面板、状态栏）
src/main.ts           应用主逻辑：编辑器、Worker 通信、事件绑定、布局
src/grid.ts           网格视图：虚拟滚动、搜索、嵌套表渲染、选中导航
src/style.css         样式（CSS 变量主题，明暗两套）
src/sample-data.ts    「样例」按钮注入的默认数据
src/tree.ts           树形视图（当前隐藏，GRID 为唯一数据视图）
```

---

## English

Turn a wall of JSON text into a table you can click, search and export. Every computation runs in a Web Worker; the main thread only renders, so large documents stay responsive.

### Features

| Feature | Details |
|---------|---------|
| **Format** | Classic full expansion; also a **compact mode** that folds any container fitting within 100 columns, cutting line count while staying readable |
| **Compact mode** | Toggle in the top bar, persisted to localStorage. Switching re-formats the current document immediately |
| **Grid view** | Object arrays render as horizontal tables (union of keys, `×` for missing fields); virtual scrolling renders only the visible window |
| **Grid search** | In-panel match counter and step-through navigation, with an explicit limit indicator above 5000 matches |
| **Cell navigation** | Click a `#` cell to select the whole row, click again to deselect; selection syncs back to the editor |
| **Expand / collapse** | Expand or collapse everything, state preserved with the document |
| **CSV export** | Export grid contents as CSV; objects and arrays keep full serialization |
| **Minify / validate** | One-click minify; validation failures report line and column and highlight the location |
| **Dark theme** | Matches the source site's palette, covering editor gutters, syntax highlighting and grid tables |
| **Layout** | Split / JSON full / GRID full, with a draggable divider |
| **URL params** | Load data directly via `?json=<content>` or `?url=<address>` |

### Technical highlights

- **Single-file build** — `vite-plugin-singlefile` inlines all JS and CSS, producing one `index.html` at roughly **517 kB** (**164 kB** gzipped). Drop it on any static host, or just open it in a browser
- **Zero backend** — no server, no database, no build-time data fetching
- **All JSON work in a Web Worker** — parse, format, minify, validate, search and cell updates happen off the main thread
- **Depth guard for compact formatting** — the compact path concatenates a flat string per level, which is O(depth²) for deeply nested chains. Past **200 levels** it falls back to native serialization (the status bar reports "层级过深，已展开") so the Worker never hangs
- **Zero polyfills** — no APIs that require polyfills

### Browser support

Chrome 60+ / Firefox 60+ / iOS Safari 12+ / Android Chrome 60+ (build target ES2017)

### Local development

```bash
mise install          # install Node per mise.toml
npm install
npm run dev           # dev server
npm run build         # build -> dist/index.html (runs tsc first)
npm run preview       # preview the build output
```

### Deployment

Push and it deploys — no manual configuration:

- Push to `master` → GitHub Actions builds and deploys to GitHub Pages
- Tag `v*.*.*` → additionally produces a `dist.zip` Release

See `.github/workflows/deploy.yml`. Because the artifact is fully self-contained (zero external resource references), no `base` path is needed.

### Layout

```
index.html            page shell (toolbar, panels, status bar)
src/main.ts           app logic: editor, worker messaging, events, layout
src/grid.ts           grid view: virtual scrolling, search, nested tables, selection
src/style.css         styles (CSS-variable theming, light and dark)
src/sample-data.ts    default data injected by the "Sample" button
src/tree.ts           tree view (currently hidden; GRID is the only data view)
```

---

## 关于 / About

这是为学习与自用目的复刻的 [jsongrid.com](https://jsongrid.com/)，所有数据仅在本地浏览器内处理，不上传任何服务器。
商标与版权归原作者所有。

A rebuild of [jsongrid.com](https://jsongrid.com/) for learning and personal use. All data is processed locally in your browser and never uploaded. Trademarks and copyright belong to the original author.