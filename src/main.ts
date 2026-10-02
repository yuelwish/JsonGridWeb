import './style.css';
import { EditorView, basicSetup } from 'codemirror';
import { openSearchPanel } from '@codemirror/search';
import { Decoration, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { json } from '@codemirror/lang-json';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { renderVirtualGrid, expandAll, collapseAll, exportToCSV, getCellPath, onCellUpdated, decodePathKey, setSearchText, searchStep, getSearchInfo } from './grid';
import { SAMPLE_JSON } from './sample-data';

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
      else cb.reject(new ErrorWithPosition(error, workerLastPayload));
    }
  };
}

// 错误类，携带输入文本，用于把原文档偏移换算成行列
 class ErrorWithPosition extends Error {
   line?: number;
   col?: number;
  
  constructor(message: string, docText?: string) {
    super(message);
    this.name = 'ErrorWithPosition';

    const match = message.match(/position (\d+)/);
    if (!match) return;
    const pos = Number(match[1]);
    // 偏移是相对原始输入文档的，必须基于输入文本计算行列
    const base = docText !== undefined ? docText.substring(0, pos) : '';
    const lines = base.split('\n');
    this.line = lines.length;
    this.col = lines.length > 0 ? lines[lines.length - 1].length : 0;
  }
}

let workerLastPayload: string = '';

