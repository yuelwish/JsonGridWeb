// 紧凑格式化回归验证：新实现（从 src/main.ts 抽取 worker 源码）vs 旧实现参照。
// 旧实现保留在本文件底部作为输出基准——它已随原版上线，输出格式视为规范。
// 用法：node scripts/verify-compact.mjs   （全绿退出码 0，任何不一致非 0）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// —— 从 src/main.ts 抽取 worker 模板字符串并在沙箱里实例化 ——
// 依赖两个项目不变量：getWorkerCode 模板是纯字面量（内禁 backtick 与 ${ 插值），
// 且文件内首个 "`;" 即模板结尾。破坏任一条这里会响亮抛错，不会静默假绿。
const mainTs = readFileSync(join(ROOT, 'src/main.ts'), 'utf8');
const startMarker = 'function getWorkerCode(): string {';
const start = mainTs.indexOf('return `', mainTs.indexOf(startMarker));
const openTick = start + 'return '.length;
const closeTick = mainTs.indexOf('`;', openTick);
if (start < 0 || closeTick < 0) throw new Error('未找到 getWorkerCode 模板字符串');
const workerCode = (0, eval)('`' + mainTs.slice(openTick + 1, closeTick) + '`');

const shim = { onmessage: null, postMessage() {} };
const worker = new Function('self', workerCode + '\n;return { formatJSON: formatJSON, COMPACT_MAX_DEPTH: COMPACT_MAX_DEPTH, COMPACT_COST_BUDGET: COMPACT_COST_BUDGET };')(shim);

// —— 参照：旧版紧凑实现（上线版本结构，逐字保留） + 显示列宽修正 ——
// 基准说明：2026-10-03 起列宽语义从 UTF-16 码元改为显示列（CJK/全角/emoji 2 列、
// 组合字符 0 列），这是有意的输出变更；参照实现同步改用 displayWidth，
// 两遍式新实现必须与它逐字节一致。
var COMPACT_WIDTH = 100;
function repeatSpaces(n) { var s = ''; for (var i = 0; i < n; i++) s += '  '; return s; }
function isWideChar(code) {
  return (code >= 0x1100 && code <= 0x115F) || (code >= 0x2E80 && code <= 0x303E)
    || (code >= 0x3041 && code <= 0x33FF) || (code >= 0x3400 && code <= 0x4DBF)
    || (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0xA000 && code <= 0xA4CF)
    || (code >= 0xAC00 && code <= 0xD7A3) || (code >= 0xF900 && code <= 0xFAFF)
    || (code >= 0xFE10 && code <= 0xFE19) || (code >= 0xFE30 && code <= 0xFE6F)
    || (code >= 0xFF00 && code <= 0xFF60) || (code >= 0xFFE0 && code <= 0xFFE6)
    || (code >= 0x1F300 && code <= 0x1FAFF) || (code >= 0x20000 && code <= 0x3FFFD);
}
function isZeroWidthChar(code) {
  return (code >= 0x0300 && code <= 0x036F) || (code >= 0x200B && code <= 0x200F)
    || (code >= 0xFE00 && code <= 0xFE0F);
}
function displayWidth(s) {
  var n = s.length, i = 0;
  while (i < n && s.charCodeAt(i) <= 0x7F) i++;
  if (i >= n) return n;
  var w = i;
  while (i < n) {
    var c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < n) { w += 2; i += 2; continue; }
    i++;
    w += isWideChar(c) ? 2 : isZeroWidthChar(c) ? 0 : 1;
  }
  return w;
}
function compactValue(v, indent, col) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  var isArr = Array.isArray(v);
  var keys = isArr ? null : Object.keys(v);
  var n = isArr ? v.length : keys.length;
  if (n === 0) return isArr ? '[]' : '{}';
  var items = [];
  var i, k, keyText;
  for (i = 0; i < n; i++) {
    k = isArr ? null : keys[i];
    keyText = k === null ? '' : JSON.stringify(k) + ': ';
    items.push({ keyText: keyText, text: compactValue(isArr ? v[i] : v[k], indent + 1, (indent + 1) * 2 + displayWidth(keyText)) });
  }
  var flat = isArr ? '[' : '{';
  for (i = 0; i < items.length; i++) { if (i > 0) flat += ', '; flat += items[i].keyText + items[i].text; }
  flat += isArr ? ']' : '}';
  // 折叠判定改用显示列宽（这是相对上线版的有意变更）
  if (flat.indexOf('\n') < 0 && col + displayWidth(flat) <= COMPACT_WIDTH) return flat;
  var pad = repeatSpaces(indent + 1);
  var out = (isArr ? '[' : '{') + '\n';
  for (i = 0; i < items.length; i++) { out += pad + items[i].keyText + items[i].text; if (i < items.length - 1) out += ','; out += '\n'; }
  out += repeatSpaces(indent) + (isArr ? ']' : '}');
  return out;
}
function formatJSONRef(text, compact) {
  var d = JSON.parse(text);
  if (!compact) return { result: JSON.stringify(d, null, 2), compact: false };
  return { result: compactValue(d, 0, 0), compact: true };
}

