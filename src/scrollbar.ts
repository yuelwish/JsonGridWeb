/**
 * 左侧编辑器自绘滚动条
 *
 * 为什么不用原生滚动条：CodeMirror 6 虚拟滚动只渲染视口附近的行，未渲染区用
 * .cm-gap 占位、块高是估算值。滚到新区域时估算被实测高度替换，文档总高度
 * （scrollHeight）随之突变；Chrome 原生滚动条在这种突变中会丢掉一次 mousemove，
 * 拖拽位置因此滞后一拍——鼠标已拖到顶端，滚动条还停在半路。
 *
 * 这里自绘一条：拖拽映射基于按下瞬间的滚动范围快照，拖拽期间高度变化不再影响
 * 映射，滚动始终与鼠标 1:1。原生滚动条在 CSS 中隐藏，滚轮/键盘滚动照常可用。
 */

/** 自绘滚动条宽度（同时是 .cm-scroller 的 padding-right，让内容区让出这条） */
export const EDITOR_SCROLLBAR_WIDTH = 12;

/** thumb 最小高度，避免内容极长时 thumb 细到无法抓取 */
const MIN_THUMB = 24;

/**
 * 在 CodeMirror 滚动容器内挂一条自绘滚动条。
 *
 * @param scroller CodeMirror 的 scrollDOM（.cm-scroller）
 */
export function initEditorScrollbar(scroller: HTMLElement): void {
  const bar = document.createElement('div');
  bar.className = 'cm-scrollbar';
  const thumb = document.createElement('div');
  thumb.className = 'cm-scrollbar-thumb';
  bar.appendChild(thumb);
  // bar 不能挂在 scroller 里：绝对定位的后代会随滚动内容一起滚走。
  // 挂在 .cm-editor（position: relative，不滚动）上才能固定在可视区右缘。
  const host = scroller.parentElement || scroller;
  host.appendChild(bar);

  /** 拖拽期间使用的滚动范围快照：高度突变不影响映射 */
  let dragRange = 0;
  /** 按下点相对 thumb 顶部的偏移 */
  let dragGrab = 0;
  let dragging = false;
  /** 更新合并到下一帧，避免 CM6 高频重渲染时反复触发布局 */
  let pending = false;

  const trackHeight = (): number => bar.clientHeight;

  const update = (): void => {
    const view = scroller.clientHeight;
    const content = scroller.scrollHeight;
    if (content <= view) {
      thumb.style.display = 'none';
      return;
    }
    thumb.style.display = '';
    const track = trackHeight();
    const height = Math.max(MIN_THUMB, Math.round((track * view) / content));
    thumb.style.height = height + 'px';
    // 拖拽中 thumb 跟随鼠标，由 onMouseMove 定位，这里不抢
    if (dragging) return;
    const maxTop = Math.max(0, track - height);
    const ratio = Math.min(1, Math.max(0, scroller.scrollTop / (content - view)));
    thumb.style.top = Math.round(ratio * maxTop) + 'px';
  };

  const scheduleUpdate = (): void => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      update();
    });
  };

  const onThumbDown = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const rect = thumb.getBoundingClientRect();
    dragGrab = e.clientY - rect.top;
    dragRange = scroller.scrollHeight - scroller.clientHeight;
    dragging = true;
    thumb.classList.add('cm-scrollbar-thumb--active');
  };

  const onMouseMove = (e: MouseEvent): void => {
    if (!dragging) return;
    const track = trackHeight();
    const height = thumb.offsetHeight;
    const maxTop = Math.max(0, track - height);
    let top = e.clientY - bar.getBoundingClientRect().top - dragGrab;
    if (top < 0) top = 0;
    if (top > maxTop) top = maxTop;
    thumb.style.top = Math.round(top) + 'px';
    scroller.scrollTop = dragRange > 0 ? (top / maxTop) * dragRange : 0;
  };

  const onMouseUp = (): void => {
    if (!dragging) return;
    dragging = false;
    thumb.classList.remove('cm-scrollbar-thumb--active');
  };

  /** 点击轨道空白处：按可视高度翻页（原生滚动条的同款行为） */
  const onBarDown = (e: MouseEvent): void => {
    e.preventDefault();
    const rect = thumb.getBoundingClientRect();
    const dir = e.clientY < rect.top ? -1 : 1;
    scroller.scrollTop += dir * scroller.clientHeight;
  };

  thumb.addEventListener('mousedown', onThumbDown);
  bar.addEventListener('mousedown', onBarDown);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  scroller.addEventListener('scroll', scheduleUpdate);
  // CM6 修正文档总高度时 thumb 比例要跟着变
  const observer = new MutationObserver(scheduleUpdate);
  observer.observe(scroller, {
    attributes: true,
    attributeFilter: ['style'],
    childList: true,
    subtree: true
  });

  update();
}
