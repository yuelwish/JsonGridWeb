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
| `src/main.ts` | 主应用逻辑 | Worker 通信、编辑器管理、视图渲染 |
| `src/style.css` | 样式 | CSS 变量主题，响应式布局 |
| `vite.config.ts` | 构建配置 | singleFile 插件，target: es2017 |
| `tsconfig.json` | TS 配置 | strict 模式，target: ES2017 |
| `index.html` | 入口 HTML | 工具栏、面板、状态栏结构 |

## 开发规范

### 代码风格

- TypeScript strict 模式，禁止 `any` 泛滥（当前代码中有 `any`，逐步收敛）
- Worker 代码是字符串模板，无类型检查，注意手动保证正确性
- CSS 使用 CSS 变量（`--primary-color` 等），方便主题切换

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
```

产物大小目标：< 150KB gzip（当前 ~139KB）。

## 待实现功能

### 高优先级

- **树形视图** - 可折叠 JSON 树，利用 CodeMirror 6 的 foldGutter 或自定义 DOM 渲染
- **高级过滤** - 支持 jq 风格路径表达式（如 `.data.users[0].name`），在 Worker 中执行

### 中优先级

- **文件上传/下载** - FileReader API + Blob URL 下载
- **URL 参数** - `?json=...` 或 `?url=...` 支持
- **搜索结果高亮** - 在编辑器中高亮匹配位置

### 低优先级

- **Grid 视图虚拟滚动** - 当前限制 100 行，大数据集需要真正的虚拟滚动（不依赖 ResizeObserver）
- **暗色主题** - CSS 变量已预留，只需添加 toggle 和暗色变量

## 性能红线

| 指标 | 限制 | 原因 |
|------|------|------|
| 主线程阻塞 | < 5ms | Worker 处理所有重计算 |
| 产物大小 | < 150KB gzip | 首屏加载 < 1s |
| 依赖数量 | 不增加运行时依赖 | 当前仅 CodeMirror 6 |
| DOM 节点 | Grid 视图 < 1000 行 | 当前硬编码 100 行限制 |

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

## 参考

- 原始站点: https://jsongrid.com
- CodeMirror 6: https://codemirror.net/
- vite-plugin-singlefile: https://github.com/nicjansky/vite-plugin-singlefile
