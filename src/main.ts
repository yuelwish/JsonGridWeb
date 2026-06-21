import './style.css';
import { EditorView, basicSetup } from 'codemirror';
import { Decoration, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { json } from '@codemirror/lang-json';
import { renderTree } from './tree';
import { renderVirtualGrid } from './grid';

// ========== Worker 管理 ==========
let worker: Worker;
let messageId = 0;
const pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function initWorker() {
  const workerCode = getWorkerCode();
  const blob = new Blob([workerCode], { type: 'application/javascript' });
  worker = new Worker(URL.createObjectURL(blob));

  worker.onmessage = (e) => {
    const { id, success, result, error } = e.data;
    const cb = pendingRequests.get(id);
    if (cb) {
      pendingRequests.delete(id);
      if (success) cb.resolve(result);
      else cb.reject(new ErrorWithPosition(error));
    }
  };
}

// 错误类，包含位置信息
class ErrorWithPosition extends Error {
  line?: number;
  col?: number;
  
  constructor(message: string) {
    super(message);
    this.name = 'ErrorWithPosition';
    
    // 解析错误消息中的位置信息
    const match = message.match(/position (\d+)/);
    if (match) {
      const pos = Number(match[1]);
      // 简单计算行号和列号
      const lines = message.substring(0, pos).split('\n');
      this.line = lines.length;
      this.col = lines.length > 0 ? lines[lines.length - 1].length : 0;
    }
  }
}

function workerRequest(type: string, payload: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = messageId++;
    pendingRequests.set(id, { resolve, reject });
    worker.postMessage({ type, payload, id });
  });
}

