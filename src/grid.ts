// Grid 视图：虚拟滚动，可展开嵌套数据，固定行高，零外部依赖

const ROW_HEIGHT = 42;
const OVERSCAN = 5;

// 模块级状态，供批量展开/折叠使用
let currentGridState: GridState | null = null;
let gridRerender: (() => void) | null = null;

/** 路径段编码：\\ 与 \|，避免键名含 | 时被误切分 */
function encodePathSegment(seg: string): string {
  return String(seg).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/** 按未转义 | 分段，识别 \\| 与 \\ */
function decodePathSegments(pathKey: string): string[] {
  const segments: string[] = [];
  let cur = '';
  for (let i = 0; i < pathKey.length; i++) {
    const ch = pathKey.charAt(i);
    if (ch === '\\') {
      if (i + 1 < pathKey.length) {
        cur += pathKey.charAt(i + 1);
        i++;
      } else {
        cur += '\\';
      }
      continue;
    }
    if (ch === '|') {
      segments.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  segments.push(cur);
  return segments;
}

interface GridState {
  headers: string[];
  rows: unknown[];
  container: HTMLElement;
  rowsEl: HTMLElement;
  spacerEl: HTMLElement;
  expandedCells: Set<string>;
  viewMode: 'array' | 'object';
  colWidths: number[];
  rowHeights: number[];
  measured: boolean;
  sortColumn: number;
  sortDirection: 'asc' | 'desc' | null;
  filterText: string;
  filteredRows: unknown[];
  /** 与 filteredRows 等长：每行在 rows 中的原始下标 */
  rowOriginalIndices: number[];
  /** 当前选中导航：path 为编码后 pathKey，target 为 key 或 value */
  selectedNav: { path: string; target: 'key' | 'value' } | null;
}

export function renderVirtualGrid(data: unknown, container: HTMLElement): void {
  container.innerHTML = '';

  let headers: string[];
  let rows: unknown[];
  let viewMode: 'array' | 'object';

  if (Array.isArray(data)) {
    if (data.length === 0) {
      container.innerHTML = '<p style="color: var(--text-muted);">空数组</p>';
      return;
    }
    const keySet = new Set<string>();
    for (const item of data) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        for (const k of Object.keys(item as Record<string, unknown>)) {
          keySet.add(k);
        }
      }
    }
    headers = ['#', ...Array.from(keySet)];
    rows = data;
    viewMode = 'array';
  } else if (data !== null && typeof data === 'object') {
    headers = ['键', '值'];
    rows = Object.entries(data as Record<string, unknown>).map(([k, v]) => {
      return { key: k, val: v };
    });
    viewMode = 'object';
  } else {
    container.innerHTML = '<p style="color: var(--text-muted);">JSON 必须是对象或数组</p>';
    return;
  }

  const expandedCells = new Set<string>();

  // 直接计算列宽
  const colWidths: number[] = [];
  if (viewMode === 'object') {
    let maxKeyLen = 0;
    let maxValLen = 0;
    for (const row of rows) {
      const obj = row as { key: string; val: unknown };
      if (obj.key.length > maxKeyLen) maxKeyLen = obj.key.length;
      const valStr = summarizeValue(obj.val);
      if (valStr.length > maxValLen) maxValLen = valStr.length;
    }
    colWidths.push(Math.max(160, Math.min(300, Math.max(maxKeyLen, headers[0]?.length || 0) * 8 + 40)));
    colWidths.push(Math.max(200, Math.min(500, Math.max(maxValLen, headers[1]?.length || 0) * 8 + 40)));
  } else {
    colWidths.push(56);
    for (let h = 1; h < headers.length; h++) {
      let maxLen = headers[h]?.length || 0;
      for (const row of rows) {
        const item = row as Record<string, unknown>;
        const val = item ? item[headers[h]] : undefined;
        const valStr = summarizeValue(val);
        if (valStr.length > maxLen) maxLen = valStr.length;
      }
      colWidths.push(Math.max(160, Math.min(400, maxLen * 8 + 40)));
    }
  }

  const initialIndices: number[] = [];
  for (let i = 0; i < rows.length; i++) initialIndices.push(i);

  const state: GridState = {
    headers, rows, container,
    rowsEl: null!, spacerEl: null!,
    expandedCells, viewMode,
    colWidths, measured: false,
    rowHeights: [],
    sortColumn: -1, sortDirection: null,
    filterText: '', filteredRows: rows,
    rowOriginalIndices: initialIndices,
    selectedNav: null
  };
  currentGridState = state;

  const wrapper = document.createElement('div');
  wrapper.className = 'virtual-grid-wrapper';

  const headerEl = buildHeader(headers, state);
  wrapper.appendChild(headerEl);

  const body = document.createElement('div');
  body.className = 'virtual-grid-body';

  const spacer = document.createElement('div');
  spacer.className = 'virtual-grid-spacer';

  const rowsEl = document.createElement('div');
  rowsEl.className = 'virtual-grid-rows';

  body.appendChild(spacer);
  body.appendChild(rowsEl);
  wrapper.appendChild(body);

  container.appendChild(wrapper);

  state.rowsEl = rowsEl;
  state.spacerEl = spacer;

  function rerender() { renderVisibleRows(state); }
  gridRerender = rerender;

  // ponytail: 垂直滚动由 container 处理，横向滚动由 body 处理
  container.addEventListener('scroll', rerender);
  
  // 横向滚动同步：body 为主，header 为从
  let syncingScroll = false;
  body.addEventListener('scroll', () => {
    if (syncingScroll) return;
    syncingScroll = true;
    headerEl.scrollLeft = body.scrollLeft;
    requestAnimationFrame(() => { syncingScroll = false; });
  });
  headerEl.addEventListener('scroll', () => {
    if (syncingScroll) return;
    syncingScroll = true;
    body.scrollLeft = headerEl.scrollLeft;
    requestAnimationFrame(() => { syncingScroll = false; });
  });

  // 点击事件委托：导航定位 + 展开折叠
  // 叶子 key/value：仅导航；.plus-minus：导航+toggle；expandable 外壳空白：导航+toggle
  rowsEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const plusMinus = target.closest('.plus-minus') as HTMLElement | null;
    const expandable = target.closest('.cell-expandable') as HTMLElement | null;
    const navEl = target.closest('[data-json-path]') as HTMLElement | null;

    let shouldNav = false;
    let shouldToggle = false;

    if (plusMinus) {
      shouldNav = true;
      shouldToggle = true;
    } else if (navEl && expandable && navEl === expandable) {
      // 点在 expandable 外壳（含空白），不是嵌套表内叶子
      shouldNav = true;
      shouldToggle = true;
    } else if (navEl) {
      // 叶子 key/value（含嵌套表内 td.op / td.ov / .grid-cell）
      shouldNav = true;
      shouldToggle = false;
    }
    // expandable 始终带 data-json-path，会走上面的 navEl 分支，无需 else if (expandable)

    if (shouldNav && navEl) {
      // path 允许空串：JSON 顶层键 "" 的 data-json-path 为 ""
      const path = navEl.getAttribute('data-json-path');
      const navTarget = (navEl.getAttribute('data-nav-target') || 'value') as 'key' | 'value';
      if (path != null) {
        state.selectedNav = { path, target: navTarget };
        dispatchGridNavigate(path, navTarget);
      }
    }

    if (shouldToggle && expandable) {
      const key = expandable.getAttribute('data-expand-key');
      if (key) {
        if (expandedCells.has(key)) expandedCells.delete(key);
        else expandedCells.add(key);
        // 展开/折叠后重测列宽与行高（保留已有 colWidths 作下限）
        state.measured = false;
        state.rowHeights = [];
      }
    }

    // 双击的第一下 click：跳过导航重绘，避免 innerHTML 重建导致双击闪烁；
    // 展开折叠 toggle 不受影响（第二击落在同元素，dblclick 处理编辑）
    if (e.detail >= 2) return;

    if (shouldNav && !shouldToggle) {
      // 仅选中态变化：增量更新高亮 class，不重建 DOM（重建会闪）
      updateNavHighlight(state, rowsEl);
    } else if (shouldNav || shouldToggle) {
      rerender();
    }
  });
  // 表头点击排序
  headerEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const cell = target.closest('.grid-cell') as HTMLElement | null;
    if (!cell) return;
    const colIdx = Number(cell.dataset.colIndex);
    if (isNaN(colIdx) || colIdx === 0) return; // '#' 列不排序

    // 切换排序方向
    if (state.sortColumn === colIdx) {
      if (state.sortDirection === 'asc') state.sortDirection = 'desc';
      else if (state.sortDirection === 'desc') { state.sortColumn = -1; state.sortDirection = null; }
      else state.sortDirection = 'asc';
    } else {
      state.sortColumn = colIdx;
      state.sortDirection = 'asc';
    }

    applySortAndFilter(state);
    rerender();
    updateHeaderIndicators(headerEl, state);
  });
  // 双击编辑单元格
  rowsEl.addEventListener('dblclick', (e) => {
    const target = e.target as HTMLElement;
    // 嵌套表内叶子值（仅 td.ov 值单元格；td.op 是键名，不允许按值编辑）
    const nestedLeaf = target.closest('.nested-grid-table td.ov') as HTMLElement | null;
    if (nestedLeaf) {
      // 值格内可能嵌套更深的展开单元格（td.ov > .cell-expandable），排除
      if (nestedLeaf.querySelector('.cell-expandable, .nested-grid-table')) return;
      const pathAttr = nestedLeaf.getAttribute('data-json-path');
      if (pathAttr != null) {
        startNestedEditing(nestedLeaf, pathAttr);
      }
      return;
    }
    const cell = target.closest('.grid-cell') as HTMLElement | null;
    if (!cell) return;
    // 可展开单元格不编辑
    if (cell.classList.contains('cell-expandable')) return;
    // 索引列不编辑
    if (cell.classList.contains('grid-index-cell')) return;

    const rowIdx = Number(cell.getAttribute('data-row-idx'));
    const colIdx = Number(cell.getAttribute('data-col-idx'));
    if (isNaN(rowIdx) || isNaN(colIdx)) return;

    startEditing(state, rowIdx, colIdx, cell);
  });

  // 默认折叠；展开由工具栏「展开全部」或单元格点击触发
  rerender();
}

