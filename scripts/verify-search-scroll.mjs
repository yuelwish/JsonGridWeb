// 编辑器搜索匹配落点与揭示滚动的回归验证。
//
// 背景：CodeMirror 搜索默认的 scrollToMatch 是 EditorView.scrollIntoView(range)
// （y:"nearest"，贴边可见）。虚拟滚动下未渲染区域只有估算块高，贴边会连带估算误差，
// 把匹配甩到视口顶端之外（实测落点 y=-20px，匹配被上边缘裁切、正好藏在搜索面板背后）。
// 本项目通过 search({ scrollToMatch }) 官方扩展点接管，落点规则是：
//   - 一次查询里第一个需要滚动的匹配 → 视口垂直居中；
//   - 同一查询的后续匹配 → 贴近来向边缘并升起一小段（揭示滚动）。
// 见 docs/specs/2026-10-21-search-reveal-scroll.md 与
// docs/adr/0002-search-match-reveal-scroll.md。
//
// 本脚本把这条设计依赖的不变量固化为源码层断言，覆盖九类回归：
//   1. 搜索配置确实被接管，且接管不是「直接返回 EditorView.scrollIntoView」；
//   2. 首个匹配的落点是视口垂直居中（(视口高 - 区块高) / 2）；
//   3. 后续匹配的落点贴着来向边缘并留出间距（揭示「上来一点点」）；
//   4. 「首个 / 后续」按查询判定，不按跳转次数；
//   5. 揭示滚动由 rAF 逐帧推进、用 ease-out cubic、时长随距离缩放；
//   6. 用户滚动（滚轮 / 触摸 / 键盘）能立即打断动画；
//   7. prefers-reduced-motion 降级为直接落位；
//   8. 执行顺序：先派发 scrollIntoView、再取实测坐标、最后改写 scrollTop；
//   9. 搜索面板打开时清空状态里的查询，落点逻辑留在独立模块且不引入 polyfill。
//
// 局限（重要）：本脚本是**源码层代理断言**，只能证明这些不变量还在，无法证明浏览器
// 里匹配真的落在预期位置、动画真的可见。落点与动效仍按
// docs/agents/browser-checklist-search-reveal-scroll.md 人工实测确认。
//
// 用法：node scripts/verify-search-scroll.mjs   （全绿退出码 0，任何不一致非 0）
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const scrollPath = join(ROOT, 'src/search-scroll.ts');
const mainTs = readFileSync(join(ROOT, 'src/main.ts'), 'utf8');

const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push(`${name}\n    ${detail}`);
};