function getWorkerCode(): string {
  return `
    self.onmessage = function(e) {
      const { type, payload, id } = e.data;
      try {
        let result;
        switch (type) {
          case 'parse': result = parseJSON(payload); break;
          case 'format': result = formatJSON(payload); break;
          case 'compress': result = compressJSON(payload); break;
          case 'validate': result = validateJSON(payload); break;
          case 'search': result = searchJSON(payload); break;
          case 'filter': result = filterJSON(payload); break;
          default: throw new Error('Unknown: ' + type);
        }
        self.postMessage({ id, success: true, result });
      } catch (err) {
        self.postMessage({ id, success: false, error: err.message });
      }
    };

    function parseJSON(s) {
      var t = performance.now();
      var d = JSON.parse(s);
      return { data: d, parseTime: performance.now() - t, size: s.length };
    }

    function formatJSON(s) {
      var t = performance.now();
      var d = JSON.parse(s);
      var r = JSON.stringify(d, null, 2);
      return { result: r, processTime: performance.now() - t, originalSize: s.length, formattedSize: r.length };
    }

    function compressJSON(s) {
      var t = performance.now();
      var d = JSON.parse(s);
      var r = JSON.stringify(d);
      return { result: r, processTime: performance.now() - t, originalSize: s.length, compressedSize: r.length, saved: s.length - r.length };
    }

      function validateJSON(s) {
        var t = performance.now();
        try { JSON.parse(s); return { valid: true, validateTime: performance.now() - t }; }
        catch (e) {
          // 解析 e.message 获取位置
          // 典型错误：Unexpected token X in JSON at position 123
          var pos = 0;
          // 简单位置检测：查找 "character" 或 "position" 关键字
          var msg = e.message;
          if (msg.includes('character')) {
            var charMatch = msg.match(/character\s+(\d+)/i);
            if (charMatch) pos = Number(charMatch[1]);
          } else if (msg.includes('position')) {
            var posMatch = msg.match(/position\s+(\d+)/i);
            if (posMatch) pos = Number(posMatch[1]);
          }
          // 计算行号和列号
          var lines = s.substring(0, pos).split('\\n');
          var line = lines.length;
          var col = lines.length > 0 ? lines[lines.length - 1].length : 0;
          return { valid: false, error: e.message, line: line, col: col, validateTime: performance.now() - t };
        }
      }

    function searchJSON(p) {
      var s = p.jsonString, q = p.query;
      var t = performance.now();
      var d = JSON.parse(s);
      var results = [];
      var ql = q.toLowerCase();

      function search(obj, path) {
        if (obj === null || obj === undefined) return;
        if (typeof obj === 'object') {
          if (Array.isArray(obj)) {
            obj.forEach(function(item, i) { search(item, path + '[' + i + ']'); });
          } else {
            Object.keys(obj).forEach(function(key) {
              var cp = path ? path + '.' + key : key;
              var val = obj[key];
              if (key.toLowerCase().indexOf(ql) !== -1) {
                results.push({ path: cp, type: 'key', match: key, value: typeof val === 'object' ? JSON.stringify(val).substring(0, 100) : val });
              }
              if (typeof val === 'string' && val.toLowerCase().indexOf(ql) !== -1) {
                results.push({ path: cp, type: 'value', match: val, key: key });
              }
              if (typeof val === 'object' && val !== null) search(val, cp);
            });
          }
        }
      }
      search(d, '');
      return { results: results.slice(0, 1000), total: results.length, searchTime: performance.now() - t };
    }

    function filterJSON(p) {
      var s = p.jsonString, expr = p.expression;
      var t = performance.now();
      var d = JSON.parse(s);

      // jq 子集解析
      var result = applyFilter(d, expr);
      return { result: result, processTime: performance.now() - t };
    }

    function applyFilter(data, expr) {
      expr = expr.trim();
      if (!expr || expr === '.') return data;

      // 管道分割
      var pipes = splitPipe(expr);
      var current = data;
      for (var i = 0; i < pipes.length; i++) {
        current = applySingle(current, pipes[i].trim());
      }
      return current;
    }

    function splitPipe(expr) {
      var parts = [];
      var depth = 0;
      var buf = '';
      for (var i = 0; i < expr.length; i++) {
        var c = expr[i];
        if (c === '[' || c === '(') depth++;
        else if (c === ']' || c === ')') depth--;
        else if (c === '|' && depth === 0) { parts.push(buf); buf = ''; continue; }
        buf += c;
      }
      if (buf) parts.push(buf);
      return parts;
    }

    function applySingle(data, expr) {
      if (expr === 'length') {
        if (Array.isArray(data)) return data.length;
        if (typeof data === 'object' && data !== null) return Object.keys(data).length;
        if (typeof data === 'string') return data.length;
        return 0;
      }
      if (expr === 'keys') {
        if (typeof data === 'object' && data !== null) return Object.keys(data);
        return [];
      }
      if (expr === 'values') {
        if (typeof data === 'object' && data !== null) return Object.values(data);
        return [];
      }
      if (expr === '.[]' || expr === '[]') {
        if (Array.isArray(data)) return data;
        if (typeof data === 'object' && data !== null) return Object.values(data);
        return data;
      }

      // 路径表达式 .foo.bar[0].baz
      var path = expr;
      if (path.charAt(0) === '.') path = path.substring(1);

      var tokens = tokenize(path);
      var current = data;
      for (var i = 0; i < tokens.length; i++) {
        if (current === null || current === undefined) return undefined;
        var tok = tokens[i];
        if (tok === '[]') {
          // 展开数组
          if (Array.isArray(current)) {
            var rest = tokens.slice(i + 1);
            if (rest.length === 0) return current;
            return current.map(function(item) { return applyTokens(item, rest); });
          }
          return undefined;
        }
        current = current[tok];
      }
      return current;
    }

    function applyTokens(data, tokens) {
      var current = data;
      for (var i = 0; i < tokens.length; i++) {
        if (current === null || current === undefined) return undefined;
        var tok = tokens[i];
        if (tok === '[]') {
          if (Array.isArray(current)) {
            var rest = tokens.slice(i + 1);
            if (rest.length === 0) return current;
            return current.map(function(item) { return applyTokens(item, rest); });
          }
          return undefined;
        }
        current = current[tok];
      }
      return current;
    }

    function tokenize(path) {
      var tokens = [];
      var buf = '';
      for (var i = 0; i < path.length; i++) {
        var c = path[i];
        if (c === '.') {
          if (buf) { tokens.push(buf); buf = ''; }
        } else if (c === '[') {
          if (buf) { tokens.push(buf); buf = ''; }
          var j = path.indexOf(']', i);
          var idx = path.substring(i + 1, j);
          if (idx === '') tokens.push('[]');
          else tokens.push(idx);
          i = j;
        } else {
          buf += c;
        }
      }
      if (buf) tokens.push(buf);
      return tokens;
    }
  `;
}

