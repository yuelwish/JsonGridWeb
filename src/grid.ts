// Grid 视图：虚拟滚动，可展开嵌套数据，固定行高，零外部依赖

const ROW_HEIGHT = 42;
const OVERSCAN = 5;

// 模块级状态，供批量展开/折叠使用
let currentGridState: GridState | null = null;
let gridRerender: (() => void) | null = null;

// 视口变化时重算框体并重绘可见行。框体是渲染时定死的像素值，不重算的话
// 拉动窗口后 GRID 不会跟随（左侧 CodeMirror 自带适配，右侧必须自己来）。
// 项目禁用 ResizeObserver，用 window resize + rAF 节流代替。
let resizeRaf = 0;
window.addEventListener('resize', () => {
  if (!currentGridState || !gridRerender) return;
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    const state = currentGridState;
    if (!state) return;
    const wrapper = state.container.parentElement;
    if (wrapper) syncFrameWidth(wrapper, state.colWidths);
    gridRerender?.();
  });
});

/** 面板级提示（空态/错误）：居中图标 + 标题 + 详情，替代裸 <p> */
export function renderPanelMessage(
  container: HTMLElement,
  kind: 'error' | 'empty',
  title: string,
  detail?: string
): void {
  // 手绘 SVG：叹号圆圈（错误）/ 信息圆圈（空态），随 currentColor 变色
  const icon =
    kind === 'error'
      ? '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><line x1="12" y1="7" x2="12" y2="13"/><line x1="12" y1="16.2" x2="12" y2="16.8"/></svg>'
      : '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><line x1="12" y1="11" x2="12" y2="16.5"/><line x1="12" y1="7.2" x2="12" y2="7.8"/></svg>';
  const detailHtml = detail
    ? `<div class="panel-message__detail">${escHtml(detail)}</div>`
    : '';
  container.innerHTML =
    `<div class="panel-message panel-message--${kind}">${icon}` +
    `<div class="panel-message__title">${escHtml(title)}</div>${detailHtml}</div>`;
}

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
  /** 两轴滚动源：.virtual-grid-body（高度 = 可视区，滚动条固定在底边） */
  container: HTMLElement;
  headerEl: HTMLElement | null;
  rowsEl: HTMLElement;
  spacerEl: HTMLElement;
  expandedCells: Set<string>;
  viewMode: 'array' | 'object';
  colWidths: number[];
  rowHeights: number[];
  measured: boolean;
  sortColumn: number;
  sortDirection: 'asc' | 'desc' | null;
  filteredRows: unknown[];
  /** 与 filteredRows 等长：每行在 rows 中的原始下标 */
  rowOriginalIndices: number[];
  /** 当前选中导航：path 为编码后 pathKey，target 为 key 或 value */
  selectedNav: { path: string; target: 'key' | 'value' } | null;
}

// 搜索状态（匹配集/当前项）变化时广播，供主线程的搜索面板刷新计数。
// 编辑单元格、排序、新数据渲染都可能改变匹配，面板上的 N of M 不会自动跟上。
function notifySearchChanged(): void {
  window.dispatchEvent(new CustomEvent('grid-search-changed'));
}