/**
 * 去掉注释：断言要针对代码，不能被注释里的说明文字满足
 * （落点模块的注释里就写着「search({ scrollToMatch })」这类字样）。
 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');

const moduleExists = existsSync(scrollPath);
const scrollTs = moduleExists ? readFileSync(scrollPath, 'utf8') : '';
const mainCode = stripComments(mainTs);
const scrollCode = stripComments(scrollTs);
const missing = 'src/search-scroll.ts 不存在（或读不出内容）：匹配落点逻辑应独立成模块。';

// —— 1. 搜索配置确实被接管，且接管不是「直接返回 EditorView.scrollIntoView」 ——
// 直接返回 EditorView.scrollIntoView 就会沿用默认的 y:"nearest" 贴边滚动，
// 落点缺陷原样复现；接管必须换成自己的 effect，把落点交给模块自己算。
const searchCallIdx = scrollCode.search(/search\s*\(\s*\{/);
const scrollToMatchIdx = scrollCode.indexOf('scrollToMatch');
check(
  '搜索配置被接管：存在 search({ scrollToMatch }) 形态的接管',
  moduleExists && searchCallIdx >= 0 && scrollToMatchIdx > searchCallIdx,
  missing + (moduleExists
    ? `（search({ 的位置 ${searchCallIdx}，scrollToMatch 的位置 ${scrollToMatchIdx}）`
    : '') + '。'
);
check(
  '接管函数不直接返回 EditorView.scrollIntoView（否则默认贴边滚动照旧发生）',
  moduleExists && !/scrollToMatch\s*:\s*(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*EditorView\.scrollIntoView/.test(scrollCode),
  '接管函数直接把 EditorView.scrollIntoView 返回给 CodeMirror：' +
  '那等于沿用默认的贴边滚动（y:"nearest"），匹配仍会被甩到视口顶端之外。'
);
check(
  '接管通过自定义 effect 传递目标位置与查询标识',
  moduleExists && /scrollToMatch\s*:\s*[^=]*=>\s*[A-Za-z_$][\w$]*\.of\(\s*\{/.test(scrollCode),
  '接管函数没有返回携带目标位置的自定义 effect：目标应由 effect 携带，' +
  '再由视图插件在事务落地后处理。'
);

// —— 2. 首个匹配的落点：视口垂直居中 ——
// 居中落点 = (视口高 - 区块高) / 2；写成别的形状（贴边、贴顶）都不算数。
check(
  '首个匹配落点为视口垂直居中（(视口高 - 区块高) / 2）',
  moduleExists && /\(\s*\w*[Vv]iewport\w*\s*-\s*\w*[Bb]lock\w*\s*\)\s*\/\s*2/.test(scrollCode),
  missing + '源码里找不到「(视口高 - 区块高) / 2」形态的居中计算。'
);

// —— 3. 后续匹配的落点：贴着来向边缘并留出间距 ——
// 后续匹配从底缘（向上查找时顶缘）升起一小段，留出间距才不会贴着边缘难读。
const edgeMarginIdx = scrollCode.indexOf('EDGE_MARGIN_RATIO');
check(
  '后续匹配的落点贴着来向边缘并留出间距（EDGE_MARGIN_RATIO + 边缘落点函数）',
  moduleExists && edgeMarginIdx >= 0 && /[Vv]iewportHeight\s*-\s*\w*\s*-\s*\w*[Bb]lockHeight/.test(scrollCode),
  missing + '源码里找不到「视口高 - 间距 - 区块高」形态的边缘落点计算：' +
  '后续匹配应贴着来向的那条边缘（下方来贴底缘、上方来贴顶缘）并留出间距。'
);
check(
  '边缘落点按来向取边（从底缘来贴底，从顶缘来贴顶）',
  moduleExists && /cameFromBottom\s*=/.test(scrollCode) &&
    /\w*\.top\s*>=\s*this\.scrollTopBefore/.test(scrollCode),
  missing + '源码里没有「目标相对滚动前位置」的来向判定：' +
  '方向不能看贴边滚动的落点（未渲染区域只有估算块高，落点本身就会偏），' +
  '否则向下查找的匹配会落到顶缘。'
);

// —— 4. 「首个 / 后续」按查询判定，不按跳转次数 ——
// 按跳转次数判定的话，改完查询再按「下一个」会落到底缘而不是居中。
check(
  '首个 / 后续按查询标识判定（queryKey + lastQueryKey）',
  moduleExists && /queryKey/.test(scrollCode) && /lastQueryKey/.test(scrollCode) &&
    /queryKey\s*!==\s*this\.lastQueryKey|this\.lastQueryKey\s*!==\s*\w*queryKey/i.test(scrollCode),
  missing + '源码里没有按查询标识区分「首个匹配 / 后续匹配」：' +
  '用跳转次数判定会让改过查询后的首次落点也贴到边缘。'
);

// —— 5. 揭示滚动：rAF 逐帧推进 + ease-out cubic + 时长随距离缩放 ——
check(
  '揭示滚动由 requestAnimationFrame 逐帧推进',
  moduleExists && /requestAnimationFrame\s*\(\s*\w+\s*\)/.test(scrollCode) &&
    scrollCode.includes('cancelAnimationFrame'),
  missing + '源码里没有 rAF 驱动的逐帧滚动（或缺少 cancelAnimationFrame）：' +
  '落点必须由逐帧推进，单帧跳变就退化成本次要修的缺陷。'
);
check(
  '缓动曲线为 ease-out cubic（1 - (1 - t)^3）',
  moduleExists && /1\s*-\s*Math\.pow\(\s*1\s*-/.test(scrollCode),
  missing + '源码里找不到「1 - Math.pow(1 - t, 3)」形态的 ease-out 曲线。'
);
check(
  '揭示动画有明确的固定时长常量（REVEAL_MS）',
  moduleExists && /const\s+REVEAL_MS\s*=\s*\d+/.test(scrollCode),
  missing + '源码里没有揭示动画的时长常量。'
);

// —— 6. 打断：用户滚动立即交还控制权 ——
check(
  '用户滚动（滚轮 / 触摸 / 键盘）可立即打断揭示动画',
  moduleExists && /addEventListener\(\s*'wheel'/.test(scrollCode) &&
    /addEventListener\(\s*'touchstart'/.test(scrollCode) &&
    /addEventListener\(\s*'keydown'/.test(scrollCode),
  missing + '源码里没有 wheel / touchstart / keydown 的打断监听：' +
  '动画期间用户滚动必须立即接管视图。'
);
check(
  '打断时撤销动画帧并移除监听（cancelAnimation + removeEventListener）',
  moduleExists && /removeEventListener\(\s*'wheel'/.test(scrollCode) &&
    /cancelAnimationFrame/.test(scrollCode),
  missing + '打断路径没有清理动画帧与监听：会留下在后台继续写 scrollTop 的孤儿动画。'
);

// —— 7. 降级：prefers-reduced-motion 直接落位 ——
check(
  'prefers-reduced-motion 降级为直接落位（matchMedia + prefers-reduced-motion）',
  moduleExists && /matchMedia\(\s*'\(prefers-reduced-motion:\s*reduce\)'/.test(scrollCode),
  missing + '源码里没有 prefers-reduced-motion 判定：' +
  '开启「减少动态效果」的用户不该被滚动动画干扰。'
);

// —— 8. 执行顺序：先派发 scrollIntoView、再取实测坐标、最后改写 scrollTop ——
// 落点必须建立在实测之上：未渲染区域只有估算块高，先算落点会算在估算值上
// （这正是原缺陷的成因）。scrollTop 的改写必须排在 scrollIntoView 之后，
// 否则会被随后的贴边滚动覆盖。
const scrollIntoViewIdx = scrollCode.indexOf('EditorView.scrollIntoView');
const coordsIdx = scrollCode.indexOf('coordsAtPos');
const scrollTopWriteIdx = scrollCode.search(/scrollDOM\.scrollTop\s*(\+=|=[^=])/);
check(
  '先派发 scrollIntoView，再改写 scrollTop（顺序不能反）',
  moduleExists && scrollIntoViewIdx >= 0 && scrollTopWriteIdx > scrollIntoViewIdx,
  `scrollIntoView 的位置 ${scrollIntoViewIdx}，scrollTop 改写的位置 ${scrollTopWriteIdx}。` +
  '顺序反了的话，贴边滚动会把落点覆盖掉。'
);
check(
  '落点取的是目标渲染后的实测坐标（coordsAtPos 在 scrollIntoView 之后）',
  moduleExists && coordsIdx > scrollIntoViewIdx,
  `scrollIntoView 的位置 ${scrollIntoViewIdx}，coordsAtPos 的位置 ${coordsIdx}。` +
  '落点必须用实测坐标，未渲染区域只有估算块高，先算会偏出视口。'
);

// —— 8b. 揭示起点自算，不采用贴边滚动的停靠位置 ——
// 带折行的文档里未渲染区域的估算偏差可达半屏（实测把匹配甩到视口上边 -20px），
// 拿贴边滚动的停靠位置当起点，向上查找会变成「从顶部滑下来」。
check(
  '揭示起点按实测内容坐标自算（不拿贴边滚动停在哪当起点）',
  moduleExists && /startScrollTop\s*=\s*block\.top\s*-/.test(scrollCode) &&
    /scrollDOM\.scrollTop\s*=\s*startScrollTop/.test(scrollCode),
  missing + '源码里没有「自己算揭示起点」：贴边滚动的停靠位置在未渲染区域里偏差可达半屏，' +
  '拿它当起点会让向下查找的匹配从顶部滑下来。'
);

// —— 9. 匹配已在视口内时完全不动 ——
check(
  '记录了滚动前的位置并比较（scrollTopBefore）',
  moduleExists && /scrollTopBefore\s*=\s*this\.view\.scrollDOM\.scrollTop/.test(scrollCode) &&
    /scrollTop\s*!==\s*this\.scrollTopBefore/.test(scrollCode),
  missing + '源码里没有「滚动前后位置比较」：匹配已在视口内时会被强行拽动。'
);
check(
  '目标已完整可见时不滚动（isFullyVisible 判定）',
  moduleExists && /isFullyVisible\s*\(/.test(scrollCode),
  missing + '源码里没有「匹配已完整落在视口内」的判定。'
);

// —— 10. 搜索面板打开时查询被清空 ——
// 搜索配置提前装上后，CM 的搜索状态从编辑器创建起就存在，openSearchPanel 会走
// 「state 已存在」分支，用当前选中文本预填查询。只清输入框的可见值不够：
// 框里看着是空的，编辑器却按选中文本高亮。
const queryClearInModule = /setSearchQuery\.of\(\s*new SearchQuery\(\s*\{[^}]*search:\s*''/.test(scrollCode);
const queryClearInMain = /setSearchQuery\.of\(\s*new SearchQuery\(\s*\{[^}]*search:\s*''/.test(mainCode);
check(
  '搜索面板打开时清空状态里的查询（setSearchQuery + 空 SearchQuery）',
  queryClearInModule || queryClearInMain,
  '源码里找不到 setSearchQuery.of(new SearchQuery({ search: \'\' }))：' +
  '搜索配置提前装上后 CM 会用当前选中文本预填查询，' +
  '只清输入框的可见值会留下「框里空着、编辑器却按选中文本高亮」的错位。'
);

// —— 11. 落点逻辑待在独立模块里，主逻辑只做接线 ——
check(
  'main.ts 从 ./search-scroll 引入匹配滚动扩展',
  /import\s*\{[^}]*\}\s*from\s*'\.\/search-scroll'/.test(mainCode),
  "src/main.ts 中找不到从 './search-scroll' 引入匹配滚动扩展。"
);
check(
  'main.ts 不夹带匹配落点计算（接管与落点都待在独立模块）',
  !/scrollToMatch/.test(mainCode) && !/scrollDOM\.scrollTop/.test(mainCode),
  'src/main.ts 里出现了 scrollToMatch 或 scrollDOM.scrollTop 的改写：' +
  '匹配滚动的接管与落点计算应待在 src/search-scroll.ts，主逻辑只做接线。' +
  '（main.ts 里为 GRID 定位与报错高亮保留的 EditorView.scrollIntoView 不在此列。）'
);
check(
  '落点模块不依赖需要 polyfill 的 API（ResizeObserver / IntersectionObserver）',
  moduleExists && !/ResizeObserver|IntersectionObserver/.test(scrollCode),
  'src/search-scroll.ts 里出现了 ResizeObserver / IntersectionObserver：' +
  '目标浏览器（Chrome 60+ / iOS Safari 12+）不支持，需 polyfill，违反零 polyfill 约束。'
);
check(
  '落点模块不使用 ES2019+ 特性（Array.flat / flatMap / Object.fromEntries）',
  moduleExists && !/\.flat\s*\(|\.flatMap\s*\(|Object\.fromEntries/.test(scrollCode),
  'src/search-scroll.ts 里出现了 ES2019+ 特性：' +
  'build target 是 ES2017，这些语法在目标浏览器上会直接报错。'
);

// —— 报告 ——
if (failures.length > 0) {
  console.error('编辑器搜索匹配落点与揭示滚动回归验证失败：\n');
  failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}\n`));
  console.error(`共 ${failures.length} 项不一致。`);
  process.exit(1);
}

console.log('编辑器搜索匹配落点与揭示滚动回归验证：全部通过');
console.log('  - 搜索配置被接管，且接管不沿用默认的贴边滚动');
console.log('  - 首个匹配落点为视口垂直居中');
console.log('  - 后续匹配贴着来向边缘并留出间距（揭示「上来一点点」）');
console.log('  - 首个 / 后续按查询标识判定');
console.log('  - 揭示滚动由 rAF 逐帧推进、ease-out cubic、时长随距离缩放');
console.log('  - 滚轮 / 触摸 / 键盘可立即打断动画');
console.log('  - prefers-reduced-motion 降级为直接落位');
console.log('  - 先派发 scrollIntoView 再取实测坐标，最后改写 scrollTop');
console.log('  - 匹配已完整可见时不滚动');
console.log('  - 搜索面板打开时清空状态里的查询');
console.log('  - 落点逻辑独立成模块，主逻辑只做接线，无 polyfill 与 ES2019+ 特性');
console.log('\n注意：本脚本是源码层代理断言，无法证明浏览器行为。');
console.log('落点与揭示动效仍需按 docs/agents/browser-checklist-search-reveal-scroll.md 人工实测。');