// ========== 编辑器 ==========
let inputEditor: EditorView;
let outputEditor: EditorView;
let searchDecorations: DecorationSet = Decoration.none;

function initEditors() {
  // ponytail: search highlight 用 ViewPlugin 管理，避免手动清理
  const searchHighlight = ViewPlugin.define(() => ({
    decorations: searchDecorations,
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = searchDecorations;
      }
    }
  }), { decorations: v => v.decorations });

  let autoFormatTimer: number;

  inputEditor = new EditorView({
    doc: '{\n  "message": "在此输入 JSON"\n}',
    extensions: [
      basicSetup,
      json(),
      searchHighlight,
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !autoFormatting) {
          updateStats('input');
          // debounce 500ms 自动格式化
          clearTimeout(autoFormatTimer);
          autoFormatTimer = window.setTimeout(() => {
            autoFormat();
          }, 500);
        }
      })
    ],
    parent: document.getElementById('editor-input')!
  });

  outputEditor = new EditorView({
    doc: '',
    extensions: [basicSetup, json(), searchHighlight],
    parent: document.getElementById('editor-output')!
  });
}

function updateStats(side: 'input' | 'output') {
  const editor = side === 'input' ? inputEditor : outputEditor;
  const content = editor.state.doc.toString();
  const el = document.getElementById(side === 'input' ? 'input-stats' : 'output-stats');
  if (el) el.textContent = `${content.length} 字符 | ${content.split('\n').length} 行`;
}

/**
 * 自动格式化：静默尝试，失败时不清空输出
 * 修复：始终更新输出，不检查 currentOutput 是否为空
 */
let autoFormatting = false;

async function autoFormat() {
  if (autoFormatting) return;
  const input = inputEditor.state.doc.toString();
  if (!input.trim()) return;
  try {
    const result = await workerRequest('format', input);
    const formatted = result.result;
    // 如果已经格式化过（内容相同），跳过
    if (formatted === input) {
      if (currentView === 'grid') renderGridView();
      return;
    }
    autoFormatting = true;
    inputEditor.dispatch({ changes: { from: 0, to: inputEditor.state.doc.length, insert: formatted } });
    updateStats('input');
    autoFormatting = false;
    if (currentView === 'grid') renderGridView();
  } catch {
    // 无效 JSON，不更新
  }
}

function setStatus(msg: string, type: 'info' | 'success' | 'error' = 'info') {
  const el = document.getElementById('status-message');
  if (el) {
    el.textContent = msg;
    el.style.color = type === 'error' ? 'var(--error-color)' : type === 'success' ? 'var(--success-color)' : 'var(--text-muted)';
  }
}

// ========== 搜索高亮 ==========
function highlightSearchMatches(matches: Array<{ match: string }>) {
  const editor = inputEditor;
  const doc = editor.state.doc.toString();
  const query = matches.length > 0 ? matches[0].match : '';
  if (!query) {
    searchDecorations = Decoration.none;
    inputEditor.dispatch({});
    outputEditor.dispatch({});
    return;
  }

  const ql = query.toLowerCase();
  const decorations: any[] = [];
  const mark = Decoration.mark({ class: 'cm-search-match' });

  // 在整个文档中查找匹配
  const lines = doc.split('\n');
  let offset = 0;
  for (const line of lines) {
    const ll = line.toLowerCase();
    let pos = 0;
    while (pos < ll.length) {
      const idx = ll.indexOf(ql, pos);
      if (idx === -1) break;
      decorations.push(mark.range(offset + idx, offset + idx + query.length));
      pos = idx + 1;
    }
    offset += line.length + 1;
  }

  searchDecorations = Decoration.set(decorations.sort((a: any, b: any) => a.from - b.from));
  inputEditor.dispatch({});
  outputEditor.dispatch({});
}

