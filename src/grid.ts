// Grid 视图：虚拟滚动，可展开嵌套数据，固定行高，零外部依赖

const ROW_HEIGHT = 42;
const OVERSCAN = 5;

// 模块级状态，供批量展开/折叠使用
let currentGridState: GridState | null = null;
let gridRerender: (() => void) | null = null;

interface GridState {
  headers: string[];
  rows: unknown[];
  container: HTMLElement;
  bodyEl: HTMLElement;
  rowsEl: HTMLElement;
  spacerEl: HTMLElement;
  infoEl: HTMLElement | null;
  expandedCells: Set<string>;
  viewMode: 'array' | 'object';
  colWidths: number[];
  rowHeights: number[];
  measured: boolean;
  sortColumn: number;
  sortDirection: 'asc' | 'desc' | null;
  filterText: string;
  filteredRows: unknown[];
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
      const valStr = obj.val === null ? 'null' : typeof obj.val === 'object' ? JSON.stringify(obj.val).substring(0, 50) : String(obj.val);
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
        const valStr = val === null || val === undefined ? '' : typeof val === 'object' ? JSON.stringify(val).substring(0, 50) : String(val);
        if (valStr.length > maxLen) maxLen = valStr.length;
      }
      colWidths.push(Math.max(160, Math.min(400, maxLen * 8 + 40)));
    }
  }

  const state: GridState = {
    headers, rows, container,
    bodyEl: null!, rowsEl: null!, spacerEl: null!,
    infoEl: null,
    expandedCells, viewMode,
    colWidths, measured: false,
    rowHeights: [],
    sortColumn: -1, sortDirection: null,
    filterText: '', filteredRows: rows
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

  const info = document.createElement('div');
  info.className = 'grid-info';
  wrapper.appendChild(info);

  container.appendChild(wrapper);

  state.bodyEl = body;
  state.rowsEl = rowsEl;
  state.spacerEl = spacer;
  state.infoEl = info;

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

  // 点击事件委托：展开/折叠 + 定位到编辑器
  rowsEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const expandable = target.closest('.cell-expandable') as HTMLElement | null;
    if (!expandable) {
      // 检查是否点击了普通单元格（定位功能）
      const cell = target.closest('.grid-cell');
      if (cell) {
        const key = cell.getAttribute('data-key');
        const line = cell.getAttribute('data-line');
        if (line) {
          // 发送自定义事件通知主线程定位
          window.dispatchEvent(new CustomEvent('grid-navigate', { detail: { line: Number(line) } }));
        } else if (key && viewMode === 'object') {
          // 对象视图的键，尝试定位
          window.dispatchEvent(new CustomEvent('grid-navigate-key', { detail: { key } }));
        }
      }
      return;
    }
    const key = expandable.getAttribute('data-expand-key') || expandable.getAttribute('data-group-key');
    if (!key) return;

    const expandIcon = expandable.querySelector('.expand-icon');
    
    if (expandedCells.has(key)) {
      expandedCells.delete(key);
      if (expandIcon) expandIcon.classList.remove('expanded');
    } else {
      expandedCells.add(key);
      if (expandIcon) expandIcon.classList.add('expanded');
    }
    // 展开/折叠后重测列宽与行高（保留已有 colWidths 作下限，避免回落到 160）
    state.measured = false;
    state.rowHeights = [];
    rerender();
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
    state.measured = false;
    state.rowHeights = [];
    rerender();
    updateHeaderIndicators(headerEl, state);
  });
  // 双击编辑单元格
  rowsEl.addEventListener('dblclick', (e) => {
    const target = e.target as HTMLElement;
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

  // 自动展开全部嵌套内容
  expandAll();
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

    const nameSpan = document.createElement('span');
    nameSpan.textContent = h;
    nameSpan.style.flex = '1';
    nameSpan.style.overflow = 'hidden';
    nameSpan.style.textOverflow = 'ellipsis';
    nameSpan.style.textAlign = h === '#' ? 'center' : 'left';
    cell.appendChild(nameSpan);

    // 排序指示器
    if (hIdx > 0) {
      const sortIndicator = document.createElement('span');
      sortIndicator.className = 'header-sort-icon';
      if (state.sortColumn === hIdx) {
        sortIndicator.textContent = state.sortDirection === 'asc' ? '\u25B2' : '\u25BC';
        sortIndicator.style.opacity = '1';
        sortIndicator.style.color = 'var(--primary-color)';
      } else {
        sortIndicator.textContent = '\u2195';
        sortIndicator.style.opacity = '0.3';
      }
      sortIndicator.style.marginLeft = '4px';
      cell.appendChild(sortIndicator);
    }

    headerEl.appendChild(cell);
  }
  return headerEl;
}

