import './style.css';
import { EditorView, basicSetup } from 'codemirror';
import { openSearchPanel } from '@codemirror/search';
import { Decoration, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { json } from '@codemirror/lang-json';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { renderVirtualGrid, expandAll, collapseAll, exportToCSV, setFilterText, getFilteredCount, getTotalCount, getCellPath, onCellUpdated, decodePathKey } from './grid';
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

  let autoFormatTimer: number;

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
        if (update.docChanged && !autoFormatting) {
          updateStats();
          // debounce 500ms 自动格式化
          clearTimeout(autoFormatTimer);
          autoFormatTimer = window.setTimeout(() => {
            autoFormat();
          }, 500);
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
      if (layoutMode !== 'json-full') renderGridView();
      return;
    }
    autoFormatting = true;
    inputEditor.dispatch({ changes: { from: 0, to: inputEditor.state.doc.length, insert: formatted } });
    updateStats();
    autoFormatting = false;
    if (layoutMode !== 'json-full') renderGridView();
  } catch {
    // 无效 JSON，不更新
  }
}

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

  if (layoutMode === 'split') {
    panelJson.style.display = 'flex';
    panelGrid.style.display = 'flex';
    splitHandle.style.display = 'flex';
    renderBtn.style.display = 'flex';
    gridStage.style.display = 'flex';
    renderGridView();
  } else {
    // 全屏态：隐藏另一侧；分隔条只留底部返回钮，▶ 隐藏
    splitHandle.style.display = 'flex';
    renderBtn.style.display = 'none';
    const jsonFull = layoutMode === 'json-full';
    panelJson.style.display = jsonFull ? 'flex' : 'none';
    panelGrid.style.display = jsonFull ? 'none' : 'flex';
    gridStage.style.display = jsonFull ? 'none' : 'flex';
    if (!jsonFull) renderGridView();
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
  });

   // 分隔条：‹ 右侧全屏 / › 左侧全屏；▶ 把左侧 JSON 格式化渲染到右侧 GRID
   document.querySelector('#split-handle [data-side="left"]')?.addEventListener('click', () => {
     setLayout(layoutMode === 'grid-full' ? 'split' : 'grid-full');
   });
   document.querySelector('#split-handle [data-side="right"]')?.addEventListener('click', () => {
     setLayout(layoutMode === 'json-full' ? 'split' : 'json-full');
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

  // Grid 视图：过滤（Advanced Filter 弹出输入框）
  let filterTimer: number;
  document.getElementById('grid-btn-filter')?.addEventListener('click', () => {
    const existing = document.getElementById('grid-filter-popover');
    if (existing) { existing.remove(); return; }
    const pop = document.createElement('div');
    pop.id = 'grid-filter-popover';
    pop.innerHTML = '<input id="grid-filter-input" type="text" class="grid-filter-input" placeholder="输入关键词过滤行...">';
    document.getElementById('panel-grid')!.appendChild(pop);
    const input = pop.querySelector('input')!;
    input.focus();
    input.addEventListener('input', (e) => {
      clearTimeout(filterTimer);
      const query = (e.target as HTMLInputElement).value;
      filterTimer = window.setTimeout(() => {
        setFilterText(query);
        const total = getTotalCount();
        const filtered = getFilteredCount();
        if (query) {
          setStatus(`过滤: ${filtered} / ${total} 行`, 'info');
        } else {
          setStatus('就绪');
        }
      }, 200);
    });
  });

  // Grid 视图：搜索（同样打开编辑器搜索面板）
  document.getElementById('grid-btn-search')?.addEventListener('click', () => {
    openSearchPanel(inputEditor);
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