function buildHeader(headers: string[], state: GridState): HTMLElement {
  const headerEl = document.createElement('div');
  headerEl.className = 'virtual-grid-header';
  
  // 使用 flex 布局
  headerEl.style.display = 'flex';
  headerEl.style.alignItems = 'stretch';
  
  for (let hIdx = 0; hIdx < headers.length; hIdx++) {
    const h = headers[hIdx];
    const cell = document.createElement('div');
    cell.className = 'grid-cell';
    if (h === '#') cell.className += ' grid-index-cell';
    cell.dataset.colIndex = String(hIdx);
    cell.style.cursor = hIdx > 0 ? 'pointer' : 'default';
    
    // 设置列宽（flex-basis）
    if (state.colWidths[hIdx]) {
      cell.style.flex = '0 0 ' + state.colWidths[hIdx] + 'px';
    }

    if (h === '#') {
      // 索引列表头：⋯ 搜索按钮（原站 pi-ellipsis-h）
      const dots = document.createElement('span');
      dots.className = 'header-dots-btn';
      dots.textContent = '⋯';
      dots.title = '搜索';
      cell.appendChild(dots);
      headerEl.appendChild(cell);
      continue;
    }

    // ☰ 拖拽柄（原站 drag-handle，可拖动调整列宽）
    const dragHandle = document.createElement('span');
    dragHandle.className = 'header-drag-handle';
    dragHandle.textContent = '☰ ';
    dragHandle.title = 'Drag & Drop to move column';
    cell.appendChild(dragHandle);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'header-title';
    nameSpan.textContent = h;
    nameSpan.style.flex = '1';
    nameSpan.style.overflow = 'hidden';
    nameSpan.style.textOverflow = 'ellipsis';
    cell.appendChild(nameSpan);

    // 排序指示器（原站 ↑↓ 图标）
    if (hIdx > 0) {
      const sortIndicator = document.createElement('span');
      sortIndicator.className = 'header-sort-icon';
      if (state.sortColumn === hIdx) {
        sortIndicator.textContent = state.sortDirection === 'asc' ? '▲' : '▼';
        sortIndicator.style.opacity = '1';
        sortIndicator.style.color = 'var(--primary-color)';
      } else {
        sortIndicator.textContent = '⇅';
        sortIndicator.style.opacity = '0.45';
      }
      cell.appendChild(sortIndicator);

      // 筛选图标（原站 pi-filter）
      const filterIcon = document.createElement('span');
      filterIcon.className = 'header-filter-icon';
      filterIcon.textContent = '⏳';
      filterIcon.title = 'Filter';
      cell.appendChild(filterIcon);

      // 列宽拖拽柄（⋮ 右缘）
      const colResize = document.createElement('span');
      colResize.className = 'header-col-resize';
      colResize.title = '拖动调整列宽';
      cell.appendChild(colResize);
    }

    headerEl.appendChild(cell);
  }
  return headerEl;
}

