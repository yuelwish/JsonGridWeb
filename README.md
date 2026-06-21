# JSON Grid

高性能 JSON 格式化工具，[jsongrid.com](https://jsongrid.com) 的重构版本。单 HTML 文件，零后端依赖，nginx 直接部署。

## 特性

- **格式化 / 压缩 / 验证** - 一键操作，结果实时反馈
- **搜索** - 按 key 或 value 模糊搜索，高亮匹配路径
- **Grid 视图** - 数组自动转表格，对象转键值对视图
- **Web Worker** - 所有 JSON 处理在 Worker 线程完成，主线程零阻塞
- **CodeMirror 6** - 增量解析 + 视口渲染，大文件流畅编辑
- **单文件部署** - 构建产物为一个 HTML 文件（gzip ~139KB）

## 浏览器兼容

| 浏览器 | 最低版本 |
|--------|---------|
| Chrome | 60+ |
| Firefox | 60+ |
| iOS Safari | 12+ |
| Android Chrome | 60+ |

零 polyfill，build target 为 ES2017。

## 快速开始

### 环境要求

- [mise](https://mise.jdx.dev/) - 自动管理 Node.js 版本（项目含 `mise.toml`）

### 开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

### 构建

```bash
npm run build
```

产物在 `dist/index.html`，单文件，直接部署到 nginx：

```bash
cp dist/index.html /var/www/html/
```

## 项目结构

```
jsongrid-rebuild/
├── index.html          # 入口 HTML
├── src/
│   ├── main.ts         # 主逻辑：编辑器初始化、Worker 通信、视图切换
│   └── style.css       # 样式（toolbar、panel、grid-table、响应式）
├── vite.config.ts      # Vite 配置（singleFile 插件，target: es2017）
├── tsconfig.json       # TypeScript 配置（target: ES2017）
├── mise.toml           # mise 工具版本管理
└── package.json        # 依赖声明
```

## 技术栈

| 组件 | 技术 | 说明 |
|------|------|------|
| 编辑器 | CodeMirror 6 | 增量解析，视口渲染，~70KB gzip |
| JSON 处理 | Web Worker (Blob URL) | parse/stringify/validate/search 全在 Worker |
| 构建 | Vite + vite-plugin-singlefile | 产物内联为单 HTML |
| 语言 | TypeScript | strict 模式 |
| 运行环境 | Node.js (via mise) | LTS 版本 |

## 待完善

- [ ] 高级过滤（jq 风格路径表达式）
- [ ] 树形视图（可折叠 JSON 树）
- [ ] 文件上传 / 下载
- [ ] URL 参数支持（`?json=...` 或 `?url=...`）
- [ ] Grid 视图虚拟滚动（当前限制 100 行）
- [ ] 搜索结果高亮定位

## 性能指标

| 指标 | 目标 | 说明 |
|------|------|------|
| 产物大小 | <150KB gzip | 当前 ~139KB |
| 主线程阻塞 | <5ms | Worker 处理所有重计算 |
| 首屏加载 | <1s | 单文件无额外请求 |

## License

MIT
