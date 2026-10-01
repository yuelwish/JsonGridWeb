# JSON Grid 在线编辑方案调研

## 目标

在保持当前架构约束的前提下，为 Grid 视图添加类似 jsongrid.com 的在线编辑功能。

## 架构约束回顾

| 约束 | 说明 |
|---|---|
| 单 HTML 文件 | 所有资源通过 vite-plugin-singlefile 内联 |
| 零后端 | 纯前端，nginx 直接部署 |
| ES2017 | 不使用 flat/fromEntries 等 ES2019+ 特性 |
| 零 polyfill | 不使用 ResizeObserver/IntersectionObserver |
| Web Worker | 所有 JSON 处理在 Worker 中 |
| 产物大小 | < 150KB gzip |
| 浏览器兼容 | Chrome 60+, Firefox 60+, iOS Safari 12+ |

## jsongrid.com 在线编辑机制分析

### 核心功能
1. **单元格编辑** - 点击单元格进入编辑模式
2. **类型感知** - 根据 JSON 类型提供不同编辑体验（字符串/数字/布尔/null）
3. **双向同步** - GridSync：编辑后同步到左侧 JSON 编辑器
4. **键盘导航** - Tab/Enter/方向键切换单元格
5. **批量操作** - 复制粘贴、拖拽填充

### 技术实现（推测）
- Angular 框架 + PrimeNG 表格组件
- contenteditable 或动态 input 覆盖
- 双向数据绑定（Angular 特性）
- 复杂的撤销/重做栈

## 替代方案评估

### 方案 A: contenteditable 内联编辑

**原理**: 点击单元格时设置 `contenteditable="true"`，编辑完成后读取内容更新数据。

**优点**:
- 实现简单，无需额外 DOM 元素
- 天然支持富文本编辑
- 代码量最少

**缺点**:
- `contenteditable` 在不同浏览器行为不一致（Chrome vs Firefox vs Safari）
- 需要处理粘贴、换行、光标位置等复杂问题
- iOS Safari 对 contenteditable 支持有已知 bug
- 类型验证困难（用户可能输入任意内容）

**兼容性风险**:
- iOS Safari 12: contenteditable 在表格单元格中表现不稳定
- Firefox: 粘贴行为与 Chrome 不同

**代码复杂度**: 中
**维护成本**: 高（需要处理各种浏览器差异）

---

### 方案 B: 动态 input 覆盖（推荐）

**原理**: 点击单元格时，在单元格上方创建一个绝对定位的 `<input>` 元素，编辑完成后移除 input 并更新数据。

**优点**:
- 行为一致，所有浏览器 input 表现相同
- 类型验证简单（input type="number" 等）
- 键盘导航容易实现
- 不依赖 contenteditable 的浏览器差异

**缺点**:
- 需要处理定位（滚动时同步位置）
- 需要处理样式（input 样式与单元格一致）
- 多一个 DOM 元素（但编辑时才创建）

**兼容性**:
- input 元素在所有目标浏览器表现一致
- 无需特殊处理 iOS Safari

**代码复杂度**: 中低
**维护成本**: 低

---

### 方案 C: 双击编辑（保守方案）

**原理**: 单击选中/定位（GridSync），双击进入编辑模式。使用方案 B 的动态 input。

**优点**:
- 交互更清晰，减少误操作
- 单击仍可用于 GridSync 定位
- 用户心智模型清晰（双击=编辑）

**缺点**:
- 多一步操作（需要双击）
- 对于习惯单细胞编辑的用户不友好

**适用场景**: 如果主要用途是查看，偶尔编辑

---

### 方案 D: 使用现成库（Handsontable / AG Grid）

**优点**:
- 功能完整（排序、过滤、编辑、复制粘贴）
- 文档齐全，社区支持
- 经过大量测试

**缺点**:
- **体积过大**: Handsontable ~200KB gzip, AG Grid ~500KB gzip
- 违反产物大小限制（当前 150KB）
- 可能引入 ES2019+ 语法
- 需要额外适配 Web Worker 架构
- 许可问题（Handsontable 商业版收费）

**结论**: **不推荐**，违反项目核心约束

---

### 方案 E: 自定义 Canvas 渲染（高性能）

**原理**: 使用 Canvas 绘制表格，完全自定义渲染和编辑。

**优点**:
- 性能最佳（虚拟滚动 + Canvas）
- 完全控制渲染
- 支持超大数据集（10 万行+）

**缺点**:
- 开发成本极高
- 需要自己实现文本渲染、光标、选区等
- 可访问性差（屏幕阅读器不友好）
- 维护成本高

**结论**: 过度工程化，不推荐

---

## 推荐方案

### 主方案：方案 B（动态 input 覆盖）+ 方案 C（双击编辑）