// 检测数组是否同构（所有元素键相同）
function isHomogeneousArray(arr: unknown[]): boolean {
  if (arr.length === 0) return false;
  const first = arr[0];
  if (first === null || typeof first !== 'object' || Array.isArray(first)) return false;
  const firstKeys = new Set(Object.keys(first as Record<string, unknown>));
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] === null || typeof arr[i] !== 'object' || Array.isArray(arr[i])) return false;
    const keys = new Set(Object.keys(arr[i] as Record<string, unknown>));
    if (keys.size !== firstKeys.size) return false;
    for (const k of firstKeys) {
      if (!keys.has(k)) return false;
    }
  }
  return true;
}

function isExpandable(val: unknown): boolean {
  return val !== null && typeof val === 'object';
}

// 主线程轻量摘要，避免对完整结构 JSON.stringify（列宽/排序/过滤热路径）
function summarizeValue(val: unknown): string {
  if (val === null) return 'null';
  if (val === undefined) return '';
  if (Array.isArray(val)) return '[' + val.length + ']';
  if (typeof val === 'object') return '{...}';
  return String(val);
}

// CSV 为一次性导出，对象/数组保留完整序列化
function formatExportValue(val: unknown): string {
  if (val === null) return 'null';
  if (val === undefined) return '';
  if (typeof val === 'object') {
    try {
      return JSON.stringify(val);
    } catch (_e) {
      return String(val);
    }
  }
  return String(val);
}

interface ChildEntry { key: string; value: unknown; }

function getChildren(val: unknown): ChildEntry[] {
  if (Array.isArray(val)) {
    const result: ChildEntry[] = [];
    for (let i = 0; i < val.length; i++) {
      result.push({ key: '[' + i + ']', value: val[i] });
    }
    return result;
  }
  if (val !== null && typeof val === 'object') {
    const result: ChildEntry[] = [];
    for (const k of Object.keys(val as Record<string, unknown>)) {
      result.push({ key: k, value: (val as Record<string, unknown>)[k] });
    }
    return result;
  }
  return [];
}

function renderVisibleRows(state: GridState, layoutPass = 0): void {
  const { headers, rowsEl, spacerEl, viewMode, container, filteredRows } = state;
  const totalDisplayRows = filteredRows.length;

  // ponytail: 垂直滚动由 container 处理
  const scrollTop = container.scrollTop;
  const viewHeight = container.clientHeight;

  // 计算偏移 - 使用缓存的行高（展开的行会变高，在渲染后更新）
  const rowOffsets: number[] = new Array(totalDisplayRows);
  let offset = 0;
  for (let i = 0; i < totalDisplayRows; i++) {
    rowOffsets[i] = offset;
    offset += state.rowHeights[i] || ROW_HEIGHT;
  }
  spacerEl.style.height = offset + 'px';
  // ponytail: spacer 宽度设为 max-content 让横向滚动条出现
  spacerEl.style.minWidth = 'max-content';

  // 可见范围
  let startIdx = 0;
  let endIdx = totalDisplayRows;
  for (let i = 0; i < totalDisplayRows; i++) {
    const rh = state.rowHeights[i] || ROW_HEIGHT;
    if (rowOffsets[i] + rh >= scrollTop - OVERSCAN * ROW_HEIGHT) {
      startIdx = Math.max(0, i - OVERSCAN);
      break;
    }
  }
  for (let i = totalDisplayRows - 1; i >= 0; i--) {
    const rh = state.rowHeights[i] || ROW_HEIGHT;
    if (rowOffsets[i] + rh <= scrollTop + viewHeight + OVERSCAN * ROW_HEIGHT) {
      endIdx = Math.min(totalDisplayRows, i + 1 + OVERSCAN);
      break;
    }
  }

  rowsEl.style.top = rowOffsets[startIdx] + 'px';

  const parts: string[] = [];
  for (let i = startIdx; i < endIdx; i++) {
    parts.push(renderNormalRow(state, i, filteredRows[i], headers, viewMode));
  }

  rowsEl.innerHTML = parts.join('');

  // 测量实际行高并更新缓存；高度剧变时同帧再校正可见窗口
  let heightChanged = false;
  if (rowsEl.children.length > 0) {
    for (let i = startIdx; i < endIdx; i++) {
      const el = rowsEl.children[i - startIdx] as HTMLElement;
      if (el) {
        const h = el.offsetHeight;
        const prev = state.rowHeights[i] || ROW_HEIGHT;
        if (Math.abs(h - prev) > 1) heightChanged = true;
        state.rowHeights[i] = h;
      }
    }
    // 更新 spacer 总高度
    let totalH = 0;
    for (let i = 0; i < totalDisplayRows; i++) {
      totalH += state.rowHeights[i] || ROW_HEIGHT;
    }
    if (totalH > 0) {
      spacerEl.style.height = totalH + 'px';
    }
  }

  // 两遍渲染：测量真实列宽 → 同步表头 → 立刻用最终宽度重绘
  if (!state.measured && rowsEl.children.length > 0) {
    const widths = measureColumnWidths(state, rowsEl, headers.length);
    let changed = false;
    if (widths.length === headers.length) {
      if (state.colWidths.length !== widths.length) changed = true;
      else {
        for (let i = 0; i < widths.length; i++) {
          if (state.colWidths[i] !== widths[i]) { changed = true; break; }
        }
      }
      state.colWidths = widths;
      state.measured = true;
      syncHeaderWidths(state);
      if (changed || heightChanged) {
        // 同步重绘，避免 rAF 期间再被其他路径清掉；限制校正次数防止递归
        if (layoutPass < 2) {
          renderVisibleRows(state, layoutPass + 1);
          return;
        }
      }
    } else {
      state.measured = true;
    }
  } else if (heightChanged && layoutPass < 2) {
    renderVisibleRows(state, layoutPass + 1);
    return;
  }
}

// 把测量后的列宽同步到表头，保证头/身对齐
function syncHeaderWidths(state: GridState): void {
  const headerEl = state.container.querySelector('.virtual-grid-header') as HTMLElement | null;
  if (!headerEl) return;
  headerEl.style.display = 'flex';
  const cells = headerEl.children;
  for (let c = 0; c < cells.length && c < state.colWidths.length; c++) {
    const cell = cells[c] as HTMLElement;
    const w = state.colWidths[c];
    if (w > 0) {
      cell.style.flex = '0 0 ' + w + 'px';
      cell.style.width = w + 'px';
      cell.style.minWidth = w + 'px';
      cell.style.maxWidth = 'none';
    }
  }
}

