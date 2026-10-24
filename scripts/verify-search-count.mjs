// 编辑器搜索面板匹配计数的回归验证。
//
// 背景：搜索面板自己画了「N of M」计数器。原先的实现数的是编辑器里已渲染的
// .cm-searchMatch 高亮 span——而 CodeMirror 只为视口区域渲染匹配高亮（外加约
// 250px 余量），滚动之后才补齐。于是同一个查询会先报「1 of 1」、按一次「下一个」
// 又变成「1 of 9」：总量随视口漂移，序号也只在已渲染的那几个里面数。
//
// 现在的口径：计数取自文档遍历（src/search-count.ts），序号按当前选区判定
// （findNext / findPrevious 把选区落在匹配上，选中态高亮也是同一口径）。
//
// 本脚本把这条依赖固化为源码层断言：
//   1. 计数模块存在，且确实遍历文档（getCursor）而不是数 DOM；
//   2. 序号由当前选区得出；
//   3. 空查询 / 非法查询按 0 匹配处理（红框由调用方显示）；
//   4. 结果按「文档对象 + 查询 + 选区」缓存，避免每次重绘都全篇扫描；
//   5. main.ts 的计数器只消费该模块，不再出现 .cm-searchMatch 的 DOM 计数；
//   6. 刷新由编辑器状态更新驱动（updateListener + searchPanelOpen），不靠
//      MutationObserver 监听高亮渲染；
//   7. 模块不引入 polyfill 与 ES2019+ 特性（构建目标 ES2017）。
//
// 局限（重要）：本脚本是**源码层代理断言**，无法证明浏览器里的数字对。计数仍需按
// docs/agents/browser-checklist-search-reveal-scroll.md 人工实测确认。
//
// 用法：node scripts/verify-search-count.mjs   （全绿退出码 0，任何不一致非 0）
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const countPath = join(ROOT, 'src/search-count.ts');
const mainTs = readFileSync(join(ROOT, 'src/main.ts'), 'utf8');
const moduleExists = existsSync(countPath);
const countCode = moduleExists ? readFileSync(countPath, 'utf8') : '';

const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push(`${name}\n    ${detail}`);
};
const missing = 'src/search-count.ts 不存在。';

// —— 1. 计数走文档遍历 ——
check(
  '计数模块存在并遍历文档（query.getCursor）',
  moduleExists && /getSearchQuery\(/.test(countCode) && /\.getCursor\(/.test(countCode),
  missing + '计数必须遍历整篇文档：高亮只为视口渲染，数 DOM 会让总量随滚动漂移。'
);
check(
  '每命中一个匹配就累加总数',
  moduleExists && /total\+\+/.test(countCode),
  missing + '源码里没有对匹配计数的累加。'
);

// —— 2. 序号由当前选区得出 ——
check(
  '序号按当前选区落在哪个匹配上判定（state.selection.main + from/to 比对）',
  moduleExists && /state\.selection\.main/.test(countCode) &&
    /next\.value\.from\s*===\s*sel\.from/.test(countCode) &&
    /next\.value\.to\s*===\s*sel\.to/.test(countCode),
  missing + '序号必须与 CODE 的选中态同口径：findNext / findPrevious 把选区落在匹配上，' +
  '选中态高亮也是按「选区范围等于匹配范围」着色。'
);

// —— 3. 空查询 / 非法查询 ——
check(
  '空查询与非法查询都按 0 匹配处理（!hasQuery || !query.valid）',
  moduleExists && /!\s*hasQuery\s*\|\|\s*!\s*query\.valid/.test(countCode),
  missing + '源码里没有「空查询 / 非法正则」的短路：正则没写完时遍历会抛错。'
);
check(
  '空查询不算「无匹配」（hasQuery 单独给出）',
  moduleExists && /hasQuery/.test(countCode) && !/total\s*===\s*0\s*&&\s*hasQuery/.test(countCode),
  missing + '红框判定应由调用方用 hasQuery 决定：空查询不该显示成「搜索失败」。'
);

// —— 4. 缓存 ——
check(
  '结果按文档对象 + 查询 + 选区缓存（复用条件齐全）',
  moduleExists && /reuse\.doc\s*===\s*state\.doc/.test(countCode) &&
    /reuse\.query\.eq\(query\)/.test(countCode) &&
    /reuse\.from\s*===\s*sel\.from/.test(countCode),
  missing + '没有缓存的话，面板每敲一个键都会全篇扫描一遍文档。'
);

// —— 5. main.ts 不再数 DOM ——
check(
  'main.ts 的计数器不再数已渲染的高亮 span',
  !/querySelectorAll\(\s*'#editor-container \.cm-searchMatch'\s*\)/.test(mainTs) &&
    !/cm-searchMatch-selected'\)/.test(mainTs),
  'src/main.ts 里仍在数 .cm-searchMatch 元素：高亮只为视口渲染，' +
  '计数会先报「1 of 1」、跳转后变成「1 of 9」。'
);
check(
  'main.ts 的计数器消费 ./search-count 的结果',
  /import\s*\{[^}]*editorMatchInfo[^}]*\}\s*from\s*'\.\/search-count'/.test(mainTs) &&
    /editorMatchInfo\(\s*inputEditor\.state\s*\)/.test(mainTs),
  "src/main.ts 中没有从 './search-count' 引入并调用 editorMatchInfo(inputEditor.state)。"
);
check(
  '计数器把 index / total 拼成「N of M」',
  /info\.index\s*\+\s*' of '\s*\+\s*info\.total/.test(mainTs),
  '计数器没有用 info.index / info.total 拼文案。'
);