interface DisplayRow {
  type: 'normal';
  rowIndex: number;
  data?: unknown;
}

function buildDisplayRows(state: GridState): DisplayRow[] {
  const { filteredRows } = state;
  const result: DisplayRow[] = [];

  for (let i = 0; i < filteredRows.length; i++) {
    result.push({ type: 'normal', rowIndex: i, data: filteredRows[i] });
  }

  return result;
}

// 检测数组是否同构（所有元素键相同）
function isHomogeneousArray(arr: unknown[]): boolean {
  if (arr.length === 0) return false;
  const firstKeys = new Set(Object.keys(arr[0] as Record<string, unknown>));
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

interface ChildEntry { key: string; value: unknown; type: string; }

function getChildren(val: unknown): ChildEntry[] {
  if (Array.isArray(val)) {
    const result: ChildEntry[] = [];
    for (let i = 0; i < val.length; i++) {
      const v = val[i];
      result.push({
        key: '[' + i + ']', value: v,
        type: v === null ? 'null' : typeof v === 'object' ? (Array.isArray(v) ? 'array' : 'object') : typeof v
      });
    }
    return result;
  }
  if (val !== null && typeof val === 'object') {
    const result: ChildEntry[] = [];
    for (const k of Object.keys(val as Record<string, unknown>)) {
      const v = (val as Record<string, unknown>)[k];
      result.push({
        key: k, value: v,
        type: v === null ? 'null' : typeof v === 'object' ? (Array.isArray(v) ? 'array' : 'object') : typeof v
      });
    }
    return result;
  }
  return [];
}

function renderVisibleRows(state: GridState): void {
  const { headers, rowsEl, spacerEl, infoEl, viewMode, container } = state;
  const displayRows = buildDisplayRows(state);
  const totalDisplayRows = displayRows.length;

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
    parts.push(renderNormalRow(state, displayRows[i], headers, viewMode));
  }

  rowsEl.innerHTML = parts.join('');

  // 测量实际行高并更新缓存
  if (rowsEl.children.length > 0) {
    for (let i = startIdx; i < endIdx; i++) {
      const el = rowsEl.children[i - startIdx] as HTMLElement;
      if (el) {
        state.rowHeights[i] = el.offsetHeight;
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
      if (changed) {
        // 同步重绘，避免 rAF 期间再被其他路径清掉
        renderVisibleRows(state);
        return;
      }
    } else {
      state.measured = true;
    }
  }

  // ponytail: 移除右下角的行数统计，避免与底部状态栏重复
  if (infoEl) {
    infoEl.textContent = '';
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

function renderNormalRow(state: GridState, dr: DisplayRow, headers: string[], viewMode: string): string {
  const row = dr.data!;
  const actualIdx = dr.rowIndex;
  const parts: string[] = [];

  // flex 行：高度由内容撑开，列宽由 colWidths 对齐
  parts.push('<div class="grid-row">');

  if (viewMode === 'array') {
    const idxW = state.colWidths[0] || 56;
    parts.push('<div class="grid-cell grid-index-cell" style="flex:0 0 ' + idxW + 'px" data-line="' + (actualIdx + 1) + '">' + (actualIdx + 1) + '</div>');
    const item = row as Record<string, unknown>;
    for (let h = 1; h < headers.length; h++) {
      const val = item ? item[headers[h]] : undefined;
      const w = state.colWidths[h] || 160;
      if (isExpandable(val)) {
        const expandKey = actualIdx + '|' + headers[h];
        const isExpanded = state.expandedCells.has(expandKey);
        parts.push(renderExpandableCell(val, expandKey, headers[h], isExpanded, w));
      } else {
        const { display, typeClass } = formatCell(val);
        const truncated = truncateText(display);
        parts.push('<div class="grid-cell ' + typeClass + '" style="flex:0 0 ' + w + 'px" data-row-idx="' + actualIdx + '" data-col-idx="' + h + '"'
          + (truncated.shouldTruncate ? ' title="' + escHtml(display) + '"' : '')
          + '>' + escHtml(truncated.text) + '</div>');
      }
    }
  } else {
    const obj = row as { key: string; val: unknown };
    const keyW = state.colWidths[0] || 160;
    parts.push('<div class="grid-cell grid-key-cell" style="flex:0 0 ' + keyW + 'px" data-key="' + escHtml(obj.key) + '" data-row-idx="' + actualIdx + '" data-col-idx="0">' + escHtml(obj.key) + '</div>');
    if (isExpandable(obj.val)) {
      const expandKey = actualIdx + '|' + obj.key;
      const isExpanded = state.expandedCells.has(expandKey);
      const valW = state.colWidths[1] || 200;
      parts.push(renderExpandableCell(obj.val, expandKey, obj.key, isExpanded, valW));
    } else {
      const display = obj.val === null ? 'null' : String(obj.val);
      const truncated = truncateText(display);
      const valW = state.colWidths[1] || 200;
      const typeClass = obj.val === null ? 'type-null' : 'type-' + typeof obj.val;
      parts.push('<div class="grid-cell ' + typeClass + '" style="flex:0 0 ' + valW + 'px" data-row-idx="' + actualIdx + '" data-col-idx="1"'
        + (truncated.shouldTruncate ? ' title="' + escHtml(display) + '"' : '')
        + '>' + escHtml(truncated.text) + '</div>');
    }
  }
  parts.push('</div>');
  return parts.join('');
}

function renderExpandableCell(val: unknown, expandKey: string, headerName: string, isExpanded: boolean, colWidth?: number): string {
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

  let innerHtml = '<div class="plus-minus">' + expandedLabel + '</div>';
  if (isExpanded) {
    innerHtml += renderNestedTable(val, expandKey);
  }

  return '<div class="cell-expandable"' + styleAttr + ' data-expand-key="' + escHtml(expandKey) + '">'
    + innerHtml
    + '</div>';
}

/**
 * 递归渲染嵌套表格（复刻 jsongrid.com 的 table-in-cell 方式）
 * 每个对象/数组在父 td 内渲染一个独立的 table，不额外缩进
 */
function renderNestedTable(val: unknown, parentPath: string): string {
  if (!isExpandable(val)) return '';

  const children = getChildren(val);
  if (children.length === 0) return '';

  // 对象模式: key/value 两列表格
  // 数组模式: 对象数组用列标题表格，简单值数组用 # / 值
  if (Array.isArray(val)) {
    const allSimple = val.every(v => v === null || typeof v !== 'object');
    if (allSimple) {
      // 简单值数组：# 和 值 两列 + 嵌套
      return renderNestedSimpleArrayTable(val, parentPath);
    }
    // 同构对象数组：统一列
    if (isHomogeneousArray(val)) {
      return renderNestedObjectArrayTable(val, parentPath);
    }
    // 异构数组：用 # 和 值 简单展示
    return renderNestedSimpleArrayTable(val, parentPath);
  }

  // 对象模式
  return renderNestedObjectTable(val as Record<string, unknown>, parentPath);
}

function renderNestedObjectTable(val: Record<string, unknown>, parentPath: string): string {
  const keys = Object.keys(val);
  let html = '<table border="0" cellspacing="0" cellpadding="0" class="nested-grid-table">';
  for (const k of keys) {
    const cellVal = val[k];
    const childPath = parentPath + '|' + k;
    const isExpanded = currentGridState?.expandedCells.has(childPath) === true;
    html += '<tr>';
    html += '<td class="op">' + escHtml(k) + '</td>';
    if (isExpandable(cellVal)) {
      html += '<td class="ov">' + renderExpandableCell(cellVal, childPath, k, isExpanded) + '</td>';
    } else {
      const display = cellVal === null ? 'null' : String(cellVal);
      const truncated = truncateText(display);
      const typeClass = cellVal === null ? 'type-null' : 'type-' + typeof cellVal;
      html += '<td class="ov"><span class="' + typeClass + '">' + escHtml(truncated.text) + '</span></td>';
    }
    html += '</tr>';
  }
  html += '</table>';
  return html;
}

function renderNestedSimpleArrayTable(arr: unknown[], parentPath: string): string {
  // 原站简单数组：无表头，仅 序号 | 值
  let html = '<table border="0" cellspacing="0" cellpadding="0" class="nested-grid-table">';
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    const childPath = parentPath + '|[' + i + ']';
    html += '<tr>';
    html += '<td class="op">' + (i + 1) + '</td>';
    if (isExpandable(item)) {
      const isExpanded = currentGridState?.expandedCells.has(childPath) === true;
      html += '<td class="ov">' + renderExpandableCell(item, childPath, '[' + i + ']', isExpanded) + '</td>';
    } else {
      const display = item === null ? 'null' : String(item);
      const truncated = truncateText(display);
      const typeClass = item === null ? 'type-null' : 'type-' + typeof item;
      html += '<td class="ov"><span class="' + typeClass + '">' + escHtml(truncated.text) + '</span></td>';
    }
    html += '</tr>';
  }
  html += '</table>';
  return html;
}

function renderNestedObjectArrayTable(arr: Record<string, unknown>[], parentPath: string): string {
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
    html += '<tr>';
    html += '<td class="op">' + (i + 1) + '</td>';
    for (const h of headers) {
      const cellVal = item[h];
      const childPath = parentPath + '|[' + i + ']|' + h;
      if (isExpandable(cellVal)) {
        const isExpanded = currentGridState?.expandedCells.has(childPath) === true;
        html += '<td class="ov">' + renderExpandableCell(cellVal, childPath, h, isExpanded) + '</td>';
      } else {
        const display = cellVal === null ? 'null' : String(cellVal);
        const truncated = truncateText(display);
        const typeClass = cellVal === null ? 'type-null' : 'type-' + typeof cellVal;
        html += '<td class="ov"><span class="' + typeClass + '">' + escHtml(truncated.text) + '</span></td>';
      }
    }
    html += '</tr>';
  }
  html += '</table>';
  return html;
}

function escHtml(text: string): string {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function formatCell(val: unknown): { display: string; typeClass: string } {
  if (val === null || val === undefined) {
    return { display: val === null ? 'null' : '', typeClass: 'type-null' };
  }
  const type = typeof val;
  if (type === 'object') {
    return { display: JSON.stringify(val), typeClass: 'type-object' };
  }
  return { display: String(val), typeClass: 'type-' + type };
}

function truncateText(text: string): { text: string; shouldTruncate: boolean } {
  if (text.length > 80) {
    return { text: text.slice(0, 77) + '\u2026', shouldTruncate: true };
  }
  return { text, shouldTruncate: false };
}

// 展开全部：递归遍历所有数据，将所有可展开的路径加入 expandedCells
export function expandAll(): void {
  if (!currentGridState) return;
  const { rows, headers, expandedCells, viewMode } = currentGridState;

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

  // 遍历顶层行
  for (let i = 0; i < rows.length; i++) {
    if (viewMode === 'array') {
      for (let h = 1; h < headers.length; h++) {
        const item = rows[i] as Record<string, unknown>;
        const val = item ? item[headers[h]] : undefined;
        if (isExpandable(val)) {
          const path = [String(i), headers[h]];
          collectExpandablePaths(val, path);
        }
      }
    } else {
      const obj = rows[i] as { key: string; val: unknown; type: string };
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

  // 对象/数组：转字符串比较
  return JSON.stringify(a).localeCompare(JSON.stringify(b));
}

function sortRows(rows: unknown[], colIdx: number, headers: string[], viewMode: string, direction: 'asc' | 'desc'): unknown[] {
  const sorted = rows.slice();

  sorted.sort((a, b) => {
    let va: unknown, vb: unknown;

    if (viewMode === 'array') {
      const ha = a as Record<string, unknown>;
      const hb = b as Record<string, unknown>;
      const key = headers[colIdx];
      va = ha ? ha[key] : undefined;
      vb = hb ? hb[key] : undefined;
    } else {
      const oa = a as { key: string; val: unknown; type: string };
      const ob = b as { key: string; val: unknown; type: string };
      // colIdx: 0=键, 1=值, 2=类型
      if (colIdx === 0) { va = oa.key; vb = ob.key; }
      else if (colIdx === 1) { va = oa.val; vb = ob.val; }
      else { va = oa.type; vb = ob.type; }
    }

    let cmp = compareValues(va, vb);
    return direction === 'desc' ? -cmp : cmp;
  });

  return sorted;
}

// ========== 过滤 ==========
function filterRows(rows: unknown[], query: string, headers: string[], viewMode: string): unknown[] {
  if (!query.trim()) return rows;
  const q = query.toLowerCase();

  return rows.filter(row => {
    if (viewMode === 'array') {
      const item = row as Record<string, unknown>;
      if (!item) return false;
      // 检查所有列的值
      for (let h = 1; h < headers.length; h++) {
        const val = item[headers[h]];
        const str = val === null ? 'null' : val === undefined ? '' :
          typeof val === 'object' ? JSON.stringify(val) : String(val);
        if (str.toLowerCase().includes(q)) return true;
      }
      return false;
    } else {
      const obj = row as { key: string; val: unknown; type: string };
      // 检查键和值
      if (obj.key.toLowerCase().includes(q)) return true;
      const val = obj.val;
      const str = val === null ? 'null' : val === undefined ? '' :
        typeof val === 'object' ? JSON.stringify(val) : String(val);
      return str.toLowerCase().includes(q);
    }
  });
}

// 应用排序和过滤，更新 state.filteredRows
function applySortAndFilter(state: GridState): void {
  let result = state.rows.slice();

  // 先过滤
  if (state.filterText) {
    result = filterRows(result, state.filterText, state.headers, state.viewMode);
  }

  // 再排序
  if (state.sortColumn >= 0 && state.sortDirection) {
    result = sortRows(result, state.sortColumn, state.headers, state.viewMode, state.sortDirection);
  }

  state.filteredRows = result;
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
        return csvEscape(val === null ? 'null' : val === undefined ? '' :
          typeof val === 'object' ? JSON.stringify(val) : String(val));
      });
      lines.push(cells.join(','));
    }
  } else {
    lines.push(['键', '值', '类型'].map(csvEscape).join(','));
    for (const row of filteredRows) {
      const obj = row as { key: string; val: unknown; type: string };
      const val = obj.val;
      const valStr = val === null ? 'null' : val === undefined ? '' :
        typeof val === 'object' ? JSON.stringify(val) : String(val);
      lines.push([csvEscape(obj.key), csvEscape(valStr), csvEscape(obj.type)].join(','));
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
  currentGridState.measured = false;
  currentGridState.rowHeights = [];
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
    const obj = row as { key: string; val: unknown; type: string };
    if (colIdx === 0) oldValue = obj.key;
    else if (colIdx === 1) oldValue = obj.val;
    else oldValue = obj.type;
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

  // 类型转换
  let parsedValue: unknown = newValue;
  if (typeof oldValue === 'number') {
    parsedValue = Number(newValue);
    if (isNaN(parsedValue as number)) parsedValue = oldValue; // 无效数字，恢复原值
    parsedValue = newValue.toLowerCase() === 'true';
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
export function getCellPath(rowIdx: number, colIdx: number): string[] | null {
  if (!currentGridState) return null;
  const { rows, headers, viewMode } = currentGridState;
  const row = rows[rowIdx];
  if (!row) return null;

  if (viewMode === 'array') {
    return [String(rowIdx), headers[colIdx]];
  } else {
    const obj = row as { key: string; val: unknown; type: string };
    if (colIdx === 0) return [obj.key]; // 键名编辑（编辑键名会改变结构，暂不支持）
    if (colIdx === 1) return [obj.key]; // 值编辑
    return null; // 类型列不编辑
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
      const type = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
      return { key: k, val: v, type };
    });
  } else {
    return;
  }
  
  currentGridState.rows = rows;
  currentGridState.filteredRows = rows;
  currentGridState.sortColumn = -1;
  currentGridState.sortDirection = null;
  currentGridState.filterText = '';
  currentGridState.measured = false;
  currentGridState.rowHeights = [];
  if (gridRerender) gridRerender();
}
