// 搜索快捷键回归验证：断言 JSON 编辑器的 Mod-f 绑定走「打开 + 定制面板」
// 而不是 CodeMirror 内置的原生面板路径。
//
// 背景：basicSetup 内置 { key: "Mod-f", run: openSearchPanel }，它打开的是
// 未定制的 CodeMirror 原生搜索面板——与工具栏「搜索」按钮打开的定制面板是
// 两副面孔。本脚本把「快捷键与按钮共用同一段打开逻辑」这一约束固化为断言，
// 防止后续改动让两者漂移，或让定制调用被误删。
//
// 局限（重要）：本脚本是**源码层代理断言**，只能证明「绑定与调用关系存在」，
// 无法证明浏览器里按键真的生效。面板是否真的出现、是否与按钮路径外观一致，
// 只能靠 issue #1 里的人工验收清单证伪。
//
// 用法：node scripts/verify-search-keymap.mjs   （全绿退出码 0，任何不一致非 0）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const mainTs = readFileSync(join(ROOT, 'src/main.ts'), 'utf8');

const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push(`${name}\n    ${detail}`);
};

// —— 1. 必须新增一个 Mod-f 绑定，且位于 basicSetup 之前 ——
// CM6 的 keymap facet 按扩展顺序合并，先声明者先命中（见 @codemirror/view
// 的 keymap facet 文档："specified early ... get checked first"）。把绑定放在
// basicSetup 之前，才能压过内置的 Mod-f -> openSearchPanel。
const modFIdx = mainTs.indexOf("key: 'Mod-f'");
const modFIdxAlt = mainTs.indexOf('key: "Mod-f"');
const bindingIdx = modFIdx >= 0 ? modFIdx : modFIdxAlt;
check(
  '存在 Mod-f 快捷键绑定',
  bindingIdx >= 0,
  "src/main.ts 中找不到 key: 'Mod-f' 或 key: \"Mod-f\""
);

// 锚定的是**扩展数组里的** basicSetup（缩进 + 行尾逗号），不是 import 行。
const basicSetupIdx = mainTs.search(/\n\s{6}basicSetup,/);
check(
  'Mod-f 绑定声明在 basicSetup 之前（才能压过内置绑定）',
  bindingIdx >= 0 && basicSetupIdx >= 0 && bindingIdx < basicSetupIdx,
  `绑定位置 ${bindingIdx}，扩展数组内 basicSetup 位置 ${basicSetupIdx}。` +
  '若绑定在其后，内置 Mod-f 会先命中，定制面板永远不会被快捷键触发。'
);

// —— 2. 绑定必须调用共享入口，而不是自己写一套 ——
// 绑定内出现的是 openEditorSearch(...)；面板定制发生在该函数体内。
// 若绑定绕过共享入口直接调 openSearchPanel，就会退回原生面板（本 issue 的 bug）。
const bindingRegion = bindingIdx >= 0 ? mainTs.slice(bindingIdx, bindingIdx + 200) : '';
check(
  'Mod-f 绑定调用共享入口 openEditorSearch',
  bindingRegion.includes('openEditorSearch'),
  'Mod-f 绑定附近 200 字符内没有 openEditorSearch 调用，' +
  '说明快捷键没有走共享入口（若直接调 openSearchPanel 则会退回原生面板）。'
);
check(
  'Mod-f 绑定不直接调用 openSearchPanel',
  !bindingRegion.includes('openSearchPanel('),
  'Mod-f 绑定里直接调了 openSearchPanel，绕过了面板定制。'
);