// 临时解除宽度约束后测量真实内容宽度
function measureUnconstrainedWidth(el: HTMLElement): number {
  const prev = {
    flex: el.style.flex,
    width: el.style.width,
    minWidth: el.style.minWidth,
    maxWidth: el.style.maxWidth,
    overflow: el.style.overflow
  };
  el.style.flex = '0 0 auto';
  el.style.width = 'auto';
  el.style.minWidth = '0';
  el.style.maxWidth = 'none';
  el.style.overflow = 'visible';
  const w = Math.ceil(Math.max(el.offsetWidth, el.scrollWidth));
  el.style.flex = prev.flex;
  el.style.width = prev.width;
  el.style.minWidth = prev.minWidth;
  el.style.maxWidth = prev.maxWidth;
  el.style.overflow = prev.overflow;
  return w;
}

// 从 DOM 测量实际列宽：顶层 flex 子节点（.grid-cell / .cell-expandable）
function measureColumnWidths(state: GridState, rowsEl: HTMLElement, numCols: number): number[] {
  const widths: number[] = new Array(numCols).fill(0);

  // 先用已有估计/测量值作下限，防止回落
  for (let c = 0; c < numCols; c++) {
    if (state.colWidths[c]) widths[c] = state.colWidths[c];
  }

  // header 文本宽度
  const headerEl = state.container.querySelector('.virtual-grid-header') as HTMLElement | null;
  if (headerEl) {
    const headerCells = headerEl.children;
    for (let c = 0; c < headerCells.length && c < numCols; c++) {
      const cellW = measureUnconstrainedWidth(headerCells[c] as HTMLElement);
      if (cellW > widths[c]) widths[c] = cellW;
    }
  }

  // 只量顶层列，避免嵌套 table 内的节点污染列索引
  const rows = rowsEl.querySelectorAll('.grid-row');
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] as HTMLElement;
    let col = 0;
    for (let i = 0; i < row.children.length && col < numCols; i++) {
      const child = row.children[i] as HTMLElement;
      if (!child.classList.contains('grid-cell') && !child.classList.contains('cell-expandable')) continue;
      const cellW = measureUnconstrainedWidth(child);
      if (cellW > widths[col]) widths[col] = cellW;
      col++;
    }
  }

  // 最小宽度：# 列 56，其余 120
  for (let c = 0; c < numCols; c++) {
    const minW = c === 0 ? 56 : 120;
    if (widths[c] < minW) widths[c] = minW;
  }

  return widths;
}

function renderNormalRow(state: GridState, actualIdx: number, row: unknown, headers: string[], viewMode: string): string {
  const parts: string[] = [];

  // flex 行：高度由内容撑开，列宽由 colWidths 对齐
  parts.push('<div class="grid-row">');

  if (viewMode === 'array') {
    // 顶层数组路径用原始数据索引，与 getCellPath 一致（禁止 indexOf 首次命中）
    const originalIdx = state.rowOriginalIndices[actualIdx] ?? actualIdx;
    const rowPath = encodePathSegment(String(originalIdx));
    const idxW = state.colWidths[0] || 56;
    parts.push('<div class="grid-cell grid-index-cell' + navSelectedClass(state, rowPath, 'value') + '" style="flex:0 0 ' + idxW + 'px"'
      + ' data-json-path="' + escHtml(rowPath) + '" data-nav-target="value">'
      + '<span class="row-three-dot">⋮</span>'
      + '<span class="row-index-num">' + (actualIdx + 1) + '</span></div>');
    const item = row as Record<string, unknown>;
    for (let h = 1; h < headers.length; h++) {
      const field = headers[h];
      const val = item ? item[field] : undefined;
      const w = state.colWidths[h] || 160;
      const cellPath = rowPath + '|' + encodePathSegment(field);
      if (isExpandable(val)) {
        // expandKey 仍用可见行下标，保证展开状态与 expandAll 一致
        const expandKey = actualIdx + '|' + field;
        const isExpanded = state.expandedCells.has(expandKey);
        parts.push(renderExpandableCell(val, expandKey, field, isExpanded, w, cellPath));
      } else {
        const { display, typeClass } = formatCell(val);
        const truncated = truncateText(display);
        parts.push('<div class="grid-cell ' + typeClass + navSelectedClass(state, cellPath, 'value') + '" style="flex:0 0 ' + w + 'px"'
          + ' data-row-idx="' + actualIdx + '" data-col-idx="' + h + '"'
          + ' data-json-path="' + escHtml(cellPath) + '" data-nav-target="value"'
          + (truncated.shouldTruncate ? ' title="' + escHtml(display) + '"' : '')
          + '>' + escHtml(truncated.text) + '</div>');
      }
    }
  } else {
    const obj = row as { key: string; val: unknown };
    const keyW = state.colWidths[0] || 160;
    const keyPath = encodePathSegment(obj.key);
    parts.push('<div class="grid-cell grid-key-cell' + navSelectedClass(state, keyPath, 'key') + '" style="flex:0 0 ' + keyW + 'px"'
      + ' data-row-idx="' + actualIdx + '" data-col-idx="0"'
      + ' data-json-path="' + escHtml(keyPath) + '" data-nav-target="key">'
      + escHtml(obj.key) + '</div>');
    if (isExpandable(obj.val)) {
      const expandKey = actualIdx + '|' + obj.key;
      const isExpanded = state.expandedCells.has(expandKey);
      const valW = state.colWidths[1] || 200;
      parts.push(renderExpandableCell(obj.val, expandKey, obj.key, isExpanded, valW, keyPath));
    } else {
      const display = obj.val === null ? 'null' : String(obj.val);
      const truncated = truncateText(display);
      const valW = state.colWidths[1] || 200;
      const typeClass = obj.val === null ? 'type-null' : 'type-' + typeof obj.val;
      parts.push('<div class="grid-cell ' + typeClass + navSelectedClass(state, keyPath, 'value') + '" style="flex:0 0 ' + valW + 'px"'
        + ' data-row-idx="' + actualIdx + '" data-col-idx="1"'
        + ' data-json-path="' + escHtml(keyPath) + '" data-nav-target="value"'
        + (truncated.shouldTruncate ? ' title="' + escHtml(display) + '"' : '')
        + '>' + escHtml(truncated.text) + '</div>');
    }
  }
  parts.push('</div>');
  return parts.join('');
}