export function renderVirtualGrid(data: unknown, container: HTMLElement): void {
  container.innerHTML = '';
  if (searchState) notifySearchChanged();
  searchState = null; // 新数据渲染时清除旧搜索高亮

  let headers: string[];
  let rows: unknown[];
  let viewMode: 'array' | 'object';

  if (Array.isArray(data)) {
    if (data.length === 0) {
      container.innerHTML = '';
      renderPanelMessage(container, 'empty', '空数组');
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
    renderPanelMessage(container, 'error', '无法渲染', '顶层必须是对象或数组');
    return;
  }

  const expandedCells = new Set<string>();

  const colWidths = estimateColWidths(headers, rows, viewMode);

  const initialIndices: number[] = [];
  for (let i = 0; i < rows.length; i++) initialIndices.push(i);

  const state: GridState = {
    headers, rows, container,
    rowsEl: null!, spacerEl: null!, headerEl: null,
    expandedCells, viewMode,
    colWidths, measured: false,
    rowHeights: [],
    sortColumn: -1, sortDirection: null,
    filteredRows: rows,
    rowOriginalIndices: initialIndices,
    selectedNav: null
  };
  currentGridState = state;

  const wrapper = document.createElement('div');
  wrapper.className = 'virtual-grid-wrapper' + (viewMode === 'object' ? ' is-object' : '');

  const headerEl = buildHeader(headers, state);
  wrapper.appendChild(headerEl);
  syncFrameWidth(wrapper, colWidths);

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
  state.container = body;
  state.headerEl = headerEl;

  function rerender() { renderVisibleRows(state); }
  gridRerender = rerender;

  // 纵向滚动与横向滚动都在 body 上：它的高度 = 可视区高，滚动条贴底可见；
  // spacer（总行高）只在 body 内部溢出，不把 body 撑高。
  // 横向另需同步给 header（header 自身也可横向滚）。
  body.addEventListener('scroll', rerender);
  
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

  // 点击事件委托：对象/数组的展开折叠 与 选中 是两件独立的事，按点击位置区分
  //   .plus-minus 文字行（[+] / [-] 与名称）→ 仅 toggle 展开/收起
  //   .cell-expandable 空白区域            → 仅选中（导航）
  //   叶子 key/value                      → 仅选中
  // 展开只是为了看一眼，不应该顺带把区域选中、也不该让左侧编辑器跳走。
  rowsEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const plusMinus = target.closest('.plus-minus') as HTMLElement | null;
    const expandable = target.closest('.cell-expandable') as HTMLElement | null;
    const navEl = target.closest('[data-json-path]') as HTMLElement | null;

    let shouldNav = false;
    let shouldToggle = false;

    if (plusMinus) {
      shouldNav = false;
      shouldToggle = true;
    } else if (navEl && expandable && navEl === expandable) {
      // 点在 expandable 的空白区域：只选中，不展开/收起
      shouldNav = true;
      shouldToggle = false;
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
        // 再次点击已选中的同一格子 => 取消选中（toggle）。
        // 只改 GRID 侧选中态，不再派发导航；左侧编辑器的定位高亮会自行超时淡出。
        if (state.selectedNav && state.selectedNav.path === path && state.selectedNav.target === navTarget) {
          state.selectedNav = null;
          dispatchGridNavClear();
        } else {
          state.selectedNav = { path, target: navTarget };
          dispatchGridNavigate(path, navTarget);
        }
      }
    }

    if (shouldToggle && expandable) {
      const key = expandable.getAttribute('data-expand-key');
      if (key) {
        const collapsing = expandedCells.has(key);
        if (collapsing) expandedCells.delete(key);
        else expandedCells.add(key);
        if (collapsing) resetColWidthsToEstimate(state);
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
    if (searchState) recomputeSearch();
    rerender();
    applySearchHeaderHighlight();
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
  // display:flex 放在 CSS。这里写 inline 会盖掉 .is-object 对表头的隐藏。
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

// 对象数组：元素都是普通对象（允许各元素缺字段）。源站用键的并集排成横向列表，不要求同构。
function isObjectArray(arr: unknown[]): boolean {
  if (arr.length === 0) return false;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  }
  return true;
}

function objectArrayHeaders(arr: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const headers: string[] = [];
  for (let i = 0; i < arr.length; i++) {
    const keys = Object.keys(arr[i]);
    for (let k = 0; k < keys.length; k++) {
      if (!seen.has(keys[k])) {
        seen.add(keys[k]);
        headers.push(keys[k]);
      }
    }
  }
  return headers;
}

// 折叠态列宽估算：键/值贴内容，展开态实测只会往上加不会往下减
function estimateColWidths(headers: string[], rows: unknown[], viewMode: 'array' | 'object'): number[] {
  const colWidths: number[] = [];
  if (viewMode === 'object') {
    let maxKeyLen = 0;
    let maxValLen = 0;
    for (const row of rows) {
      const obj = row as { key: string; val: unknown };
      if (obj.key.length > maxKeyLen) maxKeyLen = obj.key.length;
      const valStr = collapsedLabelLength(obj.key, obj.val);
      if (valStr > maxValLen) maxValLen = valStr;
    }
    // 键列按最长 key 贴内容，不再用 160 下限把短 key 撑得很宽。
    // 值列要按折叠标签算（[+] key {}），不能按 summarizeValue 的 {...}，否则 {} 会被折到下一行。
    colWidths.push(Math.max(48, Math.min(300, maxKeyLen * 8 + 28)));
    colWidths.push(Math.max(80, Math.min(640, maxValLen * 8 + 36)));
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
  return colWidths;
}

// 测量列宽时把已有值当下限（防回落），因此折叠时必须先把 colWidths
// 重置回折叠估算值，否则展开撑宽的列在收起后永远缩不回去，
// spacer 维持展开宽度，横向滚动条就一直在。
function resetColWidthsToEstimate(state: GridState): void {
  state.colWidths = estimateColWidths(state.headers, state.filteredRows, state.viewMode);
}

function isExpandable(val: unknown): boolean {
  return val !== null && typeof val === 'object';
}

// 折叠态实际画出的标签长度，用来估对象视图值列宽
function collapsedLabelLength(key: string, val: unknown): number {
  if (Array.isArray(val)) return 4 + key.length + 2 + String(val.length).length;
  if (val !== null && typeof val === 'object') return 4 + key.length + 3;
  if (val === null || val === undefined) return 4;
  return String(val).length;
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
  // 宽度跟列宽总和走。max-content 会比外框宽 1px，内容明明放下也冒出横向滚动条
  let colSum = 0;
  for (let c = 0; c < state.colWidths.length; c++) colSum += state.colWidths[c] || 0;
  if (colSum > 0) {
    spacerEl.style.width = colSum + 'px';
    spacerEl.style.minWidth = colSum + 'px';
  }

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
/** 外框按内容收缩（源站 table 不铺满面板）。高超过可视区时才在框内滚动。 */
function syncFrameWidth(wrapper: HTMLElement, colWidths: number[]): void {
  let w = 0;
  for (let i = 0; i < colWidths.length; i++) w += colWidths[i] || 0;
  if (w > 0) wrapper.style.width = w + 'px';

  const state = currentGridState;
  if (!state) return;
  let contentH = 0;
  const n = state.filteredRows.length;
  for (let i = 0; i < n; i++) contentH += state.rowHeights[i] || ROW_HEIGHT;
  const header = wrapper.querySelector('.virtual-grid-header') as HTMLElement | null;
  if (header && getComputedStyle(header).display !== 'none') {
    contentH += header.offsetHeight || 43;
  }
  const parent = wrapper.parentElement;
  let avail = contentH;
  if (parent) {
    const pcs = getComputedStyle(parent);
    const pad = (parseFloat(pcs.paddingTop) || 0) + (parseFloat(pcs.paddingBottom) || 0);
    const borderH = (parseFloat(pcs.borderTopWidth) || 0) + (parseFloat(pcs.borderBottomWidth) || 0);
    // 用边界框高度反推可用高，不能用 clientHeight：上面第 612 行已把 wrapper
    // 撑到全表宽，父容器（overflow-x:auto）的横向滚动条此刻还在，clientHeight
    // 会少一个滚动条高度；随后宽度缩回、滚动条消失，但这个高度没人再重算，
    // 框体就永久矮一截，滚动条下方留下一条空白。
    avail = Math.max(0, parent.getBoundingClientRect().height - borderH - pad);
  }
  const border = 2;
  let availW = avail;
  if (parent) {
    const pcs = getComputedStyle(parent);
    const padX = (parseFloat(pcs.paddingLeft) || 0) + (parseFloat(pcs.paddingRight) || 0);
    availW = Math.max(0, parent.clientWidth - padX - border);
  }
  const frameW = w > 0 ? Math.min(w, availW) : 0;
  const needsX = w > frameW + 1;
  // 横向滚动条会吃掉约 15px 高度。内容本来放得下时把这 15px 算进框高，避免再挤出纵向滚动条
  const contentWithBar = contentH + (needsX ? 15 : 0);
  const frameH = Math.max(ROW_HEIGHT, Math.min(contentWithBar, Math.max(0, avail - border)));
  if (frameW > 0) wrapper.style.width = frameW + 'px';
  wrapper.style.height = frameH + 'px';
  wrapper.style.flex = '0 0 auto';
  const body = wrapper.querySelector('.virtual-grid-body') as HTMLElement | null;
  if (body) {
    body.style.overflowX = needsX ? 'auto' : 'hidden';
    body.style.overflowY = contentWithBar > frameH + 1 ? 'auto' : 'hidden';
  }
}

function syncHeaderWidths(state: GridState): void {
  const headerEl = state.headerEl;
  const wrapper = state.container ? state.container.parentElement : null;
  if (wrapper) syncFrameWidth(wrapper, state.colWidths);
  if (!headerEl) return;
  // 对象视图表头由 .is-object 隐藏，不能再写 inline display:flex 盖掉
  if (!wrapper || !wrapper.classList.contains('is-object')) {
    headerEl.style.display = 'flex';
  }
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
  // 搜索高亮带 padding/border（padding:1px 5px + 1px 红框），参与测量会让列宽在检索时跳动 → 测量期间中和
  const hl = el.querySelector('.jg-search-cur, .jg-search-soft');
  if (hl) hl.classList.add('jg-search-nomeasure');
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
  if (hl) hl.classList.remove('jg-search-nomeasure');
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
  const headerEl = state.headerEl;
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
    // 点# 列选中的是整个数组元素（rowPath），不是那个序号数字，
    // 因此整行格子都要高亮；数据格路径为 rowPath + '|' + 字段，不会与 rowPath 撞车
    const rowSelCls = isArrayRowSelected(state, rowPath) ? ' grid-nav-selected' : '';
    const idxW = state.colWidths[0] || 56;
    parts.push('<div class="grid-cell grid-index-cell' + rowSelCls + '" style="flex:0 0 ' + idxW + 'px"'
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
        parts.push(renderExpandableCell(val, expandKey, field, isExpanded, w, cellPath, searchCellClass(actualIdx, h), rowSelCls));
      } else {
        const { display, typeClass } = formatCell(val);
        const truncated = truncateText(display);
        parts.push('<div class="grid-cell ' + typeClass + (navSelectedClass(state, cellPath, 'value') || rowSelCls) + '" style="flex:0 0 ' + w + 'px"'
          + ' data-row-idx="' + actualIdx + '" data-col-idx="' + h + '"'
          + ' data-json-path="' + escHtml(cellPath) + '" data-nav-target="value"'
          + (truncated.shouldTruncate ? ' title="' + escHtml(display) + '"' : '')
          + '><span class="cell-text' + searchCellClass(actualIdx, h) + '">' + escHtml(truncated.text) + '</span></div>');
      }
    }
  } else {
    const obj = row as { key: string; val: unknown };
    const keyW = state.colWidths[0] || 160;
    const keyPath = encodePathSegment(obj.key);
    parts.push('<div class="grid-cell grid-key-cell' + (isExpandable(obj.val) ? ' expandable-key' : '') + navSelectedClass(state, keyPath, 'key') + '" style="flex:0 0 ' + keyW + 'px"'
      + ' data-row-idx="' + actualIdx + '" data-col-idx="0"'
      + ' data-json-path="' + escHtml(keyPath) + '" data-nav-target="key">'
      + '<span class="cell-text' + searchCellClass(actualIdx, 0) + '">' + escHtml(obj.key) + '</span></div>');
    if (isExpandable(obj.val)) {
      const expandKey = actualIdx + '|' + obj.key;
      const isExpanded = state.expandedCells.has(expandKey);
      const valW = state.colWidths[1] || 200;
      parts.push(renderExpandableCell(obj.val, expandKey, obj.key, isExpanded, valW, keyPath, searchCellClass(actualIdx, 1)));
    } else {
      const display = obj.val === null ? 'null' : String(obj.val);
      const truncated = truncateText(display);
      const valW = state.colWidths[1] || 200;
      const typeClass = obj.val === null ? 'type-null' : 'type-' + typeof obj.val;
      parts.push('<div class="grid-cell ' + typeClass + navSelectedClass(state, keyPath, 'value') + '" style="flex:0 0 ' + valW + 'px"'
        + ' data-row-idx="' + actualIdx + '" data-col-idx="1"'
        + ' data-json-path="' + escHtml(keyPath) + '" data-nav-target="value"'
        + (truncated.shouldTruncate ? ' title="' + escHtml(display) + '"' : '')
        + '><span class="cell-text' + searchCellClass(actualIdx, 1) + '">' + escHtml(truncated.text) + '</span></div>');
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
  jsonPath: string,
  searchCls: string,
  forceSelClass?: string
): string {
  // 标签文字：[+] / [-] 与名称连成一行，整体不可拆：
  //   点这行字= 展开/收起；点单元格的空白处 = 选中
  let toggleSign = '';
  let labelText = '';

  if (Array.isArray(val)) {
    // 原站：[-] key[count]
    toggleSign = isExpanded ? '[-]' : '[+]';
    labelText = ' ' + escHtml(headerName) + '[' + val.length + ']';
  } else if (val !== null && typeof val === 'object') {
    // 原站：[-] key {}（空花括号，不写 key 数量）
    toggleSign = isExpanded ? '[-]' : '[+]';
    labelText = ' ' + escHtml(headerName) + ' {}';
  }

  // 折叠：固定列宽对齐；展开：至少保持列宽，内容可撑开（table-in-cell）
  let styleAttr = '';
  if (isExpanded) {
    const minW = colWidth || 120;
    styleAttr = ' style="flex:0 0 auto;min-width:' + minW + 'px"';
  } else if (colWidth) {
    styleAttr = ' style="flex:0 0 ' + colWidth + 'px"';
  }

  // 整个 .plus-minus 文字行（[+] 与名称）都只负责展开/收起：
  //   有字的地方 = 展开/收起；单元格的空白处 = 选中。
  // 因此它不再携带 data-json-path，选中目标由外层 .cell-expandable 承担。
  const path = jsonPath;
  // forceSelClass：数组视图选中整个元素时，整行格子（含可展开格）一起高亮
  const selClass = forceSelClass || navSelectedClass(currentGridState, path, 'value');
  let innerHtml = '<div class="plus-minus' + searchCls + '">' + toggleSign + labelText + '</div>';
  if (isExpanded) {
    // 嵌套表使用 jsonPath 作为真实数据路径前缀
    innerHtml += renderNestedTable(val, expandKey, path);
  }

  return '<div class="cell-expandable' + (isExpanded ? ' is-open' : '') + selClass + '"' + styleAttr
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
    if (isObjectArray(val)) {
      return renderNestedObjectArrayTable(val as Record<string, unknown>[], expandPath, jsonPath);
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
      html += '<td class="ov">' + renderExpandableCell(cellVal, childExpand, k, isExpanded, undefined, childJson, '') + '</td>';
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
    const rowSelCls = isArrayRowSelected(currentGridState, childJson) ? ' grid-nav-selected' : '';
    html += '<tr>';
    // 简单数组的 # 索引列：同样代表整个数组元素，标记见renderNestedObjectArrayTable
    html += '<td class="op grid-nested-index-cell' + rowSelCls + '"'
      + ' data-json-path="' + escHtml(childJson) + '" data-nav-target="value">' + (i + 1) + '</td>';
    if (isExpandable(item)) {
      const isExpanded = currentGridState?.expandedCells.has(childExpand) === true;
      html += '<td class="ov">' + renderExpandableCell(item, childExpand, '[' + i + ']', isExpanded, undefined, childJson, '', rowSelCls) + '</td>';
    } else {
      const display = item === null ? 'null' : String(item);
      const truncated = truncateText(display);
      const typeClass = item === null ? 'type-null' : 'type-' + typeof item;
      html += '<td class="ov' + rowSelCls + '"'
        + ' data-json-path="' + escHtml(childJson) + '" data-nav-target="value">'
        + '<span class="' + typeClass + '">' + escHtml(truncated.text) + '</span></td>';
    }
    html += '</tr>';
  }
  html += '</table>';
  return html;
}

function renderNestedObjectArrayTable(arr: Record<string, unknown>[], expandPath: string, jsonPath: string): string {
  const headers = objectArrayHeaders(arr);
  let html = '<table border="0" cellspacing="0" cellpadding="0" class="nested-grid-table">';
  // 表头：原站首列为空/# 索引列，其后为字段名
  html += '<tr class="nested-head-row">';
  html += '<td class="op grid-subheader-cell nsh-index-head"><span class="nsh-dots">···</span></td>';
  for (const h of headers) {
    html += '<td class="op grid-subheader-cell">'
      + '<span class="nsh"><span class="nsh-grip">≡</span><span class="nsh-key">' + escHtml(h) + '</span>'
      + '<span class="nsh-filter" title="Filter">▽</span><span class="nsh-more">⋮</span></span></td>';
  }
  html += '</tr>';
  // 数据行
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    const itemJson = jsonPath + '|' + encodePathSegment(String(i));
    const rowSelCls = isArrayRowSelected(currentGridState, itemJson) ? ' grid-nav-selected' : '';
    html += '<tr>';
    // grid-nested-index-cell：# 索引列。点它表示选中整个数组元素（与顶层 # 列一致），
    // 而非仅这个序号格；据此在 updateNavHighlight 里点亮整行。
    html += '<td class="op grid-nested-index-cell' + rowSelCls + '"'
      + ' data-json-path="' + escHtml(itemJson) + '" data-nav-target="value">'
      + '<span class="nsh-rowgrip">⋮</span>' + (i + 1) + '</td>';
    for (const h of headers) {
      const childExpand = expandPath + '|[' + i + ']|' + h;
      const childJson = itemJson + '|' + encodePathSegment(h);
      if (!Object.prototype.hasOwnProperty.call(item, h)) {
        html += '<td class="ov nested-missing' + rowSelCls + '">×</td>';
        continue;
      }
      const cellVal = item[h];
      if (isExpandable(cellVal)) {
        const isExpanded = currentGridState?.expandedCells.has(childExpand) === true;
        html += '<td class="ov">' + renderExpandableCell(cellVal, childExpand, h, isExpanded, undefined, childJson, '', rowSelCls) + '</td>';
      } else {
        const display = cellVal === null ? 'null' : String(cellVal);
        const truncated = truncateText(display);
        const typeClass = cellVal === null ? 'type-null' : 'type-' + typeof cellVal;
        html += '<td class="ov' + (rowSelCls || navSelectedClass(currentGridState, childJson, 'value')) + '"'
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

/**
 * 数组视图：当前选中的是否是某个数组元素根（路径就是 rowPath 本身）。
 * 点 # 列选中的是「整个元素」而非序号数字，所以整行格子都要高亮。
 * 数据格路径为rowPath + '|' + 字段，与 rowPath 不会撞车。
 */
function isArrayRowSelected(state: GridState | null, rowPath: string): boolean {
  if (!state) return false;
  const sel = state.selectedNav;
  return !!sel && sel.target === 'value' && sel.path === rowPath;
}

/** 选中态变化时增量切换 grid-nav-selected，避免全量重绘闪烁 */
function updateNavHighlight(state: GridState, root: HTMLElement): void {
  // 先清掉全部旧选中（元素数量很少），再按当前选中重新点亮。
  // 整行选中的格子 path 各不相同，无法靠 path 相等来判定保留，故用全量重来。
  root.querySelectorAll('.grid-nav-selected').forEach(el => el.classList.remove('grid-nav-selected'));

  const sel = state.selectedNav;
  if (!sel) return;

  // 嵌套表里的 # 索引列（td.op.grid-nested-index-cell）→ 点亮所在整行
  const nestedIdx = root.querySelector('.grid-nested-index-cell[data-json-path="' + cssEscapeAttr(sel.path) + '"]');
  if (nestedIdx && sel.target === 'value') {
    const tr = nestedIdx.parentElement;
    if (tr) {
      const cells = tr.children;
      for (let i = 0; i < cells.length; i++) cells[i].classList.add('grid-nav-selected');
      return;
    }
  }

  // 顶层数组元素根 → 点亮整行
  const idxCell = root.querySelector('.grid-index-cell[data-json-path="' + cssEscapeAttr(sel.path) + '"]');
  if (idxCell && sel.target === 'value') {
    const row = idxCell.parentElement;
    if (row) {
      // 只取直接子元素：嵌套表里的格子属于各自的路径，不应跟着整行一起亮
      const children = row.children;
      for (let i = 0; i < children.length; i++) {
        const el = children[i] as HTMLElement;
        if (el.classList.contains('grid-cell') || el.classList.contains('cell-expandable')) {
          el.classList.add('grid-nav-selected');
        }
      }
      return;
    }
  }

  const next = root.querySelector('[data-json-path="' + cssEscapeAttr(sel.path) + '"][data-nav-target="' + sel.target + '"]');
  if (next) next.classList.add('grid-nav-selected');
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

/** 取消选中时通知主线程立即清掉左侧编辑器的定位高亮（否则要等它自己超时） */
function dispatchGridNavClear(): void {
  window.dispatchEvent(new CustomEvent('grid-nav-clear'));
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
  resetColWidthsToEstimate(currentGridState);
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
function applySortAndFilter(state: GridState): void {
  // 同步保留原始下标，避免 indexOf 在重复行上首次命中
  let pairs: { row: unknown; idx: number }[] = [];
  for (let i = 0; i < state.rows.length; i++) {
    pairs.push({ row: state.rows[i], idx: i });
  }

  // 应用排序，更新 state.filteredRows 与 rowOriginalIndices
  // 索引型 expandKey 会失效，清空展开状态、选中导航并重测布局
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
  resetColWidthsToEstimate(state);
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



// ========== Grid 搜索（复刻原站 app-search-panel：高亮 + N of M 导航，不过滤行） ==========
interface SearchMatch { row: number; col: number; isHeader: boolean; }
interface GridSearchState {
  query: string;
  matches: SearchMatch[];
  current: number;
  cellKeys: Set<string>;
  headerCols: Set<number>;
  /** 匹配数是否触顶（超过 MAX_MATCHES 后停止收集，UI 需显示 “N of MAX+”） */
  truncated: boolean;
}
/** 匹配上限：主线程全表扫描，命中过多时截断，避免百万级对象把标签页拖死 */
const MAX_MATCHES = 5000;
let searchState: GridSearchState | null = null;

// 与渲染文本一致的匹配源：叶子用完整值，可展开单元格用「字段名 + 摘要」
function searchCellText(val: unknown, fieldName: string): string {
  if (isExpandable(val)) {
    return fieldName + (Array.isArray(val) ? ' [' + val.length + ']' : ' {}');
  }
  if (val === null || val === undefined) return val === null ? 'null' : '';
  return String(val);
}

function recomputeSearch(): void {
  if (!searchState || !currentGridState) return;
  const q = searchState.query.toLowerCase();
  const { headers, filteredRows, viewMode } = currentGridState;
  const matches: SearchMatch[] = [];
  const cellKeys = new Set<string>();
  const headerCols = new Set<number>();
  let truncated = false;
  // 列头匹配（原站把 title 也纳入搜索，且列头排最前）
  const headStart = viewMode === 'array' ? 1 : 0;
  for (let h = headStart; h < headers.length; h++) {
    if (headers[h].toLowerCase().includes(q)) {
      matches.push({ row: -1, col: h, isHeader: true });
      headerCols.add(h);
    }
  }
  for (let r = 0; r < filteredRows.length && !truncated; r++) {
    const row = filteredRows[r];
    if (viewMode === 'array') {
      const item = row as Record<string, unknown>;
      for (let h = 1; h < headers.length; h++) {
        const val = item ? item[headers[h]] : undefined;
        if (searchCellText(val, headers[h]).toLowerCase().includes(q)) {
          matches.push({ row: r, col: h, isHeader: false });
          cellKeys.add(r + ',' + h);
          if (matches.length >= MAX_MATCHES) { truncated = true; break; }
        }
      }
    } else {
      const obj = row as { key: string; val: unknown };
      if (String(obj.key).toLowerCase().includes(q)) {
        matches.push({ row: r, col: 0, isHeader: false });
        cellKeys.add(r + ',0');
      }
      if (searchCellText(obj.val, obj.key).toLowerCase().includes(q)) {
        matches.push({ row: r, col: 1, isHeader: false });
        cellKeys.add(r + ',1');
      }
      if (matches.length >= MAX_MATCHES) truncated = true;
    }
  }
  searchState.matches = matches;
  searchState.cellKeys = cellKeys;
  searchState.headerCols = headerCols;
  searchState.truncated = truncated;
  searchState.current = matches.length ? 0 : -1;
  notifySearchChanged();
}

/** 设置搜索词：全量重算匹配（同步，万行级 < 数 ms），空串清除 */
export function setSearchText(text: string): void {
  if (!currentGridState) return;
  const q = text.trim();
  if (!q) {
    searchState = null;
    applySearchHeaderHighlight();
    if (gridRerender) gridRerender();
    return;
  }
  searchState = { query: q, matches: [], current: -1, cellKeys: new Set<string>(), headerCols: new Set<number>(), truncated: false };
  recomputeSearch();
  applySearchHeaderHighlight();
  scrollSearchMatchIntoView();
  if (gridRerender) gridRerender();
}

/** Previous / Next：钳制在 [0, total-1]，不环绕（与原站一致） */
export function searchStep(dir: -1 | 1): void {
  if (!searchState || searchState.matches.length === 0) return;
  const next = searchState.current + dir;
  if (next < 0 || next >= searchState.matches.length) return;
  searchState.current = next;
  applySearchHeaderHighlight();
  scrollSearchMatchIntoView();
  if (gridRerender) gridRerender();
}

export interface GridSearchInfo {
  active: boolean;
  query: string;
  total: number;
  /** 1-based；0 表示无匹配 */
  current: number;
  /** 匹配数是否触顶（UI 需显示 “N of MAX+”） */
  truncated: boolean;
  /** truncated 为 true 时的匹配上限，供 UI 显示 */
  limit: number;
}

export function getSearchInfo(): GridSearchInfo {
  if (!searchState) return { active: false, query: '', total: 0, current: 0, truncated: false, limit: MAX_MATCHES };
  return {
    active: true,
    query: searchState.query,
    total: searchState.matches.length,
    current: searchState.current >= 0 ? searchState.current + 1 : 0,
    truncated: searchState.truncated,
    limit: MAX_MATCHES
  };
}

// 当前匹配的列头高亮（title 紧贴文本，同原站 search-highlight）
function applySearchHeaderHighlight(): void {
  if (!currentGridState) return;
  const headerEl = currentGridState.headerEl;
  if (!headerEl) return;
  const titles = headerEl.querySelectorAll('.header-title');
  for (let i = 0; i < titles.length; i++) {
    const el = titles[i] as HTMLElement;
    const cell = el.closest('.grid-cell') as HTMLElement | null;
    const colIdx = cell ? Number(cell.dataset.colIndex) : -1;
    el.classList.remove('jg-search-cur', 'jg-search-soft');
    if (!searchState || colIdx < 0) continue;
    if (!searchState.headerCols.has(colIdx)) continue;
    const isCur = searchState.matches[searchState.current] ? searchState.matches[searchState.current].isHeader
      && searchState.matches[searchState.current].col === colIdx : false;
    el.classList.add(isCur ? 'jg-search-cur' : 'jg-search-soft');
  }
}

// 当前匹配滚动到可视区（垂直按行高前缀和，水平按列宽前缀和）
// 注意：累加上限必须与 renderVisibleRows 的 rowOffsets 一致（那边遍历到总行数）。
// rowHeights 是稀疏数组（只测过可见窗口），不能拿它的 length 当行数上界。
function scrollSearchMatchIntoView(): void {
  if (!searchState || !currentGridState) return;
  const m = searchState.matches[searchState.current];
  if (!m) return;
  const state = currentGridState;
  if (!m.isHeader) {
    let off = 0;
    for (let i = 0; i < m.row; i++) off += state.rowHeights[i] || ROW_HEIGHT;
    const h = state.rowHeights[m.row] || ROW_HEIGHT;
    const target = Math.max(0, off - state.container.clientHeight / 3);
    if (off < state.container.scrollTop + state.container.clientHeight * 0.3
      || off + h > state.container.scrollTop + state.container.clientHeight) {
      state.container.scrollTop = target;
    }
  }
  // 水平：滚动 body 让目标列进入视野（header 会经 scroll 监听同步）
  const body = state.container.querySelector('.virtual-grid-body') as HTMLElement | null;
  if (body) {
    let colLeft = 0;
    for (let c = 0; c < m.col && c < state.colWidths.length; c++) colLeft += state.colWidths[c];
    const colW = state.colWidths[m.col] || 120;
    if (colLeft < body.scrollLeft || colLeft + colW > body.scrollLeft + body.clientWidth) {
      body.scrollLeft = Math.max(0, colLeft - 60);
    }
  }
}

// 渲染行内单元格时的搜索高亮 class（软高亮 = 普通匹配，强高亮 = 当前匹配）
function searchCellClass(row: number, col: number): string {
  if (!searchState || !searchState.cellKeys.has(row + ',' + col)) return '';
  const m = searchState.matches[searchState.current];
  if (m && !m.isHeader && m.row === row && m.col === col) return ' jg-search-cur';
  return ' jg-search-soft';
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
  currentGridState.expandedCells.clear();
  currentGridState.selectedNav = null;
  resetColWidthsToEstimate(currentGridState);
  currentGridState.measured = false;
  currentGridState.rowHeights = [];
  // 编辑改变了数据 → 重算搜索匹配与列头高亮，否则红框/计数停留在旧值上
  if (searchState) recomputeSearch();
  applySearchHeaderHighlight();
  if (gridRerender) gridRerender();
}