function workerRequest(type: string, payload: any): Promise<any> {
  // 记录最近一次请求的原始文本，错误回包时可换算行列（JSON 字符串载荷则记录其 jsonString）
  if (typeof payload === 'string') workerLastPayload = payload;
  else if (payload && typeof payload.jsonString === 'string') workerLastPayload = payload.jsonString;
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
          case 'updateCell': result = updateCell(payload); break;
          case 'locatePath': result = locatePath(payload); break;
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
            var charMatch = msg.match(/character\\s+(\\d+)/i);
            if (charMatch) pos = Number(charMatch[1]);
          } else if (msg.includes('position')) {
            var posMatch = msg.match(/position\\s+(\\d+)/i);
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
    function updateCell(p) {
      var t = performance.now();
      var data = p.data;
      var path = p.path;
      var value = p.value;

      // 深拷贝
      var cloned = JSON.parse(JSON.stringify(data));

      // 按路径更新
      var current = cloned;
      for (var i = 0; i < path.length - 1; i++) {
        var key = path[i];
        if (Array.isArray(current)) {
          current = current[Number(key)];
        } else {
          current = current[key];
        }
        if (current === null || current === undefined) {
          throw new Error('路径无效: ' + path.join('.'));
        }
      }

      var lastKey = path[path.length - 1];
      if (Array.isArray(current)) {
        current[Number(lastKey)] = value;
      } else {
        current[lastKey] = value;
      }

      var jsonString = JSON.stringify(cloned, null, 2);
      return {
        data: cloned,
        jsonString: jsonString,
        updateTime: performance.now() - t
      };
    }

    // 在 pretty JSON 文本中定位路径对应的 key/value 区间
    // payload: { jsonString, path: string[], target: 'key'|'value' }
    function locatePath(p) {
      var t = performance.now();
      var s = p.jsonString;
      var path = p.path || [];
      var target = p.target === 'key' ? 'key' : 'value';
      if (!s) throw new Error('空文档');

      function skipWs(i) {
        while (i < s.length) {
          var c = s.charAt(i);
          // 注意：Worker 代码在模板字符串中，\\n 才会变成源码里的 \n
          if (c === ' ' || c === '\\n' || c === '\\r' || c === '\\t') i++;
          else break;
        }
        return i;
      }

      function parseString(i) {
        if (s.charAt(i) !== '"') throw new Error('期望字符串 at ' + i);
        var start = i;
        i++;
        while (i < s.length) {
          var c = s.charAt(i);
          if (c === '\\\\') { i += 2; continue; }
          if (c === '"') return { from: start, to: i + 1, next: i + 1, raw: s.substring(start, i + 1) };
          i++;
        }
        throw new Error('未闭合字符串');
      }

      function skipValue(i) {
        i = skipWs(i);
        var c = s.charAt(i);
        if (c === '"') return parseString(i).next;
        if (c === '{') {
          i++;
          i = skipWs(i);
          if (s.charAt(i) === '}') return i + 1;
          while (i < s.length) {
            var k = parseString(i);
            i = skipWs(k.next);
            if (s.charAt(i) !== ':') throw new Error('期望冒号');
            i = skipValue(i + 1);
            i = skipWs(i);
            if (s.charAt(i) === ',') { i = skipWs(i + 1); continue; }
            if (s.charAt(i) === '}') return i + 1;
            throw new Error('对象结构错误');
          }
        }
        if (c === '[') {
          i++;
          i = skipWs(i);
          if (s.charAt(i) === ']') return i + 1;
          while (i < s.length) {
            i = skipValue(i);
            i = skipWs(i);
            if (s.charAt(i) === ',') { i = skipWs(i + 1); continue; }
            if (s.charAt(i) === ']') return i + 1;
            throw new Error('数组结构错误');
          }
        }
        // 字面量 null/true/false/number
        // 模板字符串内需写 \\d / \\. 才能落到 Worker 源码中的 \d / \.
        var m = s.substring(i).match(/^(null|true|false|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)/);
        if (m) return i + m[0].length;
        throw new Error('无法跳过值 at ' + i);
      }

      function valueRange(i) {
        i = skipWs(i);
        var start = i;
        var end = skipValue(i);
        return { from: start, to: end, next: end };
      }

      function findInObject(i, key) {
        i = skipWs(i);
        if (s.charAt(i) !== '{') throw new Error('期望对象');
        i++;
        i = skipWs(i);
        if (s.charAt(i) === '}') throw new Error('空对象无键: ' + key);
        while (i < s.length) {
          var ks = parseString(i);
          var keyText = JSON.parse(ks.raw);
          i = skipWs(ks.next);
          if (s.charAt(i) !== ':') throw new Error('期望冒号');
          i++;
          var valStart = skipWs(i);
          if (keyText === key) {
            return { keyFrom: ks.from, keyTo: ks.to, valueFrom: valStart };
          }
          i = skipValue(valStart);
          i = skipWs(i);
          if (s.charAt(i) === ',') { i = skipWs(i + 1); continue; }
          if (s.charAt(i) === '}') throw new Error('未找到键: ' + key);
          throw new Error('对象遍历失败');
        }
        throw new Error('未找到键: ' + key);
      }

      function findInArray(i, index) {
        i = skipWs(i);
        if (s.charAt(i) !== '[') throw new Error('期望数组');
        i++;
        i = skipWs(i);
        var idx = 0;
        if (s.charAt(i) === ']') throw new Error('空数组');
        while (i < s.length) {
          var vr = valueRange(i);
          if (idx === index) {
            return { valueFrom: vr.from, valueTo: vr.to };
          }
          i = skipWs(vr.next);
          idx++;
          if (s.charAt(i) === ',') { i = skipWs(i + 1); continue; }
          if (s.charAt(i) === ']') throw new Error('数组下标越界: ' + index);
          throw new Error('数组遍历失败');
        }
        throw new Error('数组下标越界: ' + index);
      }

      // 根
      var pos = skipWs(0);
      var lastKeyRange = null;
      var lastValueRange = null;

      if (path.length === 0) {
        var root = valueRange(pos);
        return {
          from: root.from,
          to: root.to,
          locateTime: performance.now() - t
        };
      }

      for (var pi = 0; pi < path.length; pi++) {
        var seg = path[pi];
        pos = skipWs(pos);
        var ch = s.charAt(pos);
        if (ch === '{') {
          var fo = findInObject(pos, String(seg));
          lastKeyRange = { from: fo.keyFrom, to: fo.keyTo };
          // 值区间需要完整 skip；下一段从该值起点继续
          var fullVal = valueRange(fo.valueFrom);
          lastValueRange = { from: fullVal.from, to: fullVal.to };
          pos = fullVal.from;
        } else if (ch === '[') {
          var ai = Number(seg);
          if (isNaN(ai)) throw new Error('非法数组下标: ' + seg);
          var fa = findInArray(pos, ai);
          lastKeyRange = null;
          lastValueRange = { from: fa.valueFrom, to: fa.valueTo };
          pos = fa.valueFrom;
        } else {
          throw new Error('路径段无法匹配结构: ' + seg);
        }
      }

      var range;
      if (target === 'key' && lastKeyRange) range = lastKeyRange;
      else range = lastValueRange;
      if (!range) throw new Error('无法定位路径');

      return {
        from: range.from,
        to: range.to,
        locateTime: performance.now() - t
      };
    }
  `;
}

// ========== 编辑器 ==========
let inputEditor: EditorView;
let navDecorations: DecorationSet = Decoration.none;
let errorClearTimer: number | undefined;
let errorDecorations: DecorationSet = Decoration.none;
let navClearTimer: number | undefined;
/** Grid 导航请求世代号：丢弃乱序/过期的 locatePath 响应 */
let navGen = 0;

/** 原站 Ace 主题色（class 方式，随暗色主题切换）：
 *  亮色：键 #234A97 / 字符串 #0B6125 / 数字·常量 #811F24 / 标点·括号 #080808
 *  暗色（idle-fingers）：键·标点 #FFF / 字符串 #A5C261 / 数字·常量 #6C99BB */
const originalSiteHighlight = HighlightStyle.define([
  { tag: t.propertyName, class: 'tok-key' },
  { tag: t.string, class: 'tok-string' },
  { tag: t.number, class: 'tok-number' },
  { tag: t.bool, class: 'tok-number' },
  { tag: t.null, class: 'tok-number' },
  { tag: t.punctuation, class: 'tok-punct' },
  { tag: t.bracket, class: 'tok-punct' },
  { tag: t.separator, class: 'tok-punct' },
]);

function initEditors() {
  // ponytail: nav highlight 用 ViewPlugin 管理，避免手动清理
  const navHighlight = ViewPlugin.define(() => ({
    decorations: navDecorations,
    update(update: ViewUpdate) {
      if (update.docChanged) {
        // 文档变化后清除导航高亮
        navDecorations = Decoration.none;
      }
      // 始终同步模块级 decorations（含外部 applyNavHighlight 更新）
      this.decorations = navDecorations;
    }
  }), { decorations: v => v.decorations });

  const errorHighlight = ViewPlugin.define(() => ({
    decorations: errorDecorations,
    update(update: ViewUpdate) {
      if (update.docChanged) {
        errorDecorations = Decoration.none;
      }
      this.decorations = errorDecorations;
    }
  }), { decorations: v => v.decorations });

  inputEditor = new EditorView({
    doc: JSON.stringify({"name":"JSON Grid 对比测试","version":"2.0","metadata":{"author":{"name":"Test User","email":"test@example.com","role":"developer","skills":["JavaScript","TypeScript","CSS","React"]},"stats":{"totalObjects":15,"maxDepth":5,"arrayCount":8}},"users":[{"id":1,"username":"alice","profile":{"firstName":"Alice","lastName":"Johnson","age":28,"address":{"street":"123 Main St","city":"New York","state":"NY","zipCode":"10001","coordinates":{"latitude":40.7128,"longitude":-74.006}},"contact":{"email":"alice@example.com","phone":"+1-555-0101","social":{"twitter":"@alice","github":"alice-dev","linkedin":"alice-johnson"}}},"preferences":{"theme":"dark","language":"zh-CN","notifications":{"email":true,"push":false,"sms":false}},"orders":[{"orderId":"ORD-001","date":"2026-07-01","items":[{"productId":"PROD-101","name":"Wireless Mouse","quantity":2,"price":29.99,"specs":{"color":"Black","connectivity":"Bluetooth 5.0","battery":"Rechargeable","dimensions":{"width":6.5,"height":2.5,"depth":4.0,"unit":"cm"}}},{"productId":"PROD-102","name":"Mechanical Keyboard","quantity":1,"price":89.99,"specs":{"switches":"Cherry MX Blue","layout":"Full-size","backlight":"RGB","keycaps":"PBT Double-shot"}}],"shipping":{"method":"Express","cost":15.99,"tracking":"TRK123456789","estimatedDelivery":"2026-07-03"},"payment":{"method":"Credit Card","last4":"4242","status":"completed"}}]},{"id":2,"username":"bob","profile":{"firstName":"Bob","lastName":"Smith","age":35,"address":{"street":"456 Oak Ave","city":"San Francisco","state":"CA","zipCode":"94102","coordinates":{"latitude":37.7749,"longitude":-122.4194}},"contact":{"email":"bob@example.com","phone":"+1-555-0102"}},"preferences":{"theme":"light","language":"en-US","notifications":{"email":true,"push":true,"sms":true}},"orders":[]}],"settings":{"general":{"siteName":"JSON Grid Test","maintenance":false,"debug":true},"features":{"gridView":true,"treeView":true,"search":true,"filter":{"enabled":true,"maxResults":100,"cacheResults":true}},"limits":{"maxFileSize":"10MB","maxRows":10000,"timeout":30000}}}, null, 2),
    extensions: [
      basicSetup,
      json(),
      syntaxHighlighting(originalSiteHighlight),
      navHighlight,
      errorHighlight,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          // 文档变更使进行中的导航失效，并清高亮
          navGen++;
          if (navClearTimer !== undefined) {
            window.clearTimeout(navClearTimer);
            navClearTimer = undefined;
          }
          navDecorations = Decoration.none;
        }
        // 编辑时只更新字数统计，不做任何自动格式化 / 自动同步：
        // 自动格式化会在按回车时重排全文、吃掉手动输入的空格，
        // 且会连带触发 renderGridView 让 GRID 跟着跳。
        // GRID 的刷新改为手动：点 #btn-render-grid。
        if (update.docChanged && !autoFormatting) {
          updateStats();
        }
      })
    ],
    parent: document.getElementById('editor-container')!
  });
}

function updateStats() {
  const content = inputEditor.state.doc.toString();
  const el = document.getElementById('left-stats');
  if (el) el.textContent = `输入: ${content.length} 字符 | ${content.split('\n').length} 行`;
}

/**
 * autoFormatting：程序化改写编辑器内容时的重入标记。
 * 手动触发格式化/压缩/渲染等操作会改写全文，靠它避免与 docChanged 钩子互相干扰。
 * 注：已取消「编辑时自动格式化」，此标记仅服务于手动按钮与 GRID 回写。
 */
let autoFormatting = false;

/** 耗时显示：<0.01ms 时保留有效位，避免 0.00ms 假象 */
function fmtMs(ms: number): string {
  if (ms < 0.01) return '<0.01';
  return ms.toFixed(2);
}

function setStatus(msg: string, type: 'info' | 'success' | 'error' = 'info') {
  const el = document.getElementById('status-message');
  if (el) {
    el.textContent = msg;
    // 颜色统一：成功/普通都用默认灰，仅错误标红
    el.style.color = type === 'error' ? 'var(--error-color)' : 'var(--text-muted)';
  }
}



/**
 * 搜索面板复刻原站 Ace searchbox：
 * - 三行结构：表单行（Search for + ‹ › All）/ 替换行（Replace with + Replace + All，默认收起）
 *   / 选项行（+ 计数器靠左，.* Aa \b 靠右）
 * - 按钮顺序、文案、CSS 画箭头、悬停/选中态、无匹配红框全部对齐原站
 * - 关闭 × 绝对定位右上角；面板贴内容区右上角锚定、宽度收缩到自然宽（约 371px，同原站）
 */
let searchPanelObserver: MutationObserver | null = null;

function customizeSearchPanel() {
  const panel = document.querySelector('.cm-panel.cm-search') as HTMLElement | null;
  if (!panel) return;
  // 防重入：CM 每次打开都会重建面板 DOM，但同一次打开内可能多次调用
  if (panel.dataset.customized === '1') return;
  panel.dataset.customized = '1';

  const searchField = panel.querySelector('input[name=search]') as HTMLInputElement | null;
  const prevBtn = panel.querySelector('button[name=prev]') as HTMLElement | null;
  const nextBtn = panel.querySelector('button[name=next]') as HTMLElement | null;
  const allBtn = panel.querySelector('button[name=select]') as HTMLElement | null;
  const replaceField = panel.querySelector('input[name=replace]') as HTMLElement | null;
  const replaceBtn = panel.querySelector('button[name=replace]') as HTMLElement | null;
  const replaceAllBtn = panel.querySelector('button[name=replaceAll]') as HTMLElement | null;
  const closeBtn = panel.querySelector('button[name=close]') as HTMLElement | null;

  // CM 面板是扁平 DOM，重组为原站的三行结构。
  // CM 的按钮监听器直接绑在节点上（onclick/onchange），在面板内搬移是安全的；
  // Esc 等按键走面板容器的事件委托，同样不受影响。
  const formRow = document.createElement('div');
  formRow.className = 'jg-search-form';
  if (searchField && prevBtn && nextBtn && allBtn) {
    // 原站顺序：输入框、‹ 上一个、› 下一个、All
    formRow.appendChild(searchField);
    formRow.appendChild(prevBtn);
    formRow.appendChild(nextBtn);
    formRow.appendChild(allBtn);
    panel.insertBefore(formRow, panel.firstChild);
  }

  const replaceRow = document.createElement('div');
  replaceRow.className = 'jg-replace-form';
  if (replaceField && replaceBtn && replaceAllBtn) {
    replaceRow.appendChild(replaceField);
    replaceRow.appendChild(replaceBtn);
    replaceRow.appendChild(replaceAllBtn);
    replaceRow.style.display = 'none'; // 替换行默认收起，点 + 展开
  }
  panel.insertBefore(replaceRow, formRow.nextSibling);

  // CM 原生 label（case/re/word 复选框）与 br 隐藏，选项行改用按钮驱动
  const labels = [...panel.querySelectorAll('label')] as HTMLElement[];
  labels.forEach(l => { l.style.display = 'none'; });
  panel.querySelectorAll('br').forEach(br => { (br as HTMLElement).style.display = 'none'; });

  // 文案与属性对齐原站
  if (searchField) searchField.setAttribute('placeholder', 'Search for');
  if (replaceField) replaceField.setAttribute('placeholder', 'Replace with');
  if (replaceBtn) replaceBtn.textContent = 'Replace';
  if (replaceAllBtn) replaceAllBtn.textContent = 'All';
  if (allBtn) { allBtn.textContent = 'All'; allBtn.setAttribute('title', 'Alt-Enter'); }
  // 导航箭头由 CSS ::after 绘制（原站画法），清空按钮文字
  if (prevBtn) { prevBtn.textContent = ''; prevBtn.setAttribute('aria-label', 'previous'); }
  if (nextBtn) { nextBtn.textContent = ''; nextBtn.setAttribute('aria-label', 'next'); }

  // 选项行：+ 展开替换 / 匹配计数 / .* 正则 / Aa 大小写 / \b 全词（原站顺序与标题）
  const optRow = document.createElement('div');
  optRow.className = 'jg-search-options';
  const plusBtn = document.createElement('button');
  plusBtn.type = 'button';
  plusBtn.className = 'jg-opt jg-opt-replace';
  plusBtn.textContent = '+';
  plusBtn.title = 'Toggle Replace mode';
  plusBtn.addEventListener('click', () => {
    const show = replaceRow.style.display === 'none';
    replaceRow.style.display = show ? '' : 'none';
  });
  optRow.appendChild(plusBtn);

  const counter = document.createElement('span');
  counter.className = 'jg-search-counter';
  counter.textContent = '0 of 0';
  optRow.appendChild(counter);

  const toggleSpecs: Array<{ name: string; text: string; title: string }> = [
    { name: 're', text: '.*', title: 'RegExp Search' },
    { name: 'case', text: 'Aa', title: 'CaseSensitive Search' },
    { name: 'word', text: '\\b', title: 'Whole Word Search' }
  ];
  for (const spec of toggleSpecs) {
    const label = labels.find(l => {
      const cb = l.querySelector('input[type=checkbox]') as HTMLInputElement | null;
      return cb !== null && cb.name === spec.name;
    });
    if (!label) continue;
    const cb = label.querySelector('input[type=checkbox]') as HTMLInputElement;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'jg-opt';
    btn.textContent = spec.text;
    btn.title = spec.title;
    if (cb.checked) btn.classList.add('jg-opt-checked');
    btn.addEventListener('click', () => {
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      btn.classList.toggle('jg-opt-checked', cb.checked);
    });
    optRow.appendChild(btn);
  }
  panel.appendChild(optRow);

  if (closeBtn) closeBtn.classList.add('jg-search-close');

  // 面板定位：贴 JSON 编辑器内容区右上角（顶部齐平、右缘齐平），宽度收缩到内容自然宽
  // （原站 ace_search.right 是 right:0 锚定 + shrink-to-fit，约 371px，不是通栏）。
  // CM 异步渲染面板，双 rAF 等 DOM 稳定后再量。
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const panels = panel.closest('.cm-panels') as HTMLElement | null;
    const editor = document.getElementById('editor-container');
    if (!panels || !editor) return;
    const er = editor.getBoundingClientRect();
    panels.style.position = 'fixed';
    panels.style.top = Math.round(er.top) + 'px';
    panels.style.width = 'max-content'; /* 容器是全宽 block，量宽会得到视口宽 */
    panels.style.bottom = 'auto'; /* CM 默认 bottom:0 会把容器拉伸到全高，面板被推到底部 */
    const pw = panel.getBoundingClientRect().width || 376;
    panels.style.left = Math.max(0, Math.round(er.right - pw)) + 'px';
    panels.style.zIndex = '99';
  }));

  // 计数器与无匹配红框：监听编辑器匹配高亮变化（节流，避免滚动重绘风暴）
  if (searchPanelObserver) searchPanelObserver.disconnect();
  let counterPending = false;
  const updateCounter = () => {
    const current = document.querySelector('.cm-panel.cm-search');
    if (!current) { searchPanelObserver!.disconnect(); searchPanelObserver = null; return; }
    const matches = Array.from(document.querySelectorAll('#editor-container .cm-searchMatch'));
    const sel = document.querySelector('#editor-container .cm-searchMatch-selected');
    let idx = sel ? matches.indexOf(sel) + 1 : 0;
    if (idx === 0 && matches.length > 0) idx = 1;
    const c = current.querySelector('.jg-search-counter');
    if (c) c.textContent = idx + ' of ' + matches.length;
    const form = current.querySelector('.jg-search-form');
    if (form) {
      const q = (current.querySelector('input[name=search]') as HTMLInputElement | null)?.value || '';
      form.classList.toggle('jg-nomatch', q.length > 0 && matches.length === 0);
    }
  };
  searchPanelObserver = new MutationObserver(() => {
    if (counterPending) return;
    counterPending = true;
    setTimeout(() => { counterPending = false; updateCounter(); }, 150);
  });
  // CM 渲染搜索高亮是新增装饰 span（childList）+ class 标记，两类都要监听
  searchPanelObserver.observe(document.getElementById('editor-container')!, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
}

// ========== 主题切换 ==========
function initTheme() {
  const saved = localStorage.getItem('jsongrid-theme');
  if (saved === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    setThemeIcon(true);
  }

  document.getElementById('btn-theme')?.addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (isDark) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('jsongrid-theme', 'light');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('jsongrid-theme', 'dark');
    }
    // 传切换后的状态：亮色显月亮、暗色显太阳（与原站一致）
    setThemeIcon(!isDark);
  });
}


/** 主题按钮图标：亮色显月亮（点击去暗色），暗色显太阳（点击回亮色） */
const MOON_PATH = 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z';
const SUN_PATH = 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0-13a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0V5a1 1 0 0 1 1-1zm0 14a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1zM4.2 5.6a1 1 0 0 1 1.4 0l1.4 1.4A1 1 0 1 1 5.6 8.4L4.2 7a1 1 0 0 1 0-1.4zm12.8 12.8a1 1 0 0 1 1.4 0l1.4 1.4a1 1 0 1 1-1.4 1.4l-1.4-1.4a1 1 0 0 1 0-1.4zM3 12a1 1 0 0 1 1-1h2a1 1 0 1 1 0 2H4a1 1 0 0 1-1-1zm14 0a1 1 0 0 1 1-1h2a1 1 0 1 1 0 2h-2a1 1 0 0 1-1-1zM5.6 15.6a1 1 0 0 1 0 1.4l-1.4 1.4a1 1 0 1 1-1.4-1.4l1.4-1.4a1 1 0 0 1 1.4 0zm12.8-12.8a1 1 0 0 1 0 1.4l-1.4 1.4a1 1 0 1 1-1.4-1.4l1.4-1.4a1 1 0 0 1 1.4 0z';

function setThemeIcon(isDark: boolean) {
  const icon = document.querySelector('#btn-theme .round-icon path');
  if (icon) icon.setAttribute('d', isDark ? SUN_PATH : MOON_PATH);
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
      updateStats();
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
        updateStats();
        setStatus('已从远程 URL 加载', 'success');
      })
      .catch(err => setStatus('URL 加载失败: ' + err.message, 'error'));
  }
}

// ========== 视图切换与布局 ==========
/** 布局三态：split = 左右同显；json-full = 左侧 JSON 全屏；grid-full = 右侧 GRID 全屏 */
type LayoutMode = 'split' | 'json-full' | 'grid-full';
let layoutMode: LayoutMode = 'split';

function applyLayout() {
  const stage = document.querySelector('.editor-stage') as HTMLElement;
  const panelJson = document.getElementById('panel-json')!;
  const panelGrid = document.getElementById('panel-grid')!;
  const splitHandle = document.getElementById('split-handle')!;
  const gridStage = document.getElementById('grid-stage')!;
  const renderBtn = document.getElementById('btn-render-grid')!;

  stage.classList.toggle('split', layoutMode === 'split');
  stage.classList.toggle('json-full', layoutMode === 'json-full');
  stage.classList.toggle('grid-full', layoutMode === 'grid-full');

  const label = document.getElementById('sep-label')!;
  const leftBtn = splitHandle.querySelector('[data-side="left"]') as HTMLButtonElement;
  const rightBtn = splitHandle.querySelector('[data-side="right"]') as HTMLButtonElement;
  const leftIcon = leftBtn.querySelector('.sep-icon')!;
  const rightIcon = rightBtn.querySelector('.sep-icon')!;

  splitHandle.style.display = 'flex';
  panelJson.style.display = layoutMode === 'grid-full' ? 'none' : 'flex';
  panelGrid.style.display = layoutMode === 'json-full' ? 'none' : 'flex';
  gridStage.style.display = layoutMode === 'json-full' ? 'none' : 'flex';

  if (layoutMode === 'split') {
    // 中间 ▶ 渲染；底部 ‹ GRID 全屏、› JSON 全屏
    label.hidden = true;
    renderBtn.style.display = 'flex';
    leftIcon.textContent = '‹';
    rightIcon.textContent = '›';
    leftBtn.title = 'GRID 全屏';
    rightBtn.title = 'JSON 全屏';
    renderGridView();
  } else if (layoutMode === 'grid-full') {
    // 中间竖排 JSON；底部 › 回到分屏、» 切到 JSON 全屏
    label.hidden = false;
    label.textContent = 'JSON';
    renderBtn.style.display = 'none';
    leftIcon.textContent = '›';
    rightIcon.textContent = '»';
    leftBtn.title = '回到左右分屏';
    rightBtn.title = 'JSON 全屏';
    renderGridView();
  } else {
    // 中间竖排 GRID；底部 « 切到 GRID 全屏、‹ 回到分屏
    label.hidden = false;
    label.textContent = 'GRID';
    renderBtn.style.display = 'none';
    leftIcon.textContent = '«';
    rightIcon.textContent = '‹';
    leftBtn.title = 'GRID 全屏';
    rightBtn.title = '回到左右分屏';
  }

  localStorage.setItem('jsongrid-layout', layoutMode);
}

function setLayout(mode: LayoutMode) {
  layoutMode = mode;
  applyLayout();
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
      updateStats();
      autoFormatting = false;
      setStatus(`格式化完成 (${fmtMs(result.processTime)}ms)`, 'success');
    } catch (err: any) {
      setStatus(`格式化失败: ${err.message}`, 'error');
      if (err.line) highlightError(err.line, err.col || 0);
    }
  });

  document.getElementById('btn-minify')?.addEventListener('click', async () => {
    const input = inputEditor.state.doc.toString();
    if (!input.trim()) { setStatus('请输入 JSON', 'error'); return; }
    try {
      setStatus('压缩中...');
      const result = await workerRequest('compress', input);
      autoFormatting = true;
      inputEditor.dispatch({ changes: { from: 0, to: inputEditor.state.doc.length, insert: result.result } });
      updateStats();
      autoFormatting = false;
      setStatus(`压缩完成，节省 ${(result.saved / 1024).toFixed(2)} KB`, 'success');
    } catch (err: any) {
      setStatus(`压缩失败: ${err.message}`, 'error');
      if (err.line) highlightError(err.line, err.col || 0);
    }
  });

  // Sample：加载原站样例并格式化
  document.getElementById('btn-sample')?.addEventListener('click', async () => {
    try {
      setStatus('加载样例...');
      const result = await workerRequest('format', SAMPLE_JSON);
      autoFormatting = true;
      inputEditor.dispatch({ changes: { from: 0, to: inputEditor.state.doc.length, insert: result.result } });
      updateStats();
      autoFormatting = false;
      setStatus(`样例已加载 (${(result.processTime || 0).toFixed(3)}ms)`, 'success');
      if (layoutMode !== 'json-full') renderGridView();
    } catch (err: any) {
      setStatus(`样例加载失败: ${err.message}`, 'error');
    }
  });

  // Validate：校验 JSON，成功/失败都给出位置反馈
  document.getElementById('btn-validate')?.addEventListener('click', async () => {
    const input = inputEditor.state.doc.toString();
    if (!input.trim()) { setStatus('请输入 JSON', 'error'); return; }
    try {
      setStatus('校验中...');
      const result = await workerRequest('validate', input);
      if (result.valid) {
        setStatus(`JSON 有效 (${fmtMs(result.validateTime)}ms)`, 'success');
      } else {
        setStatus(`JSON 无效: ${result.error}（第 ${result.line} 行，第 ${(result.col || 0) + 1} 列）`, 'error');
        highlightError(result.line, result.col || 0);
      }
    } catch (err: any) {
      setStatus(`校验失败: ${err.message}`, 'error');
    }
  });

  document.getElementById('btn-clear')?.addEventListener('click', () => {
    inputEditor.dispatch({ changes: { from: 0, to: inputEditor.state.doc.length, insert: '' } });
    inputEditor.dispatch({});
    updateStats();
    // 联动清空右侧 GRID
    const gridView = document.getElementById('grid-view');
    if (gridView) gridView.innerHTML = '';
    setStatus('已清空');
  });

  // 搜索：打开 CodeMirror 内置搜索面板（原站 Search 按钮同款行为）
  document.getElementById('btn-search')?.addEventListener('click', () => {
    openSearchPanel(inputEditor);
    customizeSearchPanel();
  });

   // 分隔条底部两个钮的含义随布局变，见 applyLayout 里的 title
   document.querySelector('#split-handle [data-side="left"]')?.addEventListener('click', () => {
     if (layoutMode === 'split') setLayout('grid-full');
     else if (layoutMode === 'grid-full') setLayout('split');
     else setLayout('grid-full');
   });
   document.querySelector('#split-handle [data-side="right"]')?.addEventListener('click', () => {
     if (layoutMode === 'split') setLayout('json-full');
     else if (layoutMode === 'grid-full') setLayout('json-full');
     else setLayout('split');
   });
   document.getElementById('btn-render-grid')?.addEventListener('click', async () => {
     const input = inputEditor.state.doc.toString();
     if (!input.trim()) { setStatus('请输入 JSON', 'error'); return; }
     try {
       setStatus('渲染中...');
       const result = await workerRequest('format', input);
       if (result.result !== input) {
         autoFormatting = true;
         inputEditor.dispatch({ changes: { from: 0, to: inputEditor.state.doc.length, insert: result.result } });
         updateStats();
         autoFormatting = false;
       }
       renderGridView();
       setStatus(`已渲染到 GRID (${fmtMs(result.processTime)}ms)`, 'success');
     } catch (err: any) {
       setStatus(`渲染失败: ${err.message}`, 'error');
       if (err.line) highlightError(err.line, err.col || 0);
     }
   });

   // 布局切换按钮：三态循环 分屏 → GRID 全屏 → JSON 全屏
   document.getElementById('btn-layout')?.addEventListener('click', () => {
     const next: LayoutMode = layoutMode === 'split' ? 'grid-full' : layoutMode === 'grid-full' ? 'json-full' : 'split';
     setLayout(next);
     setStatus(next === 'split' ? '左右分屏' : next === 'grid-full' ? 'GRID 全屏' : 'JSON 全屏', 'info');
   });

   // Grid 视图：展开全部 / 折叠全部
   document.getElementById('grid-btn-expand-all')?.addEventListener('click', () => {
     expandAll();
   });
  document.getElementById('grid-btn-collapse-all')?.addEventListener('click', () => {
    collapseAll();
  });

  // Grid 视图：搜索（1:1 复刻原站 app-search-panel）
  // 原站时序实测：keyup 立即置 'Searching...' -> 1000ms 防抖 -> 再延迟 2000ms 才真正检索高亮
  const GS_DEBOUNCE_MS = 1000;
  const GS_DELAY_MS = 2000;
  // 原站 PrimeIcons 字体（primeicons.svg）的真实字形：pi-angle-left / pi-angle-right / pi-times
  const PI_ANGLE_LEFT = 'M645.785 123.096c-0.077 0-0.174 0-0.264 0-15.744 0-29.987 6.434-40.247 16.814l-267.57 267.57c-10.36 10.374-16.768 24.697-16.768 40.517s6.404 30.147 16.768 40.517v0l267.566 265.27c8.804 5.784 19.594 9.224 31.197 9.224 31.667 0 57.335-25.671 57.335-57.335 0-10.424-2.782-20.194-7.64-28.617l0.144 0.274-229.343-229.343 229.343-229.343c10.36-10.374 16.768-24.697 16.768-40.517s-6.404-30.147-16.768-40.517v0c-9.987-9.044-23.307-14.584-37.917-14.584-0.914 0-1.824 0.023-2.732 0.064l0.124-0.004z';
  const PI_ANGLE_RIGHT = 'M377.809 122.106c-16.204 0.566-30.605 7.836-40.589 19.11l-0.054 0.059c-10.396 10.404-16.822 24.776-16.822 40.643s6.424 30.235 16.822 40.645v0l230.044 230.044-230.044 230.044c-2.746 6.474-4.334 14.004-4.334 21.905 0 31.765 25.748 57.513 57.513 57.513 10.324 0 20.016-2.723 28.392-7.484l-0.286 0.149 268.384-268.384c10.396-10.406 16.822-24.773 16.822-40.643s-6.424-30.236-16.822-40.645v0l-268.384-263.783c-10.036-11.334-24.433-18.607-40.543-19.164l-0.096-0.006z';
  const PI_TIMES = 'M586.932 448l312.455 312.455c10.394 9.708 16.875 23.488 16.875 38.79 0 29.283-23.737 53.020-53.020 53.020-15.299 0-29.084-6.481-38.759-16.841l-0.027-0.029-312.455-312.455-312.455 312.455c-9.444 8.816-22.161 14.228-36.145 14.228-29.283 0-53.020-23.737-53.020-53.020 0-13.985 5.412-26.701 14.261-36.174l-0.027 0.029 312.455-312.455-312.455-312.455c-9.582-9.589-15.504-22.839-15.504-37.468s5.926-27.874 15.504-37.469v0c9.589-9.582 22.839-15.504 37.468-15.504s27.874 5.926 37.469 15.504v0l312.455 312.455 312.455-312.455c9.589-9.582 22.839-15.504 37.468-15.504s27.874 5.926 37.469 15.504v0c9.582 9.589 15.504 22.839 15.504 37.468s-5.926 27.874-15.504 37.469v0z';
  const piIcon = (d: string, size: number) =>
    '<svg class="jg-gs-icon" width="' + size + '" height="' + size + '" viewBox="0 0 1024 1024" aria-hidden="true"><path d="' + d + '"/></svg>';
  document.getElementById('grid-btn-search')?.addEventListener('click', () => {
    // 原站 openSearch() 只置 showSearch=true：面板已开时再点按钮不做任何事（不切换关闭）
    if (document.getElementById('grid-search-popover')) return;
    const host = document.getElementById('panel-grid')!;
    const searchBtn = document.getElementById('grid-btn-search')!;
    const pop = document.createElement('div');
    pop.id = 'grid-search-popover';
    pop.innerHTML =
      '<div class="jg-gs-main">' +
        '<input class="query-input" type="text">' +
        '<button type="button" class="jg-gs-btn jg-gs-nav" data-act="prev" title="Previous">' + piIcon(PI_ANGLE_LEFT, 14) + '</button>' +
        '<button type="button" class="jg-gs-btn jg-gs-nav" data-act="next" title="Next">' + piIcon(PI_ANGLE_RIGHT, 14) + '</button>' +
        '<button type="button" class="jg-gs-btn jg-gs-clear" data-act="clear" title="Clear">' + piIcon(PI_TIMES, 14) + '</button>' +
      '</div>' +
      '<div class="jg-gs-status" hidden>' +
        '<div class="jg-gs-count"></div>' +
        '<div class="jg-gs-limit">*<a href="#" class="limitations-link">Limitations</a></div>' +
      '</div>';
    host.appendChild(pop);

    // 原站 ngAfterViewInit：left = 触发按钮右缘 - 300px，top = 触发按钮下缘 + 5px
    const hostRect = host.getBoundingClientRect();
    const btnRect = searchBtn.getBoundingClientRect();
    pop.style.left = Math.round(btnRect.right - hostRect.left - 300) + 'px';
    pop.style.top = Math.round(btnRect.bottom - hostRect.top + 5) + 'px';

    const input = pop.querySelector('input') as HTMLInputElement;
    const statusRow = pop.querySelector('.jg-gs-status') as HTMLElement;
    const countEl = pop.querySelector('.jg-gs-count') as HTMLElement;
    let debounceTimer = 0;
    let delayTimer = 0;

    const setStatusText = (text: string) => {
      statusRow.hidden = !text;
      countEl.textContent = text;
    };

    const refreshStatus = () => {
      const info = getSearchInfo();
      // 检索尚未完成（防抖/延迟窗口内 searchState 为空）：保留 'Searching...'，
      // 原站此时 searchElements 为空，prev/next 不动，状态行不会凭空消失
      if (!info.active && !statusRow.hidden) return;
      if (!info.active || !info.query) { setStatusText(''); return; }
      if (info.total === 0) { setStatusText('Not Found'); return; }
      setStatusText(info.current + ' of ' + (info.truncated ? info.limit + '+' : info.total));
    };

    // *Limitations：原站 PrimeNG 模态框（header "Search Limitations"，宽 50vw）
    let dialog: HTMLElement | null = null;
    const closeLimitations = () => {
      if (!dialog) return;
      dialog.remove();
      dialog = null;
    };
    const openLimitations = () => {
      if (dialog) return;
      dialog = document.createElement('div');
      dialog.className = 'jg-gs-dialog-mask';
      dialog.innerHTML =
        '<div class="jg-gs-dialog" role="dialog" aria-modal="true" aria-label="Search Limitations">' +
          '<div class="jg-gs-dialog-header"><span>Search Limitations</span>' +
          '<button type="button" class="jg-gs-dialog-close" title="Close">' + piIcon(PI_TIMES, 16) + '</button></div>' +
          '<div class="jg-gs-dialog-content"><div class="limitations-text">' +
          'Please note that the search applies only to the data currently displayed in the Grid. ' +
          "Hidden tables and data (due to paging) won't be included in the search results or count. " +
          "For a complete search and accurate count, please use the Json Editor's search function. " +
          '</div></div>' +
        '</div>';
      dialog.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;
        if (t === dialog || t.closest('.jg-gs-dialog-close')) closeLimitations();
      });
      document.body.appendChild(dialog);
    };

    // ✕ Clear：原站 clearSearchHighlights() + closeSearch 事件 —— 面板只有关闭按钮能关
    const closePanel = () => {
      clearTimeout(debounceTimer);
      clearTimeout(delayTimer);
      window.removeEventListener('grid-search-changed', refreshStatus);
      closeLimitations();
      pop.remove();
      setSearchText('');
      setStatus('就绪');
    };

    input.addEventListener('keyup', () => {
      setStatusText(input.value ? 'Searching...' : '');
      clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        setSearchText(''); // 原站 clearSearchHighlights()
        if (!input.value) return;
        clearTimeout(delayTimer);
        delayTimer = window.setTimeout(() => {
          setSearchText(input.value);
          refreshStatus();
        }, GS_DELAY_MS);
      }, GS_DEBOUNCE_MS);
    });

    pop.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button.jg-gs-btn') as HTMLElement | null;
      if (!btn) return;
      const act = btn.dataset.act;
      // 原站 prev/next 首末位不环绕，且按钮不做禁用态
      if (act === 'prev') { searchStep(-1); refreshStatus(); }
      else if (act === 'next') { searchStep(1); refreshStatus(); }
      else if (act === 'clear') closePanel();
    });
    pop.querySelector('.limitations-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      openLimitations();
    });
    // 编辑单元格 / 排序 / 新数据渲染会改变匹配集，这里同步面板计数
    window.addEventListener('grid-search-changed', refreshStatus);
    input.focus();
  });

  // Grid 视图：导出 CSV（行号列 ⋮ 菜单暂未做，暂留键盘入口）
  document.getElementById('grid-btn-export-csv')?.addEventListener('click', () => {
    exportToCSV();
    setStatus('CSV 已导出', 'success');
  });

  // Grid 嵌套表内值编辑：按完整路径更新
  window.addEventListener('grid-nested-edit', async (e: any) => {
    const { pathKey, newValue, oldValue } = e.detail as { pathKey: string; newValue: string; oldValue: unknown };
    const segments = decodePathKey(pathKey);
    if (!segments.length) return;
    // 类型保真：按原值类型解析，避免数字/布尔被写字符串
    let parsedValue: unknown = newValue;
    if (typeof oldValue === 'number') {
      const n = Number(newValue);
      if (isNaN(n)) { setStatus('数字格式无效，未更新', 'error'); return; }
      parsedValue = n;
    } else if (typeof oldValue === 'boolean') {
      const lower = newValue.toLowerCase();
      if (lower !== 'true' && lower !== 'false') { setStatus('布尔值需为 true/false，未更新', 'error'); return; }
      parsedValue = lower === 'true';
    } else if (oldValue === null) {
      parsedValue = newValue === 'null' ? null : newValue;
    }
    try {
      setStatus('更新中...');
      const input = inputEditor.state.doc.toString();
      const parseResult = await workerRequest('parse', input);
      const updateResult = await workerRequest('updateCell', {
        data: parseResult.data,
        path: segments,
        value: parsedValue
      });
      autoFormatting = true;
      inputEditor.dispatch({ changes: { from: 0, to: inputEditor.state.doc.length, insert: updateResult.jsonString } });
      updateStats();
      autoFormatting = false;
      renderGridView();
      setStatus(`已更新 (${fmtMs(updateResult.updateTime)}ms)`, 'success');
    } catch (err: any) {
      setStatus(`更新失败: ${err.message}`, 'error');
    }
  });

  // Grid 视图：单元格编辑
  window.addEventListener('grid-cell-edit', async (e: any) => {
    const { rowIdx, colIdx, newValue } = e.detail;
    const path = getCellPath(rowIdx, colIdx);
    if (!path) return;

    try {
      setStatus('更新中...');
      // 获取当前数据
      const input = inputEditor.state.doc.toString();
      const parseResult = await workerRequest('parse', input);
      // 更新单元格
      const updateResult = await workerRequest('updateCell', {
        data: parseResult.data,
        path: path,
        value: newValue
      });
      // 更新编辑器内容
      autoFormatting = true;
      inputEditor.dispatch({
        changes: { from: 0, to: inputEditor.state.doc.length, insert: updateResult.jsonString }
      });
      updateStats();
      autoFormatting = false;
      // 更新 Grid
      onCellUpdated(updateResult.data);
      setStatus(`已更新 (${fmtMs(updateResult.updateTime)}ms)`, 'success');
    } catch (err: any) {
      setStatus(`更新失败: ${err.message}`, 'error');
    }
  });
  // GridSync：右侧取消选中 → 左侧立即清除定位高亮
  window.addEventListener('grid-nav-clear', () => {
    clearNavHighlight();
  });

  // GridSync：右侧点击路径 → Worker 定位 → 左侧滚动并高亮
  window.addEventListener('grid-navigate', async (e: Event) => {
    const detail = (e as CustomEvent).detail as {
      path?: string[];
      target?: 'key' | 'value';
    };
    // path 可为 ['']（顶层空键）；仅缺省或非数组时拒绝
    if (!Array.isArray(detail.path)) return;
    const gen = ++navGen;
    // 起飞时立刻作废旧高亮，避免竞态下残留上一次导航标记
    if (navClearTimer !== undefined) {
      window.clearTimeout(navClearTimer);
      navClearTimer = undefined;
    }
    navDecorations = Decoration.none;
    inputEditor.dispatch({});
    try {
      const jsonString = inputEditor.state.doc.toString();
      const result = await workerRequest('locatePath', {
        jsonString,
        path: detail.path,
        target: detail.target || 'value'
      });
      // 乱序/文档已变：丢弃过期响应
      if (gen !== navGen) return;
      applyNavHighlight(result.from, result.to);
      setStatus(
        '已定位 ' + detail.path.join('.') + ' (' + result.locateTime.toFixed(1) + 'ms)',
        'success'
      );
    } catch (err: any) {
      if (gen !== navGen) return;
      setStatus('定位失败: ' + (err.message || String(err)), 'error');
    }
  });
  }

function applyNavHighlight(from: number, to: number) {
  if (from == null || to == null || from < 0 || to < from) return;
  const docLen = inputEditor.state.doc.length;
  const f = Math.max(0, Math.min(from, docLen));
  const t = Math.max(f, Math.min(to, docLen));
  const mark = Decoration.mark({ class: 'cm-nav-match' });
  navDecorations = Decoration.set([mark.range(f, t)]);
  // 单次 dispatch：selection/scroll 会触发 ViewPlugin.update，其始终同步模块级 navDecorations
  inputEditor.dispatch({
    selection: { anchor: f, head: t },
    effects: EditorView.scrollIntoView(f, { y: 'center' })
  });

  if (navClearTimer !== undefined) window.clearTimeout(navClearTimer);
  navClearTimer = window.setTimeout(() => {
    navDecorations = Decoration.none;
    inputEditor.dispatch({});
  }, 2500);
}

/** 右侧取消选中：立即清掉左侧的定位高亮，不等它 2.5s 超时 */
function clearNavHighlight(): void {
  if (navClearTimer !== undefined) {
    window.clearTimeout(navClearTimer);
    navClearTimer = undefined;
  }
  navDecorations = Decoration.none;
  // applyNavHighlight 同时做了两件事：挂 cm-nav-match 装饰 + 设编辑器选区。
  // 只清装饰会留下一个深蓝选区色块，必须把选区塔回光标位置。
  const head = inputEditor.state.selection.main.head;
  inputEditor.dispatch({ selection: { anchor: head } });
}

// ========== 初始化 ==========
function init() {
  initWorker();
  initEditors();
  initTheme();
  setupEventListeners();
   updateStats();
  updateStats();
  setStatus('就绪');
  // 恢复上次的布局（默认：左右分屏）
  const savedLayout = localStorage.getItem('jsongrid-layout') as LayoutMode | null;
  layoutMode = savedLayout === 'json-full' || savedLayout === 'grid-full' ? savedLayout : 'split';
  applyLayout();
   // 分栏拖拽
   initSplitDrag();
   // URL 参数最后处理（可能覆盖编辑器内容）
   initURLParams();
}

/** 分栏拖拽：拖 #split-handle 调整左右比例（20%-80%） */
function initSplitDrag() {
  const handle = document.getElementById('split-handle');
  const stage = document.querySelector('.editor-stage') as HTMLElement;
  const panelJson = document.getElementById('panel-json');
  if (!handle || !stage || !panelJson) return;
  const savedRatio = parseFloat(localStorage.getItem('jsongrid-ratio') || '33.33');
  const panel = panelJson as HTMLElement;
  panel.style.flexBasis = Math.max(20, Math.min(80, savedRatio)) + '%';

  let dragging = false;
  handle.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('.separator-button')) return;
    e.preventDefault();
    dragging = true;
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', stopDrag);
  });
  function onDrag(e: MouseEvent) {
    if (!dragging) return;
    const rect = stage.getBoundingClientRect();
    let pct = ((e.clientX - rect.left) / rect.width) * 100;
    pct = Math.max(20, Math.min(80, pct));
    panel.style.flexBasis = pct + '%';
  }
  function stopDrag() {
    dragging = false;
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', stopDrag);
    const pct = parseFloat(panel.style.flexBasis) || 33.33;
    localStorage.setItem('jsongrid-ratio', String(pct));
  }
}

// ========== 错误高亮 ==========
function highlightError(line: number, col: number) {
  const doc = inputEditor.state.doc;
  const lineNo = Math.max(1, Math.min(line, doc.lines));
  const lineInfo = doc.line(lineNo);
  let from = lineInfo.from + (col || 0);
  from = Math.max(lineInfo.from, Math.min(from, lineInfo.to));
  let to = Math.min(from + 60, lineInfo.to);
  if (to <= from) {
    // 空行或 EOF：改标前一行最后一个真实字符（含换行符的 mark 会被 CodeMirror 拆成空段而丢弃）
    if (lineNo > 1) {
      const prev = doc.line(lineNo - 1);
      from = Math.max(prev.from, prev.to - 1);
      to = prev.to;
    } else {
      from = lineInfo.from;
      to = Math.min(lineInfo.to, from + 1);
    }
  }
  if (to <= from) return;
  const mark = Decoration.mark({ class: 'cm-error-line' });
  errorDecorations = Decoration.set([mark.range(from, to)]);
  inputEditor.dispatch({
    effects: EditorView.scrollIntoView(from, { y: 'center' })
  });
  if (errorClearTimer !== undefined) window.clearTimeout(errorClearTimer);
  errorClearTimer = window.setTimeout(() => {
    errorDecorations = Decoration.none;
    inputEditor.dispatch({});
  }, 5000);
}

init();