function renderExpandableCell(
  val: unknown,
  expandKey: string,
  headerName: string,
  isExpanded: boolean,
  colWidth: number | undefined,
  jsonPath: string
): string {
  let expandedLabel = '';

  if (Array.isArray(val)) {
    // 原站：[-] key[count]
    expandedLabel = (isExpanded ? '[-]' : '[+]') + ' ' + escHtml(headerName) + '[' + val.length + ']';
  } else if (val !== null && typeof val === 'object') {
    // 原站：[-] key {}（空花括号，不写 key 数量）
    expandedLabel = (isExpanded ? '[-]' : '[+]') + ' ' + escHtml(headerName) + ' {}';
  }

  // 折叠：固定列宽对齐；展开：至少保持列宽，内容可撑开（table-in-cell）
  let styleAttr = '';
  if (isExpanded) {
    const minW = colWidth || 120;
    styleAttr = ' style="flex:0 0 auto;min-width:' + minW + 'px"';
  } else if (colWidth) {
    styleAttr = ' style="flex:0 0 ' + colWidth + 'px"';
  }

  const path = jsonPath;
  const selClass = navSelectedClass(currentGridState, path, 'value');
  let innerHtml = '<div class="plus-minus' + selClass + '" data-json-path="' + escHtml(path) + '" data-nav-target="value">'
    + expandedLabel + '</div>';
  if (isExpanded) {
    // 嵌套表使用 jsonPath 作为真实数据路径前缀
    innerHtml += renderNestedTable(val, expandKey, path);
  }

  return '<div class="cell-expandable' + selClass + '"' + styleAttr
    + ' data-expand-key="' + escHtml(expandKey) + '"'
    + ' data-json-path="' + escHtml(path) + '" data-nav-target="value">'
    + innerHtml
    + '</div>';
}

/**
 * 递归渲染嵌套表格（复刻 jsongrid.com 的 table-in-cell 方式）
 * 每个对象/数组在父 td 内渲染一个独立的 table，不额外缩进
 */
// expandPath: 展开状态键；jsonPath: 真实 JSON 数据路径（用于导航）
function renderNestedTable(val: unknown, expandPath: string, jsonPath: string): string {
  if (!isExpandable(val)) return '';

  const children = getChildren(val);
  if (children.length === 0) return '';

  // 对象模式: key/value 两列表格
  // 数组模式: 对象数组用列标题表格，简单值数组用 # / 值
  if (Array.isArray(val)) {
    const allSimple = val.every(v => v === null || typeof v !== 'object');
    if (allSimple) {
      return renderNestedSimpleArrayTable(val, expandPath, jsonPath);
    }
    if (isHomogeneousArray(val)) {
      return renderNestedObjectArrayTable(val, expandPath, jsonPath);
    }
    return renderNestedSimpleArrayTable(val, expandPath, jsonPath);
  }

  return renderNestedObjectTable(val as Record<string, unknown>, expandPath, jsonPath);
}

function renderNestedObjectTable(val: Record<string, unknown>, expandPath: string, jsonPath: string): string {
  const keys = Object.keys(val);
  let html = '<table border="0" cellspacing="0" cellpadding="0" class="nested-grid-table">';
  for (const k of keys) {
    const cellVal = val[k];
    const childExpand = expandPath + '|' + k;
    const childJson = jsonPath + '|' + encodePathSegment(k);
    const isExpanded = currentGridState?.expandedCells.has(childExpand) === true;
    html += '<tr>';
    html += '<td class="op' + navSelectedClass(currentGridState, childJson, 'key') + '"'
      + ' data-json-path="' + escHtml(childJson) + '" data-nav-target="key">' + escHtml(k) + '</td>';
    if (isExpandable(cellVal)) {
      html += '<td class="ov">' + renderExpandableCell(cellVal, childExpand, k, isExpanded, undefined, childJson) + '</td>';
    } else {
      const display = cellVal === null ? 'null' : String(cellVal);
      const truncated = truncateText(display);
      const typeClass = cellVal === null ? 'type-null' : 'type-' + typeof cellVal;
      html += '<td class="ov' + navSelectedClass(currentGridState, childJson, 'value') + '"'
        + ' data-json-path="' + escHtml(childJson) + '" data-nav-target="value">'
        + '<span class="' + typeClass + '">' + escHtml(truncated.text) + '</span></td>';
    }
    html += '</tr>';
  }
  html += '</table>';
  return html;
}

function renderNestedSimpleArrayTable(arr: unknown[], expandPath: string, jsonPath: string): string {
  // 原站简单数组：无表头，仅 序号 | 值
  let html = '<table border="0" cellspacing="0" cellpadding="0" class="nested-grid-table">';
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    const childExpand = expandPath + '|[' + i + ']';
    const childJson = jsonPath + '|' + encodePathSegment(String(i));
    html += '<tr>';
    html += '<td class="op' + navSelectedClass(currentGridState, childJson, 'value') + '"'
      + ' data-json-path="' + escHtml(childJson) + '" data-nav-target="value">' + (i + 1) + '</td>';
    if (isExpandable(item)) {
      const isExpanded = currentGridState?.expandedCells.has(childExpand) === true;
      html += '<td class="ov">' + renderExpandableCell(item, childExpand, '[' + i + ']', isExpanded, undefined, childJson) + '</td>';
    } else {
      const display = item === null ? 'null' : String(item);
      const truncated = truncateText(display);
      const typeClass = item === null ? 'type-null' : 'type-' + typeof item;
      html += '<td class="ov' + navSelectedClass(currentGridState, childJson, 'value') + '"'
        + ' data-json-path="' + escHtml(childJson) + '" data-nav-target="value">'
        + '<span class="' + typeClass + '">' + escHtml(truncated.text) + '</span></td>';
    }
    html += '</tr>';
  }
  html += '</table>';
  return html;
}

