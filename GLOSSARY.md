# JSON Grid 重构版

JSON Grid 是 jsongrid.com 的重构版本：单 HTML 静态部署，提供 JSON 高性能格式化、压缩、验证、搜索与 GRID 视图。本词汇表收录该项目特有的界面与交互术语。

## Language

**JSON 编辑器**:
左侧面板（panel-json）内的 CodeMirror 编辑器，用于输入/编辑 JSON 原文；对应原站 Ace 编辑器。
_Avoid_: 左侧 json 栏、左栏

**编辑器搜索面板**:
JSON 编辑器内的搜索界面，由 CodeMirror 内置搜索面板改造而成，外观对齐原站 Ace searchbox，支持正则/大小写/全词/替换/匹配计数。
_Avoid_: 搜索框（歧义）、CM 搜索框

**GRID 搜索面板**:
右侧 GRID 视图的搜索弹层，外观对齐原站 app-search-panel；只搜索当前已渲染的网格数据。
_Avoid_: 搜索框（歧义）

**浏览器原生查找**:
浏览器自身的查找功能（Ctrl+F / Cmd+F），作用于页面已渲染的 DOM 文本；在 CodeMirror 编辑器内只能覆盖可视区，无法搜索未渲染的文档内容。
_Avoid_: 全局搜索、浏览器搜索