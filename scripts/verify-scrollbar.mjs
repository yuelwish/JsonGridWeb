// 左侧编辑器滚动条回归验证：断言「自绘滚动条」所依赖的不变量没有被后续改动破坏。
//
// 背景：CodeMirror 6 虚拟滚动只渲染视口附近的行，未渲染区用 .cm-gap 占位、块高
// 是估算值。滚到新区域时估算被实测高度替换，文档总高度（scrollHeight）随之
// 突变；Chrome 原生滚动条在这种突变中会丢掉一次 mousemove，拖拽位置因此永久
// 滞后一拍（鼠标已拖到顶端，滚动条还停在半路）。修复方案是左侧改用自绘滚动条
// （src/scrollbar.ts），拖拽映射基于按下瞬间的滚动范围快照，期间高度突变不再
// 影响映射。
//
// 本脚本把这条修复依赖的不变量固化为源码层断言，覆盖三类回归：
//   1. 覆盖 CodeMirror baseTheme 的 flex 契约（行号栏与内容并排），
//      改坏后折行与滚动同步都会错位；
//   2. 自绘滚动条挂到了会随内容一起滚动的容器上（滚动时整条 bar 滚出视口）；
//   3. 搜索面板右缘偏移与自绘滚动条宽度脱钩（面板压住内容或悬空在留白外）。
//
// 局限（重要）：本脚本是**源码层代理断言**，只能证明这些不变量还在，无法证明
// 浏览器里拖拽真的跟手。拖拽跟手性仍需人工或浏览器级测试确认。
//
// 用法：node scripts/verify-scrollbar.mjs   （全绿退出码 0，任何不一致非 0）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const styleCss = readFileSync(join(ROOT, 'src/style.css'), 'utf8');
const scrollbarTs = readFileSync(join(ROOT, 'src/scrollbar.ts'), 'utf8');
const mainTs = readFileSync(join(ROOT, 'src/main.ts'), 'utf8');

const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push(`${name}\n    ${detail}`);
};

/** 取出某条选择器的规则块正文（不含选择器本身） */
const ruleBody = (css, selector) => {
  const start = css.indexOf(selector + ' {');
  if (start < 0) return null;
  const end = css.indexOf('}', start);
  if (end < 0) return null;
  return css.slice(start, end);
};

const scrollerRule = ruleBody(styleCss, '.cm-editor .cm-scroller');