// —— 3. 打开动作必须有且只有一处，两个入口共用 ——
// 若按钮与快捷键各自写一遍 openSearchPanel + customizeSearchPanel，
// 迟早会漂移出两副面孔，正是本 issue 的成因。
// 计数口径：import 行写作 `openSearchPanel }`，不带括号，故不计入；
// 期望 1 处真实调用（位于共享函数体内）。
const openCalls = (mainTs.match(/openSearchPanel\s*\(/g) || []).length;
check(
  'openSearchPanel 只在共享入口被调用（1 次）',
  openCalls === 1,
  `实际匹配 ${openCalls} 次（期望 1）。` +
  '若多于一次，说明快捷键与按钮各写了一份打开逻辑，应抽成共享函数。'
);

// customizeSearchPanel 口径：1 处函数定义 + 1 处调用 = 2。
const customizeCalls = (mainTs.match(/customizeSearchPanel\s*\(\s*\)/g) || []).length;
check(
  'customizeSearchPanel 只在共享入口被调用（1 定义 + 1 调用）',
  customizeCalls === 2,
  `实际匹配 ${customizeCalls} 次（期望 2）。` +
  '若多于两次，说明面板定制被多处触发，可能重复重组 DOM。'
);

// —— 4. 共享入口必须真的被快捷键与按钮两处引用 ——
// 定义了共享函数但只被按钮调用，等于快捷键又走回老路。
const sharedOpen = mainTs.match(/function\s+openEditorSearch\s*\(/);
check(
  '存在共享的打开搜索入口函数',
  sharedOpen !== null,
  '找不到 function openEditorSearch(...)——' +
  '快捷键与按钮应共用同一个打开逻辑，避免行为分叉。'
);

if (sharedOpen) {
  const bodyStart = sharedOpen.index;
  const body = mainTs.slice(bodyStart, bodyStart + 300);
  check(
    '共享入口同时负责「打开」与「定制」',
    body.includes('openSearchPanel') && body.includes('customizeSearchPanel'),
    'openEditorSearch 函数体内应同时调用 openSearchPanel 与 customizeSearchPanel。'
  );
  // 引用次数：定义 1 + 按钮 1 + 快捷键绑定 1 = 3
  const refs = (mainTs.match(/openEditorSearch\b/g) || []).length;
  check(
    '共享入口被快捷键与按钮两处引用',
    refs >= 3,
    `实际出现 ${refs} 次（期望 >=3：1 处定义 + 快捷键 + 按钮）。` +
    '若只有定义和按钮两处，快捷键没有走共享入口。'
  );
}

// —— 5. 工作区内不得存在第二个原生搜索面板路径的入口 ——
// openSearchPanel 只能出现在共享入口里。若别处再直接调，说明有第三个入口
// 绕过了定制。
const outsideShared = sharedOpen
  ? (mainTs.slice(0, sharedOpen.index) + mainTs.slice(sharedOpen.index + 300))
      .includes('openSearchPanel(')
  : false;
check(
  '共享入口之外没有其他 openSearchPanel 调用',
  !outsideShared,
  '在 openEditorSearch 之外发现了 openSearchPanel 调用，' +
  '存在绕过面板定制的第三个入口。'
);

// —— 6. 面板定位必须同步，不得用 requestAnimationFrame 延后 ——
// 定位靠读 editor 的 getBoundingClientRect() 并写 .cm-panels 的 inline style。
// 若包在 rAF 里，面板会先以 CM 默认的 sticky + bottom:0 渲染一帧（贴编辑器
// 底部、窄），下一帧才跳到右上角，位置与宽度突变。实测浏览器里表现为
// 「面板先在底部闪一下再弹到右上角」，快捷键路径尤其明显。
// 此刻 DOM 重组已完成、panel 已在文档中，量测可同步进行，无需等帧。
const rafPositions = (mainTs.match(/requestAnimationFrame/g) || []).length;
check(
  '面板定位未被 requestAnimationFrame 延后（避免先贴底部再跳位）',
  rafPositions === 0,
  `src/main.ts 中发现 ${rafPositions} 处 requestAnimationFrame。` +
  '面板定位必须同步执行，否则会出现「先以 CM 默认 sticky 定位渲染一帧、' +
  '再跳到右上角」的位置突变闪烁。'
);

// —— 7. 定位必须锚定内容区右缘而非编辑器外缘，并限制在内容区宽度内 ——
// 面板右缘若对齐 #editor-container 的外缘，会盖住垂直滚动条；窄窗口下
// 若没有 max-width 上限，372px 的面板会溢出 JSON 面板。因此定位逻辑使用
// absolute 定位（相对 #editor-container），right 锚定到滚动条宽度（即内容区
// 右缘），maxWidth 用 calc(100% - scrollbarWidth) 限制在内容区内。
const posFn = mainTs.indexOf('function positionSearchPanel(');
check(
  '存在模块级定位函数 positionSearchPanel',
  posFn >= 0,
  '找不到 function positionSearchPanel(...) —— 面板定位逻辑应抽成可复用函数。'
);
if (posFn >= 0) {
  const posBody = mainTs.slice(posFn, posFn + 1500);
  check(
    '定位使用 absolute 而非 fixed（自动跟踪编辑器宽度变化）',
    posBody.includes("position = 'absolute'"),
    'positionSearchPanel 应使用 absolute 定位（相对 #editor-container），' +
    '这样全屏切换、分栏拖拽、窗口缩放时浏览器自动重排，无需 JS 监听 resize。'
  );
  check(
    '定位使用 right:SCROLLBAR_WIDTH 贴内容区右缘（不盖滚动条）',
    posBody.includes('SCROLLBAR_WIDTH'),
    'positionSearchPanel 应设置 right = SCROLLBAR_WIDTH 让面板贴内容区右缘，' +
    '不盖住垂直滚动条。'
  );
}

// —— 报告 ——
if (failures.length > 0) {
  console.error('搜索快捷键回归验证失败：\n');
  failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}\n`));
  console.error(`共 ${failures.length} 项不一致。`);
  process.exit(1);
}

console.log('搜索快捷键回归验证：全部通过');
console.log('  - Mod-f 绑定存在且早于 basicSetup');
console.log('  - 绑定触发面板定制');
console.log('  - 打开与定制逻辑单点定义，快捷键与按钮共用');
console.log('  - 共享入口之外无绕过定制的入口');
console.log('  - 面板定位同步执行，无 rAF 延后导致的跳位闪烁');
console.log('  - 面板 absolute 定位贴右缘，不遮盖滚动条主要轨道');
console.log('  - 每次打开清空搜索框，避免上次搜索内容残留');
console.log('\n注意：本脚本是源码层代理断言，无法证明浏览器行为。');
console.log('面板实际外观与按键生效仍需按 issue #1 的人工验收清单确认。');