// —— 检查工具 ——
let failures = 0, checks = 0;
function fail(msg) { failures++; console.error('✗ ' + msg); }
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
  return true;
}
function expectNew(text, compactOn) {
  const r = worker.formatJSON({ text, compact: compactOn });
  // 不变式：输出必须能无损 round-trip 回原文档
  if (!deepEqual(JSON.parse(r.result), JSON.parse(text))) fail('round-trip 不一致: ' + text.slice(0, 80));
  return r;
}
function diffCase(name, doc, compactOn = true) {
  checks++;
  const text = JSON.stringify(doc);
  const ref = formatJSONRef(text, compactOn);
  const got = expectNew(text, compactOn);
  if (got.result !== ref.result) {
    fail(`${name} 输出与参照不一致`);
    const a = ref.result, b = got.result;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) { console.error(`  首个差异@${i}: 参照 ${JSON.stringify(a.slice(Math.max(0, i - 40), i + 40))}\n  新实现 ${JSON.stringify(b.slice(Math.max(0, i - 40), i + 40))}`); break; }
    }
  }
}

// —— 语料 1：种子化随机文档 ——
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rnd = mulberry32(20261003);
const WEIRD_KEYS = ['', 'k', '中文键', 'a b', 'quote"key', 'back\\slash', 'emoji😀', '0'];
const WEIRD_VALS = [null, true, false, 0, -0, -1.5, 1e21, 1.25e-8, 123456789.123, '', '中文内容', 'line\nbreak', 'tab\there', 'quote"in\'side', '😀😀'];
function randString(r) { const n = 1 + Math.floor(r() * 130); let s = ''; for (let i = 0; i < n; i++) s += 'x'; return s; }
function randDoc(r, depth) {
  if (depth <= 0 || r() < 0.35) {
    if (r() < 0.5) return WEIRD_VALS[Math.floor(r() * WEIRD_VALS.length)];
    return randString(r);
  }
  const n = 1 + Math.floor(r() * 5);
  if (r() < 0.5) { const a = []; for (let i = 0; i < n; i++) a.push(randDoc(r, depth - 1)); return a; }
  const o = {};
  for (let i = 0; i < n; i++) o[WEIRD_KEYS[Math.floor(r() * WEIRD_KEYS.length)] + i] = randDoc(r, depth - 1);
  return o;
}
for (let t = 0; t < 500; t++) diffCase(`随机#${t}`, randDoc(rnd, 1 + Math.floor(rnd() * 9)));

// —— 语料 2：折叠判定 100 列边界扫（键长/值长在阈值附近摆动） ——
for (let n = 70; n <= 120; n++) {
  diffCase(`边界-对象-${n}`, { a: 'x'.repeat(n), b: 1 });
  diffCase(`边界-数组-${n}`, ['x'.repeat(n), 1]);
  diffCase(`边界-嵌套-${n}`, { outer: { inner: 'x'.repeat(n) }, tail: [1, 2] });
  // 长键名：keyText 把列位置推过 100，覆盖展开路径的 col 边界
  diffCase(`边界-长键-${n}`, { ['k'.repeat(n)]: 'v', short: 1 });
  diffCase(`边界-长键嵌套-${n}`, { ['k'.repeat(n)]: { deep: [1] }, tail: 2 });
}

// —— 语料 2b：宽字符列宽（CJK/全角/emoji/组合字符），含中文列宽边界扫描 ——
const WIDE_SAMPLES = ['中文内容测试', '日本語テキスト', '한국어 텍스트', 'ＡＢＣ全角', '😀😀 emoji', 'café'.normalize('NFD'), 'e\u0301组合', 'zero\u200bwidth', '混合 mixed 中英 123'];
for (let n = 30; n <= 60; n++) {
  // '中' 占 2 列，2n 扫过 60..120，跨越 100 列折叠边界
  diffCase(`中文边界-值-${n}`, { a: '中'.repeat(n), b: 1 });
  diffCase(`中文边界-键-${n}`, { ['中'.repeat(n)]: 'v', short: 1 });
  diffCase(`中文边界-混合-${n}`, { msg: '中文' + 'x'.repeat(n) + '😀', tags: ['标签', 'x'.repeat(n)] });
}
diffCase('宽字符 assorted', WIDE_SAMPLES.map(s => ({ text: s })));
diffCase('宽字符键', Object.fromEntries(WIDE_SAMPLES.map((s, i) => ['键' + i, s])));
diffCase('emoji 键与值', { '😀键': '😀值', '👍': ['🙌', { '⚡': 1 }] });
diffCase('组合字符', { word: 'cafe\u0301', name: 'a\u0301b\u0301c\u0301' });