// —— 6. 刷新由编辑器状态驱动 ——
check(
  '刷新由编辑器状态更新驱动（updateListener + searchPanelOpen）',
  /EditorView\.updateListener\.of\(/.test(mainTs) && /searchPanelOpen\(\s*update\.state\s*\)/.test(mainTs),
  'src/main.ts 里没有「面板打开时随状态更新刷新计数」的 updateListener。'
);
check(
  '不再用 MutationObserver 监听高亮渲染来数匹配',
  !/new MutationObserver/.test(mainTs),
  'src/main.ts 里仍有 MutationObserver 在补计数：它以渲染结果为输入，' +
  '正是「1 of 1」变成「1 of 9」的成因。'
);

// —— 7. 刷新代价受控 ——
check(
  '查询 / 文档变化时防抖重扫（setTimeout + setSearchQuery 判定）',
  /setTimeout\(/.test(mainTs) && /setSearchQuery/.test(mainTs) &&
    /window\.clearTimeout\(/.test(mainTs),
  'src/main.ts 里没有对「查询 / 文档变化」的防抖：大文档每个按键都会全篇扫描一遍计数。' +
  '选区变化（按「下一个」）应走缓存即时刷新，重扫只发生在查询或文档真的变了时。'
);

// —— 8. 兼容性 ——
check(
  '计数模块不引入 polyfill 与 ES2019+ 特性',
  moduleExists && !/ResizeObserver|IntersectionObserver/.test(countCode) &&
    !/\.flat\(|\.flatMap\(|Object\.fromEntries/.test(countCode),
  missing + '模块里出现了需要 polyfill 的 API 或 ES2019+ 特性（构建目标 ES2017）。'
);

if (failures.length) {
  console.error('编辑器搜索匹配计数回归验证失败：\n');
  failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}\n`));
  console.error(`共 ${failures.length} 项不一致。`);
  process.exit(1);
}

console.log('编辑器搜索匹配计数回归验证：全部通过');
console.log('  - 计数遍历整篇文档（getCursor），不数已渲染的高亮 span');
console.log('  - 序号按当前选区判定，与选中态高亮同口径');
console.log('  - 空查询 / 非法查询按 0 匹配处理');
console.log('  - 结果按文档 + 查询 + 选区缓存');
console.log('  - main.ts 只消费计数结果，不再用 MutationObserver 数 DOM');
console.log('\n注意：本脚本是源码层代理断言，无法证明浏览器里的数字对。');
console.log('计数仍需按 docs/agents/browser-checklist-search-reveal-scroll.md 人工实测。');