// ========== 主题切换 ==========
function initTheme() {
  const saved = localStorage.getItem('jsongrid-theme');
  if (saved === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    const btn = document.getElementById('btn-theme');
    if (btn) btn.textContent = '☀️';
  }

  document.getElementById('btn-theme')?.addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (isDark) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('jsongrid-theme', 'light');
      const btn = document.getElementById('btn-theme');
      if (btn) btn.textContent = '🌙';
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('jsongrid-theme', 'dark');
      const btn = document.getElementById('btn-theme');
      if (btn) btn.textContent = '☀️';
    }
  });
}

// ========== URL 参数 ==========
function initURLParams() {
  const params = new URLSearchParams(window.location.search);

  const jsonParam = params.get('json');
  if (jsonParam) {
    try {
      const decoded = decodeURIComponent(jsonParam);
      inputEditor.dispatch({
        changes: { from: 0, to: inputEditor.state.doc.length, insert: decoded }
      });
      updateStats('input');
      setStatus('已从 URL 加载 JSON', 'success');
    } catch (err) {
      setStatus('URL 参数解析失败', 'error');
    }
    return;
  }

  const urlParam = params.get('url');
  if (urlParam) {
    setStatus('正在从 URL 加载...');
    fetch(urlParam)
      .then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(text => {
        inputEditor.dispatch({
          changes: { from: 0, to: inputEditor.state.doc.length, insert: text }
        });
        updateStats('input');
        setStatus('已从远程 URL 加载', 'success');
      })
      .catch(err => setStatus('URL 加载失败: ' + err.message, 'error'));
  }
}

// ========== 视图切换 ==========
let currentView: 'grid' | 'tree' = 'grid';

function switchView(view: 'grid' | 'tree') {
  currentView = view;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-view') === view);
  });

  const editorOutput = document.getElementById('editor-output')!;
  const gridView = document.getElementById('grid-view')!;
  const treeView = document.getElementById('tree-view')!;
  const gridToolbar = document.getElementById('grid-toolbar')!;

  editorOutput.style.display = 'none';
  gridView.style.display = 'none';
  treeView.style.display = 'none';
  gridToolbar.style.display = 'none';

  if (view === 'grid') {
    gridView.style.display = 'block';
    gridToolbar.style.display = 'flex';
    renderGridView();
  } else if (view === 'tree') {
    treeView.style.display = 'block';
    renderTreeView();
  }
}

async function renderGridView() {
   const input = inputEditor.state.doc.toString();
   if (!input.trim()) {
     document.getElementById('grid-view')!.innerHTML = '<p style="color: var(--text-muted);">请输入 JSON 数据</p>';
     return;
   }
   try {
     const result = await workerRequest('parse', input);
     renderVirtualGrid(result.data, document.getElementById('grid-view')!);
   } catch (err: any) {
     document.getElementById('grid-view')!.innerHTML = `<p style="color: var(--error-color);">解析失败: ${err.message}</p>`;
     // 如果有位置信息，定位到错误位置
     if (err.line && err.col) {
       highlightError(err.line, err.col);
     }
   }
 }
 
 async function renderTreeView() {
   const input = inputEditor.state.doc.toString();
   if (!input.trim()) {
     document.getElementById('tree-view')!.innerHTML = '<p style="color: var(--text-muted);">请输入 JSON 数据</p>';
     return;
   }
   try {
     const result = await workerRequest('parse', input);
     renderTree(result.data, document.getElementById('tree-view')!);
   } catch (err: any) {
     document.getElementById('tree-view')!.innerHTML = `<p style="color: var(--error-color);">解析失败: ${err.message}</p>`;
     // 如果有位置信息，定位到错误位置
     if (err.line && err.col) {
       highlightError(err.line, err.col);
     }
   }
 }

