# 编辑器搜索的匹配滚动自行实现，不复用编辑器默认的贴边滚动

「编辑器搜索面板」的匹配跳转到视口外时，本项目自行接管滚动：匹配落在视口垂直居中，入场路径是「从视口底缘升起 → 居中」的渐次滚动。不用 CodeMirror 搜索默认的 `scrollToMatch`（其行为是 `EditorView.scrollIntoView(range)`，即 `y: "nearest"` 的贴边可见）——它不居中，而且在虚拟滚动的估算块高下会把匹配甩到视口顶端之外（实测落点 -20px，匹配被上边缘裁切）。

## Considered Options

- **完全照抄源站 Ace 的落点**（`revealRange(range, .5)`，实测首个匹配居中、后续匹配贴底缘）：只取「居中」这一确定性结果。Ace 的贴底缘是第二次滚动调用拿到过期滚动值造成的副作用，不是设计意图。
- **让远距离匹配全程无跳变**（逐行渲染几千行）：CodeMirror 对未渲染区域只有估算块高，逐帧渲染会卡顿且画面抖动。接受「内容区域瞬移 + 匹配渐次揭示」，并把它记为已知限制。
- **用浏览器原生平滑滚动**（CSS `scroll-behavior: smooth`）：目标浏览器含 iOS Safari 12+，该属性 15.4 才支持，违反零 polyfill 约束。改为自行用 requestAnimationFrame 驱动。

## Consequences

- 匹配滚动逻辑独立成模块，通过 CodeMirror 官方的 `search({ scrollToMatch })` 扩展点接管，不改第三方库内部。
- 关键约束是「先测量、后落位、再动画」：目标区域未实测前算出的落点是估算值，这正是原缺陷的成因。
- 源站本身没有动画（Ace 的 `animatedScroll` 实测为 false，默认关闭），渐次揭示是本项目的增强项而非复刻。