function renderNestedObjectArrayTable(arr: Record<string, unknown>[], expandPath: string, jsonPath: string): string {
  const headers = Object.keys(arr[0]);
  let html = '<table border="0" cellspacing="0" cellpadding="0" class="nested-grid-table">';
  // 表头：原站首列为空/# 索引列，其后为字段名
  html += '<tr>';
  html += '<td class="op grid-subheader-cell">#</td>';
  for (const h of headers) {
    html += '<td class="op grid-subheader-cell">' + escHtml(h) + '</td>';
  }
  html += '</tr>';
  // 数据行
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    const itemJson = jsonPath + '|' + encodePathSegment(String(i));
    html += '<tr>';
    html += '<td class="op' + navSelectedClass(currentGridState, itemJson, 'value') + '"'
      + ' data-json-path="' + escHtml(itemJson) + '" data-nav-target="value">' + (i + 1) + '</td>';
    for (const h of headers) {
      const cellVal = item[h];
      const childExpand = expandPath + '|[' + i + ']|' + h;
      const childJson = itemJson + '|' + encodePathSegment(h);
      if (isExpandable(cellVal)) {
        const isExpanded = currentGridState?.expandedCells.has(childExpand) === true;
        html += '<td class="ov">' + renderExpandableCell(cellVal, childExpand, h, isExpanded, undefined, childJson) + '</td>';
      } else {
        const display = cellVal === null ? 'null' : String(cellVal);
        const truncated = truncateText(display);
        const typeClass = cellVal === null ? 'type-null' : 'type-' + typeof cellVal;
        html += '<td class="ov' + navSelectedClass(currentGridState, childJson, 'value') + '"'
          + ' data-json-path="' + escHtml(childJson) + '" data-nav-target="value">'
          + '<span class="' + typeClass + '">' + escHtml(truncated.text) + '</span></td>';
      }
    }
    html += '</tr>';
  }
  html += '</table>';
  return html;
}

function navSelectedClass(
  state: GridState | null,
  path: string,
  target: 'key' | 'value'
): string {
  if (!state || !state.selectedNav) return '';
  if (state.selectedNav.path === path && state.selectedNav.target === target) {
    return ' grid-nav-selected';
  }
  return '';
}

/** 选中态变化时增量切换 grid-nav-selected，避免全量重绘闪烁 */
function updateNavHighlight(state: GridState, root: HTMLElement): void {
  const sel = state.selectedNav;
  root.querySelectorAll('.grid-nav-selected').forEach(el => {
    const path = el.getAttribute('data-json-path');
    const target = (el.getAttribute('data-nav-target') || 'value') as 'key' | 'value';
    if (!sel || path !== sel.path || target !== sel.target) {
      el.classList.remove('grid-nav-selected');
    }
  });
  if (sel) {
    const next = root.querySelector('[data-json-path="' + cssEscapeAttr(sel.path) + '"][data-nav-target="' + sel.target + '"]');
    if (next && !next.classList.contains('grid-nav-selected')) {
      next.classList.add('grid-nav-selected');
    }
  }
}

/** 属性选择器值转义（引号与反斜杠） */
function cssEscapeAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** 导出：pathKey 解码为路径段（供嵌套编辑回写用） */
export function decodePathKey(pathKey: string): string[] {
  return decodePathSegments(pathKey);
}

function dispatchGridNavigate(pathKey: string, target: 'key' | 'value'): void {
  // 保留空字符串段：合法 JSON 键 "" 不能被 filter 掉
  const segments = decodePathSegments(pathKey);
  window.dispatchEvent(new CustomEvent('grid-navigate', {
    detail: { path: segments, target }
  }));
}

