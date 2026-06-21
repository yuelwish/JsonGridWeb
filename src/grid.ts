// Grid 视图：虚拟滚动，可展开嵌套数据，固定行高，零外部依赖

const ROW_HEIGHT = 42;
const CHILD_ROW_HEIGHT = 34;
const OVERSCAN = 5;

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
    headers = ['键', '值', '类型'];
    rows = Object.entries(data as Record<string, unknown>).map(([k, v]) => {
      const type = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
      return { key: k, val: v, type };
    });
    viewMode = 'object';
  } else {
    container.innerHTML = '<p style="color: var(--text-muted);">JSON 必须是对象或数组</p>';
    return;
  }

  const expandedCells = new Set<string>();

  const wrapper = document.createElement('div');
  wrapper.className = 'virtual-grid-wrapper';

  const headerEl = buildHeader(headers);
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

  const state: GridState = {
    headers, rows, container, bodyEl: body, rowsEl, spacerEl: spacer, infoEl: info,
    expandedCells, viewMode
  };

  function rerender() { renderVisibleRows(state); }

  body.addEventListener('scroll', rerender);
  body.addEventListener('scroll', () => { headerEl.scrollLeft = body.scrollLeft; });
  headerEl.addEventListener('scroll', () => { body.scrollLeft = headerEl.scrollLeft; });

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
    const key = expandable.getAttribute('data-expand-key');
    if (!key) return;

    const expandIcon = expandable.querySelector('.expand-icon');
    
    if (expandedCells.has(key)) {
      expandedCells.delete(key);
      if (expandIcon) expandIcon.classList.remove('expanded');
    } else {
      expandedCells.add(key);
      if (expandIcon) expandIcon.classList.add('expanded');
    }
    rerender();
  });

  rerender();
}

function buildHeader(headers: string[]): HTMLElement {
  const headerEl = document.createElement('div');
  headerEl.className = 'virtual-grid-header';
  for (const h of headers) {
    const cell = document.createElement('div');
    cell.className = 'grid-cell';
    if (h === '#') cell.className += ' grid-index-cell';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = h;
    nameSpan.style.flex = '1';
    nameSpan.style.overflow = 'hidden';
    nameSpan.style.textOverflow = 'ellipsis';
    nameSpan.style.textAlign = h === '#' ? 'center' : 'left';
    cell.appendChild(nameSpan);

    const dragHandle = document.createElement('span');
    dragHandle.className = 'header-drag-handle';
    dragHandle.textContent = '\u2630';
    dragHandle.setAttribute('title', '拖拽列');
    cell.appendChild(dragHandle);

    const sortIcon = document.createElement('span');
    sortIcon.className = 'header-sort-icon';
    sortIcon.textContent = '\u25BE';
    cell.appendChild(sortIcon);

    headerEl.appendChild(cell);
  }
  return headerEl;
}

interface DisplayRow {
  type: 'normal' | 'child';
  rowIndex: number;
  data?: unknown;
  key?: string;
  value?: unknown;
  childType?: string;
}

function buildDisplayRows(state: GridState): DisplayRow[] {
  const { rows, headers, expandedCells, viewMode } = state;
  const result: DisplayRow[] = [];

  for (let i = 0; i < rows.length; i++) {
    result.push({ type: 'normal', rowIndex: i, data: rows[i] });

    if (viewMode === 'array') {
      for (let h = 1; h < headers.length; h++) {
        const item = rows[i] as Record<string, unknown>;
        const val = item ? item[headers[h]] : undefined;
        if (isExpandable(val)) {
          const key = i + '|' + h;
          if (expandedCells.has(key)) {
            const children = getChildren(val);
            for (const child of children) {
              result.push({ type: 'child', rowIndex: i, key: child.key, value: child.value, childType: child.type });
            }
          }
        }
      }
    } else {
      const obj = rows[i] as { key: string; val: unknown; type: string };
      if (isExpandable(obj.val)) {
        const key = i + '|1';
        if (expandedCells.has(key)) {
          const children = getChildren(obj.val);
          for (const child of children) {
            result.push({ type: 'child', rowIndex: i, key: child.key, value: child.value, childType: child.type });
          }
        }
      }
    }
  }

  return result;
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
  const { headers, bodyEl, rowsEl, spacerEl, infoEl, viewMode } = state;
  const displayRows = buildDisplayRows(state);
  const totalDisplayRows = displayRows.length;

  const scrollTop = bodyEl.scrollTop;
  const viewHeight = bodyEl.clientHeight;

  // 计算偏移
  const rowOffsets: number[] = new Array(totalDisplayRows);
  let offset = 0;
  for (let i = 0; i < totalDisplayRows; i++) {
    rowOffsets[i] = offset;
    offset += displayRows[i].type === 'normal' ? ROW_HEIGHT : CHILD_ROW_HEIGHT;
  }
  spacerEl.style.height = offset + 'px';

  // 可见范围
  let startIdx = 0;
  let endIdx = totalDisplayRows;
  for (let i = 0; i < totalDisplayRows; i++) {
    const rh = displayRows[i].type === 'normal' ? ROW_HEIGHT : CHILD_ROW_HEIGHT;
    if (rowOffsets[i] + rh >= scrollTop - OVERSCAN * ROW_HEIGHT) {
      startIdx = Math.max(0, i - OVERSCAN);
      break;
    }
  }
  for (let i = totalDisplayRows - 1; i >= 0; i--) {
    if (rowOffsets[i] <= scrollTop + viewHeight + OVERSCAN * ROW_HEIGHT) {
      endIdx = Math.min(totalDisplayRows, i + 1 + OVERSCAN);
      break;
    }
  }

  rowsEl.style.top = rowOffsets[startIdx] + 'px';

  const parts: string[] = [];
  for (let i = startIdx; i < endIdx; i++) {
    const dr = displayRows[i];
    if (dr.type === 'normal') {
      parts.push(renderNormalRow(state, dr, headers, viewMode));
    } else {
      parts.push(renderChildRow(state, dr));
    }
  }

  rowsEl.innerHTML = parts.join('');

  if (infoEl) {
    const expandedCount = state.expandedCells.size;
    infoEl.textContent = expandedCount > 0
      ? state.rows.length + ' 行，' + expandedCount + ' 个展开'
      : '共 ' + state.rows.length + ' 行';
  }
}

