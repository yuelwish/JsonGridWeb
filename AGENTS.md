# AGENTS.md - JSON Grid 项目指南

## 项目概述

JSON Grid 是 jsongrid.com 的重构版本，目标是单 HTML 文件静态部署，支持大 JSON 文件的高性能格式化、压缩、验证、搜索和 Grid 视图。

## 核心约束

1. **产物必须是单 HTML 文件** - 通过 `vite-plugin-singlefile` 内联所有资源
2. **零后端依赖** - 纯前端，nginx 直接部署 `dist/index.html`
3. **浏览器兼容** - Chrome 60+, Firefox 60+, iOS Safari 12+, Android Chrome 60+
4. **build target ES2017** - 不使用 ES2019+ 特性（`Array.flat`, `Object.fromEntries` 等）
5. **零 polyfill** - 不依赖 `ResizeObserver`、`IntersectionObserver` 等需要 polyfill 的 API
6. **所有 JSON 处理必须在 Web Worker 中** - 主线程只做 UI 渲染

## 技术架构

```
index.html
  ├── src/main.ts        # 主逻辑
  │     ├── CodeMirror 6 编辑器（输入/输出双栏）
  │     ├── Web Worker（Blob URL 内联）
  │     │     └── parse / format / compress / validate / search
  │     ├── 视图切换（formatted / grid / tree）
  │     └── 事件绑定（按钮、搜索、tab 切换）
  └── src/style.css      # 样式
```

## 关键文件

| 文件 | 职责 | 注意事项 |
|------|------|----------|
| `src/main.ts` | 主应用逻辑 | Worker 通信、编辑器管理、布局/主题/搜索；worker 序列化器在 getWorkerCode 模板内 |
| `src/grid.ts` | Grid 视图 | 虚拟滚动（OVERSCAN+固定行高）、嵌套展开、CSV 导出 |
| `src/tree.ts` | 树形视图 | 递归 DOM 渲染，懒展开 |
| `src/sample-data.ts` | 内置样例数据 | 样例按钮加载 |
| `src/scrollbar.ts` | 左侧编辑器自绘滚动条 | 拖拽映射基于按下瞬间的滚动范围快照（高度突变不影响映射）；宽度常量 `EDITOR_SCROLLBAR_WIDTH` 同时是搜索面板右缘偏移 |
| `scripts/verify-*.mjs` | 回归检查（紧凑序列化 / 大整数 / 搜索快捷键 / 左侧滚动条） | 源码层代理断言，改对应模块后必跑；`npm run verify` 一次跑全部，CI 已接 |
| `src/style.css` | 样式 | CSS 变量主题，响应式布局 |
| `vite.config.ts` | 构建配置 | singleFile 插件，target: es2017 |
| `tsconfig.json` | TS 配置 | strict 模式，target: ES2017 |
| `index.html` | 入口 HTML | 工具栏、面板、状态栏结构 |

## 开发规范

### 代码风格

- TypeScript strict 模式，禁止 `any` 泛滥（当前代码中有 `any`，逐步收敛）
- Worker 代码是字符串模板，无类型检查，注意手动保证正确性
- CSS 使用 CSS 变量（`--primary-color` 等），方便主题切换
- 改第三方库（CodeMirror）的内部样式前，先读它的 baseTheme 确认依赖的不变量，
  在注释里写明所依赖的那一条（如 `.cm-scroller` 的 flex 布局用于并排行号栏与内容），
  并用 `npm run verify` 里的对应检查守住契约

### Worker 通信协议

```typescript
// 请求格式（主线程 → Worker）
{ type: 'parse' | 'format' | 'compress' | 'validate' | 'search', payload: any, id: number }

// 响应格式（Worker → 主线程）
{ id: number, success: boolean, result?: any, error?: string }
```

所有 Worker 操作返回 `performance.now()` 计时，用于状态栏展示。

### 构建与部署

```bash
npm run build     # 产物 → dist/index.html（单文件）
cp dist/index.html /var/www/html/   # nginx 部署

# 回归验证（改 worker 序列化器、搜索面板、左侧滚动条后必跑）
npm run verify

# 核对产物体积红线（改动前后各跑一次做对比）
gzip -c dist/index.html | wc -c
```