function escHtml(text: string): string {
  const d = document.createElement('div');
  d.textContent = text;
  // textContent→innerHTML 不转义双引号，属性值场景（data-json-path 等）会被截断，补齐
  return d.innerHTML.replace(/"/g, '&quot;');
}

function formatCell(val: unknown): { display: string; typeClass: string } {
  if (val === null || val === undefined) {
    return { display: val === null ? 'null' : '', typeClass: 'type-null' };
  }
  if (Array.isArray(val)) {
    return { display: '[' + val.length + ']', typeClass: 'type-array' };
  }
  const type = typeof val;
  if (type === 'object') {
    return { display: '{...}', typeClass: 'type-object' };
  }
  return { display: String(val), typeClass: 'type-' + type };
}

function truncateText(text: string): { text: string; shouldTruncate: boolean } {
  if (text.length > 80) {
    return { text: text.slice(0, 77) + '\u2026', shouldTruncate: true };
  }
  return { text, shouldTruncate: false };
}

// 展开全部：按当前可见行序列（filteredRows）生成与渲染一致的路径
export function expandAll(): void {
  if (!currentGridState) return;
  const { filteredRows, headers, expandedCells, viewMode } = currentGridState;

  // 递归收集所有可展开的路径
  function collectExpandablePaths(val: unknown, path: string[]): void {
    if (!isExpandable(val)) return;

    // 当前路径加入展开集合
    expandedCells.add(path.join('|'));

    // 递归处理子项
    const children = getChildren(val);
    for (const child of children) {
      const childPath = [...path, child.key];
      collectExpandablePaths(child.value, childPath);
    }
  }

  // 遍历当前用于渲染的行序列
  for (let i = 0; i < filteredRows.length; i++) {
    if (viewMode === 'array') {
      for (let h = 1; h < headers.length; h++) {
        const item = filteredRows[i] as Record<string, unknown>;
        const val = item ? item[headers[h]] : undefined;
        if (isExpandable(val)) {
          const path = [String(i), headers[h]];
          collectExpandablePaths(val, path);
        }
      }
    } else {
      const obj = filteredRows[i] as { key: string; val: unknown };
      if (isExpandable(obj.val)) {
        const path = [String(i), obj.key];
        collectExpandablePaths(obj.val, path);
      }
    }
  }

  // 展开后重测列宽/行高，保留 colWidths 作下限
  currentGridState.measured = false;
  currentGridState.rowHeights = [];
  if (gridRerender) gridRerender();
}

// 折叠全部：清空 expandedCells
export function collapseAll(): void {
  if (!currentGridState) return;
  currentGridState.expandedCells.clear();
  currentGridState.measured = false;
  currentGridState.rowHeights = [];
  if (gridRerender) gridRerender();
}

// ========== 排序 ==========
function compareValues(a: unknown, b: unknown): number {
  // null/undefined 排在最后
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;

  const ta = typeof a;
  const tb = typeof b;

  // 不同类型：数字优先，然后字符串，然后其他
  if (ta !== tb) {
    if (ta === 'number') return -1;
    if (tb === 'number') return 1;
    if (ta === 'string') return -1;
    if (tb === 'string') return 1;
    return ta.localeCompare(tb);
  }

  if (ta === 'number') return (a as number) - (b as number);
  if (ta === 'boolean') return (a as boolean ? 1 : 0) - (b as boolean ? 1 : 0);
  if (ta === 'string') return (a as string).localeCompare(b as string);

  // 对象/数组：用轻量摘要比较，避免完整序列化
  return summarizeValue(a).localeCompare(summarizeValue(b));
}

// ========== 过滤 ==========
function rowMatchesQuery(row: unknown, q: string, headers: string[], viewMode: string): boolean {
  if (!q.trim()) return true;
  if (viewMode === 'array') {
    const item = row as Record<string, unknown>;
    if (!item) return false;
    for (let h = 1; h < headers.length; h++) {
      const str = summarizeValue(item[headers[h]]).toLowerCase();
      if (str.includes(q)) return true;
    }
    return false;
  }
  const obj = row as { key: string; val: unknown };
  if (obj.key.toLowerCase().includes(q)) return true;
  return summarizeValue(obj.val).toLowerCase().includes(q);
}

// 应用排序和过滤，更新 state.filteredRows 与 rowOriginalIndices
// 索引型 expandKey 会失效，清空展开状态、选中导航并重测布局
function applySortAndFilter(state: GridState): void {
  // 同步保留原始下标，避免 indexOf 在重复行上首次命中
  let pairs: { row: unknown; idx: number }[] = [];
  for (let i = 0; i < state.rows.length; i++) {
    pairs.push({ row: state.rows[i], idx: i });
  }

  // 先过滤
  if (state.filterText) {
    const q = state.filterText.toLowerCase();
    const next: { row: unknown; idx: number }[] = [];
    for (let i = 0; i < pairs.length; i++) {
      if (rowMatchesQuery(pairs[i].row, q, state.headers, state.viewMode)) {
        next.push(pairs[i]);
      }
    }
    pairs = next;
  }

  // 再排序
  if (state.sortColumn >= 0 && state.sortDirection) {
    const colIdx = state.sortColumn;
    const headers = state.headers;
    const viewMode = state.viewMode;
    const direction = state.sortDirection;
    pairs.sort((a, b) => {
      let va: unknown;
      let vb: unknown;
      if (viewMode === 'array') {
        const ha = a.row as Record<string, unknown>;
        const hb = b.row as Record<string, unknown>;
        const key = headers[colIdx];
        va = ha ? ha[key] : undefined;
        vb = hb ? hb[key] : undefined;
      } else {
        const oa = a.row as { key: string; val: unknown };
        const ob = b.row as { key: string; val: unknown };
        if (colIdx === 0) { va = oa.key; vb = ob.key; }
        else { va = oa.val; vb = ob.val; }
      }
      const cmp = compareValues(va, vb);
      return direction === 'desc' ? -cmp : cmp;
    });
  }

  const filtered: unknown[] = [];
  const indices: number[] = [];
  for (let i = 0; i < pairs.length; i++) {
    filtered.push(pairs[i].row);
    indices.push(pairs[i].idx);
  }
  state.filteredRows = filtered;
  state.rowOriginalIndices = indices;
  state.expandedCells.clear();
  state.selectedNav = null;
  state.measured = false;
  state.rowHeights = [];
}

// 更新表头排序指示器
function updateHeaderIndicators(headerEl: HTMLElement, state: GridState): void {
  const cells = headerEl.children;
  for (let i = 0; i < cells.length; i++) {
    const indicator = cells[i].querySelector('.header-sort-icon') as HTMLElement | null;
    if (!indicator) continue;
    if (i === 0) { indicator.style.opacity = '0'; continue; }
    if (state.sortColumn === i) {
      indicator.textContent = state.sortDirection === 'asc' ? '\u25B2' : '\u25BC';
      indicator.style.opacity = '1';
      indicator.style.color = 'var(--primary-color)';
    } else {
      indicator.textContent = '\u2195';
      indicator.style.opacity = '0.3';
      indicator.style.color = '';
    }
  }
}

// ========== CSV 导出 ==========
export function exportToCSV(): void {
  if (!currentGridState) return;
  const { headers, filteredRows, viewMode } = currentGridState;

  if (filteredRows.length === 0) return;

  const lines: string[] = [];

  // 表头
  if (viewMode === 'array') {
    lines.push(headers.filter(h => h !== '#').map(csvEscape).join(','));
    // 数据行
    for (const row of filteredRows) {
      const item = row as Record<string, unknown>;
      const cells = headers.slice(1).map(h => {
        const val = item ? item[h] : undefined;
        return csvEscape(formatExportValue(val));
      });
      lines.push(cells.join(','));
    }
  } else {
    lines.push(['键', '值'].map(csvEscape).join(','));
    for (const row of filteredRows) {
      const obj = row as { key: string; val: unknown };
      lines.push([csvEscape(obj.key), csvEscape(formatExportValue(obj.val))].join(','));
    }
  }

  const csvContent = '\uFEFF' + lines.join('\r\n'); // BOM + CRLF
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'jsongrid-export.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function csvEscape(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

// ========== 过滤 API ==========
export function setFilterText(text: string): void {
  if (!currentGridState) return;
  currentGridState.filterText = text;
  currentGridState.sortColumn = -1;
  currentGridState.sortDirection = null;
  applySortAndFilter(currentGridState);
  if (gridRerender) gridRerender();
}

// 获取当前过滤后的行数
export function getFilteredCount(): number {
  if (!currentGridState) return 0;
  return currentGridState.filteredRows.length;
}

// 获取总行数
export function getTotalCount(): number {
  if (!currentGridState) return 0;
  return currentGridState.rows.length;
}
// ========== 单元格编辑 ==========
interface EditState {
  rowIdx: number;
  colIdx: number;
  oldValue: unknown;
  input: HTMLInputElement;
  cell: HTMLElement;
}

let currentEdit: EditState | null = null;

function startEditing(state: GridState, rowIdx: number, colIdx: number, cell: HTMLElement): void {
  // 取消之前的编辑
  if (currentEdit) cancelEditing();

  const row = state.filteredRows[rowIdx];
  if (!row) return;

  let oldValue: unknown;
  if (state.viewMode === 'array') {
    const item = row as Record<string, unknown>;
    oldValue = item ? item[state.headers[colIdx]] : undefined;
  } else {
    const obj = row as { key: string; val: unknown };
    if (colIdx === 0) oldValue = obj.key;
    else oldValue = obj.val;
  }

  // 创建 input
  const input = document.createElement('input');
  input.className = 'grid-cell-editor';
  input.value = oldValue === null ? 'null' : oldValue === undefined ? '' : String(oldValue);

  // 定位
  const rect = cell.getBoundingClientRect();
  input.style.position = 'fixed';
  input.style.left = rect.left + 'px';
  input.style.top = rect.top + 'px';
  input.style.width = rect.width + 'px';
  input.style.height = rect.height + 'px';
  input.style.zIndex = '1000';

  // 类型感知
  if (typeof oldValue === 'number') {
    input.type = 'number';
    input.step = 'any';
  } else if (typeof oldValue === 'boolean') {
    input.type = 'text';
    input.value = String(oldValue);
  }

  document.body.appendChild(input);
  input.focus();
  input.select();

  currentEdit = { rowIdx, colIdx, oldValue, input, cell };

  const finish = () => finishEditing();
  const cancel = () => cancelEditing();

  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    else if (e.key === 'Tab') {
      e.preventDefault();
      finish();
      // 移到下一个单元格
      const nextCol = colIdx + 1;
      if (nextCol < state.headers.length) {
        const nextCell = findCell(state.rowsEl, rowIdx, nextCol);
        if (nextCell) startEditing(state, rowIdx, nextCol, nextCell);
      }
    }
  });
}