// ponytail: state 参数保留以保持函数签名一致性，当前未使用
function renderNormalRow(_state: GridState, dr: DisplayRow, headers: string[], viewMode: string): string {
  const row = dr.data!;
  const actualIdx = dr.rowIndex;
  const parts: string[] = [];

  parts.push('<div class="grid-row" style="height:' + ROW_HEIGHT + 'px">');

  if (viewMode === 'array') {
    parts.push('<div class="grid-cell grid-index-cell" data-line="' + (actualIdx + 1) + '">' + (actualIdx + 1) + '</div>');
    const item = row as Record<string, unknown>;
    for (let h = 1; h < headers.length; h++) {
      const val = item ? item[headers[h]] : undefined;
      if (isExpandable(val)) {
        parts.push(renderExpandableCell(val, actualIdx, h, headers[h]));
      } else {
        const { display, typeClass } = formatCell(val);
        const truncated = truncateText(display);
        parts.push('<div class="grid-cell ' + typeClass + '"'
          + (truncated.shouldTruncate ? ' title="' + escHtml(display) + '"' : '')
          + '>' + escHtml(truncated.text) + '</div>');
      }
    }
  } else {
    const obj = row as { key: string; val: unknown; type: string };
    parts.push('<div class="grid-cell grid-key-cell" data-key="' + escHtml(obj.key) + '">' + escHtml(obj.key) + '</div>');
    if (isExpandable(obj.val)) {
      parts.push(renderExpandableCell(obj.val, actualIdx, 1, obj.key));
    } else {
      const display = String(obj.val);
      const truncated = truncateText(display);
      parts.push('<div class="grid-cell type-' + obj.type + '"'
        + (truncated.shouldTruncate ? ' title="' + escHtml(display) + '"' : '')
        + '>' + escHtml(truncated.text) + '</div>');
    }
    parts.push('<div class="grid-cell type-' + obj.type + '">' + obj.type + '</div>');
  }

  parts.push('</div>');
  return parts.join('');
}

function renderExpandableCell(val: unknown, rowIdx: number, colIdx: number, headerName: string): string {
  const key = rowIdx + '|' + colIdx;

  let expandedLabel = '';
  
  if (Array.isArray(val)) {
    expandedLabel = '[+] ' + escHtml(headerName) + '[' + val.length + ']';
  } else if (val !== null && typeof val === 'object') {
    const keys = Object.keys(val as Record<string, unknown>);
    expandedLabel = '[+] ' + escHtml(headerName) + ' {' + keys.length + '}';
  }

  return '<div class="grid-cell cell-expandable" data-expand-key="' + key + '">'
    + '<span class="expand-icon">\u25B6</span>'
    + '<span class="expand-label"><span class="expand-key-name">' + expandedLabel + '</span></span>'
    + '</div>';
}

function renderChildRow(state: GridState, dr: DisplayRow): string {
  const parts: string[] = [];

  parts.push('<div class="grid-row grid-row-child" style="height:' + CHILD_ROW_HEIGHT + 'px">');

  if (state.viewMode === 'array') {
    parts.push('<div class="grid-cell grid-index-cell" style="opacity:0.2">\u2002</div>');
    for (let i = 1; i < state.headers.length; i++) {
      if (i === 1) {
        const childTypeClass = 'type-' + dr.childType;
        const display = (dr.value !== null && typeof dr.value === 'object')
          ? JSON.stringify(dr.value) : String(dr.value);
        const truncated = truncateText(display);
        parts.push('<div class="grid-cell child-key-cell" data-key="' + escHtml(dr.key!) + '">'
          + '<span style="color:var(--text-muted);font-size:0.75rem">' + escHtml(dr.key!) + '</span>'
          + ': <span class="' + childTypeClass + '">' + escHtml(truncated.text) + '</span>'
          + '</div>');
      } else {
        parts.push('<div class="grid-cell"></div>');
      }
    }
  } else {
    const childTypeClass = 'type-' + dr.childType;
    const display = (dr.value !== null && typeof dr.value === 'object')
      ? JSON.stringify(dr.value) : String(dr.value);
    const truncated = truncateText(display);
    parts.push('<div class="grid-cell" style="padding-left:1.75rem" data-key="' + escHtml(dr.key!) + '"></div>');
    parts.push('<div class="grid-cell ' + childTypeClass + '" style="padding-left:1.75rem">'
      + '<span style="color:var(--text-muted);font-size:0.75rem">' + escHtml(dr.key!) + '</span>'
      + ': ' + escHtml(truncated.text) + '</div>');
    parts.push('<div class="grid-cell type-' + dr.childType + '">' + dr.childType + '</div>');
  }

  parts.push('</div>');
  return parts.join('');
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