// —— 1. CodeMirror 的 flex 契约：行号栏与内容靠 flex 并排 ——
// CM6 的 baseTheme 以 `display: flex !important` 固定 .cm-scroller；一旦被改成
// block 或 absolute，行号栏与内容的并排关系就断了（本次会话中曾因这条契约被
// 破坏而误判根因）。src/scrollbar.ts 也不该在这里声明 display。
check(
  'style.css 中 .cm-scroller 不声明 display（保持 CodeMirror 的 flex 契约）',
  scrollerRule !== null && !/display\s*:/.test(scrollerRule),
  scrollerRule === null
    ? 'src/style.css 中找不到「.cm-editor .cm-scroller {」规则块。'
    : '规则块里出现了 display 声明：' + scrollerRule.replace(/\s+/g, ' ') +
      '。CodeMirror baseTheme 用 `display: flex !important` 让行号栏与内容并排，' +
      '覆盖它会同时破坏折行宽度计算与滚动同步。'
);
check(
  'src/scrollbar.ts 不改写 .cm-scroller 的 display',
  !/\.cm-scroller[^{]*\{[^}]*display\s*:/.test(scrollbarTs),
  'src/scrollbar.ts 里出现了针对 .cm-scroller 的 display 声明，' +
  '这会与 CodeMirror 的 flex 契约冲突。'
);

// —— 2. 自绘滚动条必须挂在不随内容滚动的容器上 ——
// 绝对定位的后代会随滚动容器的内容一起滚走：挂在 .cm-scroller 里，滚到底部时
// 整条 bar 会跑到视口上方（本次会话实际踩过：thumb 位置算出 -6779px）。
const hostLine = scrollbarTs.match(/const\s+host\s*=\s*([^\n;]+);/);
check(
  '自绘滚动条挂在 scroller 的父容器上（不随内容滚动）',
  hostLine !== null && /parentElement/.test(hostLine[1]),
  hostLine === null
    ? 'src/scrollbar.ts 里找不到 host 的声明。'
    : 'host 取值为「' + hostLine[1].trim() + '」，应取 scroller.parentElement。' +
      '挂在 .cm-scroller 内的绝对定位后代会随内容滚走。'
);
check(
  '滚动条容器不直接 append 到 scroller 上',
  !/scroller\.appendChild\s*\(/.test(scrollbarTs),
  'src/scrollbar.ts 里有 scroller.appendChild(...)：滚动条会成为滚动内容的一部分，' +
  '滚动时随内容移出视口。'
);

// —— 3. 隐藏原生滚动条后，内容区必须让出等宽的留白 ——
// 隐藏原生滚动条会释放它原本占的宽度；若不让位，文字会被自绘 bar 压住。
// 留白宽度必须与自绘滚动条宽度严格相等，否则出现压字或悬空。
const widthConst = scrollbarTs.match(/EDITOR_SCROLLBAR_WIDTH\s*=\s*(\d+)/);
const padding = scrollerRule === null ? null : scrollerRule.match(/padding-right\s*:\s*(\d+)px/);
check(
  'style.css 给 .cm-scroller 设了 padding-right（内容区为自绘滚动条让位）',
  padding !== null,
  scrollerRule === null
    ? 'src/style.css 中找不到「.cm-editor .cm-scroller {」规则块。'
    : '规则块里没有 padding-right：隐藏原生滚动条后内容会被自绘 bar 压住。'
);
check(
  'padding-right 与自绘滚动条宽度一致',
  widthConst !== null && padding !== null && Number(widthConst[1]) === Number(padding[1]),
  `src/scrollbar.ts 的 EDITOR_SCROLLBAR_WIDTH = ${widthConst ? widthConst[1] : '（未找到）'}，` +
  `style.css 的 padding-right = ${padding ? padding[1] : '（未找到）'}px。` +
  '两者不等会让内容区与滚动条错位（压字或悬空）。'
);
check(
  '原生滚动条被隐藏（否则会与自绘滚动条并存、且仍带高度突变的原生拖拽行为）',
  scrollerRule !== null && /scrollbar-width\s*:\s*none/.test(scrollerRule),
  scrollerRule === null
    ? 'src/style.css 中找不到「.cm-editor .cm-scroller {」规则块。'
    : '规则块里没有 scrollbar-width: none。'
);
check(
  '.cm-scroller 仍是 overflow: auto（滚轮与键盘滚动能力依赖它）',
  scrollerRule !== null && /overflow\s*:\s*auto/.test(scrollerRule),
  scrollerRule === null
    ? 'src/style.css 中找不到「.cm-editor .cm-scroller {」规则块。'
    : '规则块里没有 overflow: auto：隐藏原生滚动条后若不保留可滚动容器，' +
      '滚轮与键盘滚动会失效。'
);

// —— 4. 搜索面板右缘偏移必须跟着自绘滚动条宽度走 ——
// 搜索面板贴内容区右缘（不盖滚动条），偏移量即滚动条宽度。原生滚动条隐藏后，
// 运行时测量原生滚动条宽度会得到与实际留白不一致的值，偏移就会错位。
check(
  'main.ts 从 ./scrollbar 引入自绘滚动条宽度',
  /import\s*\{[^}]*EDITOR_SCROLLBAR_WIDTH[^}]*\}\s*from\s*'\.\/scrollbar'/.test(mainTs),
  "src/main.ts 中找不到从 './scrollbar' 引入 EDITOR_SCROLLBAR_WIDTH。"
);
check(
  '搜索面板偏移量取自自绘滚动条宽度常量',
  /const\s+SCROLLBAR_WIDTH\s*=\s*EDITOR_SCROLLBAR_WIDTH\s*;/.test(mainTs),
  'src/main.ts 中 SCROLLBAR_WIDTH 应直接取 EDITOR_SCROLLBAR_WIDTH。'
);
check(
  '不再运行时测量原生滚动条宽度',
  !/function\s+measureScrollbarWidth/.test(mainTs),
  'src/main.ts 仍有 measureScrollbarWidth：原生滚动条已隐藏，测出来的宽度与' +
  '实际留白无关，会让搜索面板偏移错位。'
);

// —— 报告 ——
if (failures.length > 0) {
  console.error('左侧滚动条回归验证失败：\n');
  failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}\n`));
  console.error(`共 ${failures.length} 项不一致。`);
  process.exit(1);
}

console.log('左侧滚动条回归验证：全部通过');
console.log('  - .cm-scroller 保持 CodeMirror 的 flex 契约，未被改写 display');
console.log('  - 自绘滚动条挂在不随内容滚动的父容器上');
console.log('  - 原生滚动条隐藏，内容区按同宽 padding-right 让位');
console.log('  - .cm-scroller 保留 overflow: auto，滚轮与键盘滚动照常');
console.log('  - 搜索面板右缘偏移取自自绘滚动条宽度常量');
console.log('\n注意：本脚本是源码层代理断言，无法证明浏览器里的拖拽跟手性。');
console.log('拖拽是否与鼠标 1:1 仍需人工或浏览器级测试确认。');