产物大小红线：< 180 kB gzip（当前 169 kB，口径同上）。
该线的作用是拦住「顺手引入重依赖」导致的膨胀，不是性能预测——169 kB gzip 走
静态托管时，首屏耗时取决于网络而非体积。历史上此线为 150 kB，但实际产物
早已稳定在 169 kB（主要是 CodeMirror 的 `basicSetup` 打包了自动补全、lint、
折叠等本项目未使用的扩展），红线与现实脱节后便失去了约束意义，故按实测重设。
若日后确需压回 150 kB，把 `basicSetup` 换成 `minimalSetup` 可省约 26 kB，
代价是失去行号、折叠、撤销、括号闭合等能力。

## 待实现功能

### 高优先级

- **高级过滤** - 支持 jq 风格路径表达式（如 `.data.users[0].name`），在 Worker 中执行

### 中优先级

- **文件上传/下载** - FileReader API + Blob URL 下载
- **搜索结果高亮** - 在编辑器中高亮匹配位置

### 低优先级

- **超大结果保护** - 格式化结果 > 10MB 时不进编辑器（主线程渲染会卡死），提示改用 GRID
- **GRID/树视图深链上限** - 结构化克隆按深度递归，`CLONE_MAX_DEPTH = 1000` 以上的文档无法传回主线程渲染（worker 内 parseJSON 已守卫，超限返回明确错误）

## 性能红线

| 指标 | 限制 | 原因 |
|------|------|------|
| 主线程阻塞 | < 5ms | Worker 处理所有重计算 |
| 产物大小 | < 180 kB gzip | 拦住依赖膨胀；当前 169 kB |
| 依赖数量 | 不增加运行时依赖 | 当前仅 CodeMirror 6 |
| DOM 节点 | Grid 视图只渲染视口 + OVERSCAN 行 | 已实现虚拟滚动（grid.ts），无行数上限 |

## 禁止事项

- **禁止引入 React/Vue/Svelte** - 项目是 Vanilla TypeScript
- **禁止使用 `Array.flat()` / `Array.flatMap()` / `Object.fromEntries()`** - ES2019 特性，不兼容目标浏览器
- **禁止使用 `ResizeObserver` / `IntersectionObserver`** - 需要 polyfill 才能支持目标浏览器
- **禁止在主线程做 JSON.parse / JSON.stringify** - 必须走 Worker
- **禁止引入 Monaco Editor** - 体积太大（2-5MB），违反产物大小限制
- **禁止添加需要 polyfill 的第三方库** - 保持零 polyfill 原则

## 兼容性检查清单

修改代码前，确认目标浏览器支持：

- [ ] 不使用 ES2019+ 语法（用 `for...of` + `reduce` 替代 `flat`，用 `Object.entries` + `Object.assign` 替代 `fromEntries`）
- [ ] 不使用 `ResizeObserver` / `IntersectionObserver`
- [ ] Worker Blob URL 在 iOS Safari 12+ 可用（已验证）
- [ ] Transferable Objects 在目标浏览器可用（已验证）

## 环境搭建

```bash
# mise 自动管理 Node.js 版本（见 mise.toml）
mise install

# 安装依赖
npm install

# 开发
npm run dev

# 构建
npm run build
```

## Agent skills

### Issue tracker

Issues 与 spec 发布到本仓库的 GitHub Issues（`gh` CLI）。spec 同时留存于 `docs/specs/`。见 `docs/agents/issue-tracker.md`。

### Triage labels

五个规范角色沿用同名标签：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

单 context：根目录 `GLOSSARY.md` + `docs/adr/`。见 `docs/agents/domain.md`。

> 本仓库无自动化测试套件（CI 只有 build + deploy），验证靠静态断言 + 人工清单。写 spec 时不要声称「tests pass」。

## 参考

- 原始站点: https://jsongrid.com
- CodeMirror 6: https://codemirror.net/
- vite-plugin-singlefile: https://github.com/nicjansky/vite-plugin-singlefile