// ========== 事件绑定 ==========
function setupEventListeners() {
  document.getElementById('btn-format')?.addEventListener('click', async () => {
    const input = inputEditor.state.doc.toString();
    if (!input.trim()) { setStatus('请输入 JSON', 'error'); return; }
    try {
      setStatus('格式化中...');
      const result = await workerRequest('format', input);
      autoFormatting = true;
      inputEditor.dispatch({ changes: { from: 0, to: inputEditor.state.doc.length, insert: result.result } });
      updateStats('input');
      autoFormatting = false;
      setStatus(`格式化完成 (${result.processTime.toFixed(2)}ms)`, 'success');
    } catch (err: any) {
      setStatus(`格式化失败: ${err.message}`, 'error');
    }
  });

  document.getElementById('btn-compress')?.addEventListener('click', async () => {
    const input = inputEditor.state.doc.toString();
    if (!input.trim()) { setStatus('请输入 JSON', 'error'); return; }
    try {
      setStatus('压缩中...');
      const result = await workerRequest('compress', input);
      autoFormatting = true;
      inputEditor.dispatch({ changes: { from: 0, to: inputEditor.state.doc.length, insert: result.result } });
      updateStats('input');
      autoFormatting = false;
      setStatus(`压缩完成，节省 ${(result.saved / 1024).toFixed(2)} KB`, 'success');
    } catch (err: any) {
      setStatus(`压缩失败: ${err.message}`, 'error');
    }
  });

  document.getElementById('btn-clear')?.addEventListener('click', () => {
    inputEditor.dispatch({ changes: { from: 0, to: inputEditor.state.doc.length, insert: '' } });
    outputEditor.dispatch({ changes: { from: 0, to: outputEditor.state.doc.length, insert: '' } });
    searchDecorations = Decoration.none;
    inputEditor.dispatch({});
    updateStats('input');
    updateStats('output');
    setStatus('已清空');
  });

  // 搜索 + 高亮
  const searchInput = document.getElementById('search-input') as HTMLInputElement;
  let searchTimeout: number;
  searchInput?.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const query = (e.target as HTMLInputElement).value;
    if (!query.trim()) {
      searchDecorations = Decoration.none;
      inputEditor.dispatch({});
      outputEditor.dispatch({});
      setStatus('就绪');
      return;
    }
    searchTimeout = window.setTimeout(async () => {
      const input = inputEditor.state.doc.toString();
      if (!input.trim()) return;
      try {
        setStatus('搜索中...');
        const result = await workerRequest('search', { jsonString: input, query });
        highlightSearchMatches(result.results);
        setStatus(`找到 ${result.total} 个匹配 (${result.searchTime.toFixed(2)}ms)`, 'success');
      } catch (err: any) {
        setStatus(`搜索失败: ${err.message}`, 'error');
      }
    }, 300);
  });

   // 视图切换
   document.querySelectorAll('.tab-btn').forEach(btn => {
     btn.addEventListener('click', (e) => {
       const view = (e.target as HTMLElement).dataset.view as 'grid' | 'tree';
       if (view) switchView(view);
     });
   });
   
    // Grid 视图定位到编辑器 - 简化版本
    window.addEventListener('grid-navigate', (e: any) => {
      const { line } = e.detail;
      const lineNo = Math.max(0, line - 1);
      // 滚动编辑器到指定行
      inputEditor.dispatch({
        scrollIntoView: true,
        selection: { anchor: lineNo, head: lineNo }
      });
    });
    
    window.addEventListener('grid-navigate-key', (e: any) => {
      const { key } = e.detail;
      const doc = inputEditor.state.doc;
      const lines = doc.toString().split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('"' + key + '"') || lines[i].includes(key + '":')) {
          inputEditor.dispatch({
            scrollIntoView: true,
            selection: { anchor: i, head: i }
          });
          break;
        }
      }
    });
  }

// ========== 初始化 ==========
function init() {
  initWorker();
  initEditors();
  initTheme();
  setupEventListeners();
   updateStats('input');
  updateStats('output');
  setStatus('就绪');
  // 默认显示 Grid 视图
  switchView('grid');
   // 初始化拖拽条
   initPanelResizer();
   // URL 参数最后处理（可能覆盖编辑器内容）
   initURLParams();
}