function finishEditing(): void {
  if (!currentEdit) return;
  const { rowIdx, colIdx, oldValue, input } = currentEdit;
  const newValue = input.value;

  // 移除 input
  input.remove();
  currentEdit = null;

  // 类型转换：按原值类型互斥处理
  let parsedValue: unknown = newValue;
  if (typeof oldValue === 'number') {
    parsedValue = Number(newValue);
    if (isNaN(parsedValue as number)) parsedValue = oldValue; // 无效数字，恢复原值
  } else if (typeof oldValue === 'boolean') {
    const lower = newValue.toLowerCase();
    if (lower === 'true') parsedValue = true;
    else if (lower === 'false') parsedValue = false;
    else parsedValue = oldValue;
  } else if (oldValue === null) {
    if (newValue === 'null') parsedValue = null;
    else parsedValue = newValue; // 从 null 改为其他类型
  }

  // 发送编辑完成事件
  window.dispatchEvent(new CustomEvent('grid-cell-edit', {
    detail: { rowIdx, colIdx, oldValue, newValue: parsedValue }
  }));
}

function cancelEditing(): void {
  if (!currentEdit) return;
  currentEdit.input.remove();
  currentEdit = null;
}

/** 嵌套表内叶子值编辑：完成后按 data-json-path 全路径更新 */
let currentNestedEdit: { input: HTMLInputElement; cell: HTMLElement; pathKey: string; oldValue: unknown } | null = null;

function startNestedEditing(cell: HTMLElement, pathKey: string): void {
  if (currentNestedEdit) currentNestedEdit.input.remove();
  if (currentEdit) cancelEditing();

  // 显示文本（截断后的展示值）；原始带类型值从 currentGridState 按 path 解出
  const displayOld = (cell.textContent || '').trim();
  const segments = decodePathSegments(pathKey);
  const rawValue = resolvePathValue(currentGridState ? currentGridState.rows : null, segments);
  const input = document.createElement('input');
  input.className = 'grid-cell-editor';
  input.value = displayOld;

  const rect = cell.getBoundingClientRect();
  input.style.position = 'fixed';
  input.style.left = rect.left + 'px';
  input.style.top = rect.top + 'px';
  input.style.width = Math.max(rect.width, 80) + 'px';
  input.style.height = rect.height + 'px';
  input.style.zIndex = '1000';

  document.body.appendChild(input);
  input.focus();
  input.select();

  currentNestedEdit = { input, cell, pathKey, oldValue: rawValue };

  input.addEventListener('blur', finishNestedEditing);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); input.removeEventListener('blur', finishNestedEditing); input.remove(); currentNestedEdit = null; }
  });
}

/** 按 decodePathSegments 产生的段数组在 rows 树中取原始值（数组段为数字下标） */
function resolvePathValue(rows: unknown[] | null, segments: string[]): unknown {
  if (!rows || segments.length === 0) return undefined;
  // segments[0] 是顶层数组下标，其后才是键/下标交替
  let current: unknown = rows;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(seg);
      if (isNaN(idx)) return undefined;
      current = current[idx];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return current;
}

function finishNestedEditing(): void {
  if (!currentNestedEdit) return;
  const { input, pathKey, oldValue } = currentNestedEdit;
  const newValue = input.value;
  input.remove();
  currentNestedEdit = null;
  if (newValue === String(oldValue)) return;
  window.dispatchEvent(new CustomEvent('grid-nested-edit', {
    detail: { pathKey, newValue, oldValue }
  }));
}

function findCell(rowsEl: HTMLElement, rowIdx: number, colIdx: number): HTMLElement | null {
  const rows = rowsEl.querySelectorAll('.grid-row');
  for (const row of rows) {
    const cells = row.querySelectorAll('.grid-cell');
    for (const cell of cells) {
      if (Number(cell.getAttribute('data-row-idx')) === rowIdx &&
          Number(cell.getAttribute('data-col-idx')) === colIdx) {
        return cell as HTMLElement;
      }
    }
  }
  return null;
}

// 获取当前编辑的单元格路径（用于 Worker updateCell）
// 与 startEditing 一致：基于 filteredRows 的可见行索引
export function getCellPath(rowIdx: number, colIdx: number): string[] | null {
  if (!currentGridState) return null;
  const { filteredRows, headers, viewMode, rowOriginalIndices } = currentGridState;
  const row = filteredRows[rowIdx];
  if (!row) return null;

  if (viewMode === 'array') {
    // 数组视图：路径使用原始数据中的位置索引（与 filtered 下标对齐）
    const originalIdx = rowOriginalIndices[rowIdx];
    if (originalIdx == null || originalIdx < 0) return null;
    return [String(originalIdx), headers[colIdx]];
  } else {
    const obj = row as { key: string; val: unknown };
    if (colIdx === 0) return [obj.key]; // 键名编辑（编辑键名会改变结构，暂不支持）
    if (colIdx === 1) return [obj.key]; // 值编辑
    return null;
  }
}

// 更新单元格后的回调（由 main.ts 调用）
export function onCellUpdated(newData: unknown): void {
  if (!currentGridState) return;

  let rows: unknown[];
  if (Array.isArray(newData)) {
    rows = newData;
  } else if (newData !== null && typeof newData === 'object') {
    rows = Object.entries(newData as Record<string, unknown>).map(([k, v]) => {
      return { key: k, val: v };
    });
  } else {
    return;
  }

  const indices: number[] = [];
  for (let i = 0; i < rows.length; i++) indices.push(i);

  currentGridState.rows = rows;
  currentGridState.filteredRows = rows;
  currentGridState.rowOriginalIndices = indices;
  currentGridState.sortColumn = -1;
  currentGridState.sortDirection = null;
  currentGridState.filterText = '';
  currentGridState.expandedCells.clear();
  currentGridState.selectedNav = null;
  currentGridState.measured = false;
  currentGridState.rowHeights = [];
  if (gridRerender) gridRerender();
}