// —— 语料 3：构造场景（旧实现可承受的规模，逐字节 diff） ——
function wideShallow(count, depth) {
  const arr = [];
  for (let i = 0; i < count; i++) {
    const o = { id: i, name: 'item-' + i, tags: ['a', 'b'], active: true, score: 1.5 };
    let cur = o;
    for (let d = 0; d < depth; d++) { cur.nested = { level: d, value: 'x'.repeat(20) }; cur = cur.nested; }
    arr.push(o);
  }
  return arr;
}
function chain(depth) { const root = { v: 0 }; let cur = root; for (let d = 1; d < depth; d++) { cur.next = { v: d }; cur = cur.next; } return root; }
function chainWithWideStrings(depth, tailLen) { const root = { v: 0 }; let cur = root; for (let d = 1; d < depth; d++) { cur.next = { v: d }; cur = cur.next; } cur.tail = 'x'.repeat(tailLen); return root; }
diffCase('空容器', { a: [], b: {}, c: [[], [{}]] });
diffCase('根数组', randDoc(mulberry32(7), 6));
diffCase('根标量-数', 42);
diffCase('根标量-串', '根级字符串');
diffCase('根标量-空串', '');
diffCase('根空对象', {});
diffCase('根空数组', []);
diffCase('宽×深30 ×2000', wideShallow(2000, 30));
diffCase('宽×深20 ×800', wideShallow(800, 20));
diffCase('链式150', chain(150));
diffCase('链式带长尾串', chainWithWideStrings(60, 3000));

// —— 语料 4：守卫行为（旧实现跑不动的规模，校验回退决策与 round-trip） ——
function guardCase(name, doc, expectCompact) {
  checks++;
  const text = JSON.stringify(doc);
  const r = expectNew(text, true);
  if (r.compact !== expectCompact) fail(`${name} 守卫决策错误: 期望 compact=${expectCompact} 实得 ${r.compact}`);
}
// 嵌套 1500 层：恰在上限内（大小 17KB，depth×size 远小于预算）
guardCase('链式1500=上限内', chain(1500), true);
// 嵌套 1501 层：超栈安全上限
guardCase('链式1501=超上限', chain(1501), false);
// depth×size 预算边界：先按实际序列化长度推导期望，再双向验证
function budgetBoundaryDoc(nesting, tailLen) {
  const root = { v: 0 }; let cur = root;
  for (let d = 1; d < nesting; d++) { cur.next = { v: d }; cur = cur.next; }
  cur.tail = 'x'.repeat(tailLen);
  return root;
}
{
  const nesting = 40, tailLen = 1000;
  const doc = budgetBoundaryDoc(nesting, tailLen);
  const size = JSON.stringify(doc).length;
  const depthLimit = Math.min(worker.COMPACT_MAX_DEPTH, Math.floor(worker.COMPACT_COST_BUDGET / Math.max(size, 1)));
  const expect = nesting <= depthLimit;
  guardCase(`预算边界(size=${size},limit=${depthLimit})`, doc, expect);
  // 从预算下往上逼近：加大 tailLen 直到翻到回退侧，再确认翻过去了
  let over = doc;
  for (let t = tailLen; ; t = Math.floor(t * 1.5)) {
    over = budgetBoundaryDoc(nesting, t);
    if (nesting > Math.min(worker.COMPACT_MAX_DEPTH, Math.floor(worker.COMPACT_COST_BUDGET / JSON.stringify(over).length))) break;
  }
  guardCase(`预算边界-翻面(size=${JSON.stringify(over).length})`, over, false);
}
// 小文档保持紧凑
guardCase('小文档保持紧凑', { hello: ['world', 1, { deep: true }] }, true);
// compact 关闭时必须走全量展开
checks++;
{
  const doc = { b: [1, 2], a: 'x'.repeat(200) };
  const r = worker.formatJSON({ text: JSON.stringify(doc), compact: false });
  if (r.compact !== false || r.result !== JSON.stringify(doc, null, 2)) fail('compact 关闭时未走全量展开');
}

console.log(`\n共 ${checks} 个用例，${failures === 0 ? '全部通过 ✓' : failures + ' 个失败 ✗'}`);
process.exit(failures === 0 ? 0 : 1);