// ========== 拖拽条 ==========
function initPanelResizer() {
  const resizer = document.getElementById('resizer');
  const container = document.querySelector('.content') as HTMLElement;
  const leftPanel = document.querySelector('.left-panel') as HTMLElement;
  const rightPanel = document.querySelector('.right-panel') as HTMLElement;
  
  if (!resizer || !container || !leftPanel || !rightPanel) return;
  
  // 折叠状态：记录折叠前的比例，用于恢复
  let previousRatio = parseFloat(localStorage.getItem('panelRatio') || '50');
  let isLeftCollapsed = false;
  let isRightCollapsed = false;
  
  // 从 localStorage 恢复比例
  const ratio = localStorage.getItem('panelRatio');
  if (ratio) {
    const leftWidth = Math.max(20, Math.min(80, parseFloat(ratio)));
    leftPanel.style.width = leftWidth + '%';
    rightPanel.style.width = (100 - leftWidth) + '%';
  }
  
  let isDragging = false;
  
  resizer.addEventListener('mousedown', (e) => {
    // 如果点击的是按钮，不启动拖拽
    if ((e.target as HTMLElement).classList.contains('resizer-btn')) return;
    e.preventDefault();
    isDragging = true;
    // 拖拽时重置折叠状态
    isLeftCollapsed = false;
    isRightCollapsed = false;
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', stopDrag);
    document.body.style.cursor = 'col-resize';
  });
  
   function onDrag(e: MouseEvent) {
     if (!isDragging) return;
     const containerWidth = container.offsetWidth;
     let leftWidth = (e.clientX / containerWidth) * 100;
     // 限制在 20%-80% 范围
     leftWidth = Math.max(20, Math.min(80, leftWidth));
     leftPanel.style.width = leftWidth + '%';
     rightPanel.style.width = (100 - leftWidth) + '%';
     localStorage.setItem('panelRatio', String(leftWidth));
     previousRatio = leftWidth;
     // 拖拽时重置折叠状态
     isLeftCollapsed = false;
     isRightCollapsed = false;
   }
  
  function stopDrag() {
    isDragging = false;
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', stopDrag);
    document.body.style.cursor = '';
  }

  // 折叠左侧面板按钮（◀）
  document.getElementById('btn-collapse-left')?.addEventListener('click', () => {
    if (isLeftCollapsed) {
      // 恢复：回到之前的比例或 50/50
      const restore = previousRatio || 50;
      leftPanel.style.width = restore + '%';
      rightPanel.style.width = (100 - restore) + '%';
      localStorage.setItem('panelRatio', String(restore));
      isLeftCollapsed = false;
    } else {
      // 折叠左侧：左 20%，右 80%
      previousRatio = parseFloat(leftPanel.style.width) || 50;
      leftPanel.style.width = '20%';
      rightPanel.style.width = '80%';
      localStorage.setItem('panelRatio', '20');
      isLeftCollapsed = true;
      isRightCollapsed = false;
    }
  });

  // 折叠右侧面板按钮（▶）
  document.getElementById('btn-collapse-right')?.addEventListener('click', () => {
    if (isRightCollapsed) {
      // 恢复：回到之前的比例或 50/50
      const restore = previousRatio || 50;
      leftPanel.style.width = restore + '%';
      rightPanel.style.width = (100 - restore) + '%';
      localStorage.setItem('panelRatio', String(restore));
      isRightCollapsed = false;
    } else {
      // 折叠右侧：左 80%，右 20%
      previousRatio = parseFloat(leftPanel.style.width) || 50;
      leftPanel.style.width = '80%';
      rightPanel.style.width = '20%';
      localStorage.setItem('panelRatio', '80');
      isRightCollapsed = true;
      isLeftCollapsed = false;
    }
  });
}

// ========== 错误高亮 ==========
function highlightError(line: number, col: number) {
  // 从 0 开始索引
 // 简化版本：只使用 scrollIntoView，不使用 markText（CodeMirror 6 API 不同）
   // 直接滚动编辑器容器
   const scroller = inputEditor.scrollDOM;
   const lineNo = line - 1;
   const lineHeight = 24; // approximate line height
   scroller.scrollTop = lineNo * lineHeight;
   // 5 秒后显示提示
   setTimeout(() => {
     setStatus(`错误位置: 第 ${line} 行，第 ${col + 1} 列`, 'error');
   }, 100);
 }

init();