**交互设计**:
1. **单击** → GridSync 定位到左侧编辑器
2. **双击** → 进入编辑模式（动态 input 覆盖）
3. **Enter** → 确认编辑
4. **Escape** → 取消编辑
5. **Tab/方向键** → 在编辑模式下切换单元格

**技术实现**:

#### 1. 编辑状态管理
```typescript
interface EditState {
  rowIdx: number;
  colIdx: number;
  oldValue: unknown;
  input: HTMLInputElement;
}

let currentEdit: EditState | null = null;
```

#### 2. Worker 同步
```typescript
// 编辑完成后，通过 Worker 重新生成 JSON
async function syncEditToJSON(rowIdx: number, colIdx: number, newValue: unknown) {
  const result = await workerRequest('updateCell', {
    data: currentData,
    path: getCellPath(rowIdx, colIdx),
    value: newValue
  });
  currentData = result.data;
  updateEditor(result.jsonString);
  rerenderGrid();
}
```

#### 3. 类型感知输入
```typescript
function getInputType(value: unknown): string {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'text'; // 自定义下拉
  return 'text';
}
```

#### 4. Worker 新增操作
```javascript
// Worker 中添加 updateCell 操作
case 'updateCell':
  result = updateCell(payload.data, payload.path, payload.value);
  break;

function updateCell(data, path, value) {
  const t = performance.now();
  // 深拷贝数据
  const cloned = JSON.parse(JSON.stringify(data));
  // 按路径更新
  let current = cloned;
  for (let i = 0; i < path.length - 1; i++) {
    current = current[path[i]];
  }
  current[path[path.length - 1]] = value;
  return {
    data: cloned,
    jsonString: JSON.stringify(cloned, null, 2),
    updateTime: performance.now() - t
  };
}
```

### 性能考虑

| 操作 | 耗时预估 | 说明 |
|---|---|---|
| 点击编辑 | < 1ms | 创建 input 元素 |
| 输入字符 | 0ms | 原生 input 性能 |
| 确认编辑 | 5-20ms | Worker 重新序列化 JSON |
| 重渲染 Grid | 10-50ms | 取决于数据大小 |

**优化点**:
1. 编辑时不立即重渲染，等确认后再渲染
2. Worker 使用结构化克隆避免序列化开销
3. 虚拟滚动保持不变，只更新可见行

### 兼容性保证

| 特性 | 兼容性 |
|---|---|
| `document.createElement('input')` | 所有浏览器 |
| `getBoundingClientRect()` | 所有浏览器 |
| `input.focus()` | 所有浏览器 |
| `input.addEventListener` | 所有浏览器 |
| Web Worker postMessage | 所有浏览器 |

### 维护性评估

| 维度 | 评分 | 说明 |
|---|---|---|
| 代码复杂度 | 中 | 约 200 行新增代码 |
| 测试覆盖 | 易 | 纯 DOM 操作，易写单元测试 |
| 调试难度 | 低 | 标准 DOM API，DevTools 友好 |
| 扩展性 | 高 | 易于添加验证、格式化等 |
| 知识门槛 | 低 | 标准 DOM API，无黑魔法 |

---

## 实施建议

### 阶段 1: 基础编辑（1-2 天）
- 双击进入编辑模式
- 动态 input 覆盖
- Enter/Escape 确认/取消
- 基本类型支持（字符串、数字）

### 阶段 2: 增强交互（1 天）
- 布尔值下拉选择（true/false）
- null 值特殊处理
- 键盘导航（Tab/方向键）

### 阶段 3: 数据同步（1 天）
- Worker updateCell 操作
- JSON 字符串更新
- 左侧编辑器同步
- Grid 重新渲染

### 阶段 4: 高级功能（可选）
- 撤销/重做
- 批量编辑
- 复制粘贴
- 单元格验证

---

## 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|
| input 定位偏移 | 中 | 用户体验 | 滚动时实时更新位置 |
| Worker 序列化慢 | 低 | 性能 | 限制编辑频率，debounce |
| 大数据集卡顿 | 低 | 性能 | 虚拟滚动 + 只重渲染可见区域 |
| 浏览器兼容问题 | 低 | 功能 | 使用标准 API，避免实验性特性 |

---

## 结论

**推荐方案 B+C（动态 input + 双击编辑）**，理由：

1. **符合架构约束**: 零额外依赖，ES2017 兼容，产物大小可控
2. **性能优秀**: 编辑操作 < 50ms，虚拟滚动不受影响
3. **兼容性好**: 标准 DOM API，无浏览器差异
4. **交互友好**: 双击编辑符合用户直觉，单击保留 GridSync
5. **易于维护**: 代码简单，测试容易，无黑魔法

**预估工作量**: 3-5 天（含测试）
**产物大小增加**: ~5-10KB gzip
**代码行数增加**: ~200-300 行
