/**
 * 编辑器搜索的匹配落点与揭示滚动。
 *
 * 落点规则（验收口径见 docs/specs/2026-10-21-search-reveal-scroll.md）：
 * - 一次查询里**第一个**需要滚动的匹配：落在视口垂直居中，用户一眼看到被找到的内容；
 * - 同一查询的**后续**匹配：落在贴近视口底缘的位置，并从底缘升起一小段（向上查找时
 *   镜像到顶缘）。连续按「下一个」时，匹配逐次从下方冒出来，方向与操作一致。
 *
 * 为什么不沿用 CodeMirror 默认的匹配滚动（见 docs/adr/0002-search-match-reveal-scroll.md）：
 * 默认的 scrollToMatch 是 EditorView.scrollIntoView(range)，即 y:"nearest" 的贴边可见。
 * 虚拟滚动下未渲染区域只有估算块高，贴边会连带估算误差，把匹配甩到视口顶端之外
 * （实测落点 y=-20px，匹配被上边缘裁切、正好藏在搜索面板背后）。
 *
 * 接管走 CodeMirror 官方的 search({ scrollToMatch }) 扩展点，不改第三方库内部：
 * 接管函数只把目标位置交出来（自定义 effect），落点由本模块的视图插件算。
 *
 * 落点顺序是硬约束：先测量、后落位。未渲染区域只有估算块高，先算落点会算在估算值上
 * （这正是原缺陷的成因），所以必须等目标区域被渲染并实测之后再落位。
 */
import { EditorView, ViewPlugin } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';
import { StateEffect } from '@codemirror/state';
import { search, setSearchQuery, SearchQuery, getSearchQuery } from '@codemirror/search';

/** 匹配落点请求 */
interface RevealRequest {
  /** 目标匹配的文档位置 */
  pos: number;
  /**
   * 查询标识：查询变了，这次落点就算「首个匹配」。
   * 用查询内容而不是「第几次跳转」来判定，编辑查询后按「下一个」会重新从居中开始。
   */
  queryKey: string;
}

/**
 * 匹配落点请求：携带目标位置与查询标识。
 * 接管函数只交出目标，不直接返回 EditorView.scrollIntoView——那会让 CodeMirror
 * 的默认贴边滚动照旧发生，落点缺陷原样复现。
 */
const revealMatch = StateEffect.define<RevealRequest>();

/** 目标区域迟迟不被渲染时的最大重试帧数：超过就放弃落点修正，不再制造中间态 */
const MAX_REVEAL_FRAMES = 3;

/** 后续匹配与视口边缘留出的间距：视口高的 8%，至少一行（「上来一点点」的落点） */
const EDGE_MARGIN_RATIO = 0.08;

/**
 * 揭示动画时长。
 * 起点由实测坐标算出，恒为「匹配贴住来向边缘」，与落点只差留出的那段间距，
 * 因此距离基本固定，不需要按距离缩放。
 */
const REVEAL_MS = 180;

/**
 * 编辑器扩展：接管匹配滚动 + 落点插件。
 *
 * 副作用：search() 会把 CM 的搜索状态提前装到编辑器上（原先是打开面板时才装），
 * 于是 openSearchPanel 走「state 已存在」分支，用当前选中文本预填查询。
 * 这一条由 clearSearchQuery 收拾，见该函数注释。
 */
export const searchMatchScroll = [
  search({
    scrollToMatch: (range, view) => revealMatch.of({ pos: range.from, queryKey: queryKeyOf(view) })
  }),
  ViewPlugin.define((view) => new MatchScrollPlugin(view))
];

/**
 * 清空编辑器搜索的查询。
 *
 * 搜索状态提前存在后，openSearchPanel 会用当前选中文本预填查询。只清面板输入框的
 * 可见值是不够的：那会留下「框里空着、编辑器却按选中文本高亮」的错位。
 * 连状态里的查询一起清空，打开搜索面板就等于空查询。
 */
export function clearSearchQuery(view: EditorView): void {
  view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) });
}

/**
 * 查询标识：内容 + 三个选项位。
 * 只要用户改了查询（改词、切大小写、切正则、切整词），后续落点就重新算「首个匹配」。
 */
function queryKeyOf(view: EditorView): string {
  const query = getSearchQuery(view.state);
  return [
    query.search,
    query.caseSensitive ? 'c' : '',
    query.regexp ? 'r' : '',
    query.wholeWord ? 'w' : ''
  ].join('\u0000');
}

/** 用户是否要求减少动态效果 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** 揭示动画的逐帧状态 */
interface ScrollAnimation {
  from: number;
  to: number;
  startTime: number;
  duration: number;
}

/**
 * 匹配落点插件：消费 revealMatch effect，把匹配落到对应位置并驱动揭示滚动。
 */
class MatchScrollPlugin {
  /** 待落点的匹配（null 表示没有待办） */
  private pending: RevealRequest | null = null;
  /** 目标迟迟不可测时的重试帧数 */
  private waited = 0;
  /** 已注册的动画帧句柄（0 表示没有） */
  private frame = 0;
  /** 滚动前的位置：位置没变说明匹配本来就在视口内，不用滚 */
  private scrollTopBefore = 0;
  /** 上一次真正落位时用的查询标识：同一个查询的后续匹配走揭示滚动 */
  private lastQueryKey: string | null = null;
  /** 进行中的揭示动画（null 表示没有） */
  private animation: ScrollAnimation | null = null;

  private view: EditorView;

  constructor(view: EditorView) {
    this.view = view;
  }

  update(update: ViewUpdate) {
    let requested = false;
    for (let i = 0; i < update.transactions.length; i++) {
      const effects = update.transactions[i].effects;
      for (let j = 0; j < effects.length; j++) {
        const effect = effects[j];
        if (effect.is(revealMatch)) {
          this.pending = effect.value;
          this.waited = 0;
          this.scrollTopBefore = this.view.scrollDOM.scrollTop;
          requested = true;
        }
      }
    }
    // 只在真的收到落点请求时起步：插件的 update 跑在视图更新过程中，
    // 那时 dispatch 会抛「不允许在更新过程中更新视图」。
    if (requested) this.schedule();
  }

  destroy() {
    this.cancelAnimation();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  /**
   * 用微任务起步，而不是直接 dispatch：插件的 update 跑在视图更新过程中。
   * 微任务在本次交互彻底结束后才跑，此时编辑器的测量帧已经排好，我们的动画帧
   * 能排在它后面——于是落位发生在同一帧内，用户看不到中间的贴边态。
   */
  private schedule() {
    this.cancelAnimation();
    if (this.frame) return;
    Promise.resolve().then(() => this.reveal());
  }

  /**
   * 第一步：贴边滚动 + 记录滚动前的位置。
   *
   * 贴边滚动（y:"nearest"）只为一件事：把目标区域渲染出来。它落到的位置不可信
   * （未渲染区域只有估算块高），所以方向判定和动画起点都不用它的停靠位置。
   */
  private reveal() {
    const request = this.pending;
    if (request === null) return;
    // 匹配已经完整落在视口内：画面完全不动（不滚动，也不揭示）。
    if (isFullyVisible(this.view, request.pos)) {
      this.pending = null;
      return;
    }
    this.view.dispatch({ effects: EditorView.scrollIntoView(request.pos, { y: 'nearest' }) });
    // 动画帧排在编辑器的测量帧之后：那一帧里目标区域已经渲染并实测，
    // 贴边滚动也已落地，落位改写的 scrollTop 不会被随后的贴边滚动覆盖。
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.land();
    });
  }

  /**
   * 第二步：算落点并落位。
   *
   * 落点取的是目标渲染之后的实测坐标：未渲染区域只有估算块高，用估算值算出来的
   * 落点会偏出视口（这正是原缺陷的成因）。
   */
  private land() {
    const request = this.pending;
    if (request === null) return;
    const scrollDOM = this.view.scrollDOM;
    const rect = this.view.coordsAtPos(request.pos);
    const scrolled = scrollDOM.scrollTop !== this.scrollTopBefore;
    // 目标还没渲染出来，或贴边滚动还没落地：再等一帧。
    // （贴边滚动在 CodeMirror 的测量周期里生效，偶尔会比本帧晚一拍。）
    if ((rect === null || (!scrolled && !isInViewport(this.view, rect))) && this.waited < MAX_REVEAL_FRAMES) {
      this.waited++;
      this.view.dispatch({ effects: EditorView.scrollIntoView(request.pos, { y: 'nearest' }) });
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.land();
      });
      return;
    }
    if (rect === null) {
      this.pending = null;
      return;
    }
    // 滚动位置没变、目标也已在视口内：匹配本来就在视口内，不滚动。
    if (!scrolled) {
      this.pending = null;
      return;
    }

    const viewportRect = scrollDOM.getBoundingClientRect();
    const viewportHeight = scrollDOM.clientHeight;
    const block = this.view.lineBlockAt(request.pos);
    const blockHeight = block.height;
    const currentTop = rect.top - viewportRect.top;   // 匹配此刻在视口内的纵坐标
    const firstOfQuery = request.queryKey !== this.lastQueryKey;
    // 方向按「目标相对滚动前的位置」判定，不看贴边滚动把匹配甩到了哪：
    // 未渲染区域只有估算块高，贴边滚动的落点本身就可能偏出视口（实测偏上 77px），
    // 用它判方向会让向下查找的匹配落到顶缘。
    const cameFromBottom = block.top >= this.scrollTopBefore;
    const targetTop = firstOfQuery
      ? (viewportHeight - blockHeight) / 2               // 首个匹配：视口垂直居中
      : edgeLandingTop(cameFromBottom, viewportHeight, blockHeight);  // 后续匹配：贴近来向的那条边缘
    // 落点换算成滚动位置：视口内的纵坐标 = 区块内容坐标 - scrollTop
    const targetScrollTop = block.top - targetTop;

    this.lastQueryKey = request.queryKey;
    this.pending = null;

    // 只差半行、用户要求减少动态效果、或是首个匹配：直接落位，不做揭示动画。
    // 首个匹配要「出现在屏幕中间」，从边缘升起会让人以为落点在下半屏。
    if (firstOfQuery || prefersReducedMotion() || Math.abs(targetTop - currentTop) < blockHeight / 2) {
      scrollDOM.scrollTop = targetScrollTop;
      return;
    }
    // 揭示起点自己算：匹配正好贴在来向那边视口边缘。
    // 不能用贴边滚动停下的位置当起点——带折行的文档里，未渲染区域的估算偏差能到半屏，
    // 贴边滚动会把匹配甩到反方向（实测停在匹配上边 -20px），动画就变成「从顶部滑下来」。
    const startScrollTop = block.top - (cameFromBottom ? viewportHeight - blockHeight : 0);
    scrollDOM.scrollTop = startScrollTop;
    this.animateTo(targetScrollTop);
  }

  /**
   * 揭示滚动：从当前位置（贴边态）逐帧推进到落点。
   *
   * 缓动取 ease-out cubic（与源站 Ace 同族的曲线）：起步快、收尾稳，观感是
   * 「冒出来一点点」而不是匀速平移。
   */
  private animateTo(target: number) {
    const scrollDOM = this.view.scrollDOM;
    const from = scrollDOM.scrollTop;
    const animation: ScrollAnimation = { from, to: target, startTime: performance.now(), duration: REVEAL_MS };
    this.animation = animation;
    this.attachInterrupts();

    const step = () => {
      this.frame = 0;
      if (this.animation !== animation) return;
      const elapsed = performance.now() - animation.startTime;
      const progress = Math.min(1, elapsed / animation.duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      scrollDOM.scrollTop = animation.from + (animation.to - animation.from) * eased;
      if (progress < 1) {
        this.frame = requestAnimationFrame(step);
      } else {
        this.cancelAnimation();
      }
    };
    this.frame = requestAnimationFrame(step);
  }

  /** 用户一动手就交还控制权：滚轮、触摸、键盘都算接管意图 */
  private onUserScroll = () => {
    this.cancelAnimation();
  };

  private attachInterrupts() {
    this.view.scrollDOM.addEventListener('wheel', this.onUserScroll, { passive: true });
    this.view.scrollDOM.addEventListener('touchstart', this.onUserScroll, { passive: true });
    this.view.contentDOM.addEventListener('keydown', this.onUserScroll);
  }

  private cancelAnimation() {
    if (!this.animation) return;
    this.animation = null;
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.view.scrollDOM.removeEventListener('wheel', this.onUserScroll);
    this.view.scrollDOM.removeEventListener('touchstart', this.onUserScroll);
    this.view.contentDOM.removeEventListener('keydown', this.onUserScroll);
  }
}

/**
 * 后续匹配的落点：贴近来向的那条边缘，但留出一段间距。
 *
 * 连续按「下一个」时匹配从下方来，落点贴近底缘、朝视口内部退开一段（视口高的 8%，
 * 至少一行）：匹配因此完整可见，又能看出它是从哪个方向冒出来的——这就是
 * 「在最下方上来一点点」。向上查找时镜像到顶缘。
 */
function edgeLandingTop(cameFromBottom: boolean, viewportHeight: number, blockHeight: number): number {
  const margin = Math.max(blockHeight, Math.round(viewportHeight * EDGE_MARGIN_RATIO));
  return cameFromBottom ? viewportHeight - margin - blockHeight : margin;
}

/** 目标是否落在视口可视范围内 */
function isInViewport(view: EditorView, rect: { top: number; bottom: number }): boolean {
  const viewportRect = view.scrollDOM.getBoundingClientRect();
  return rect.top >= viewportRect.top && rect.bottom <= viewportRect.bottom;
}

/**
 * 匹配是否已经完整落在视口内。
 *
 * 视口外的匹配才需要落点；已经完整可见的匹配画面完全不动（规格：匹配已经在视口内
 * 时完全不动）。目标没被渲染时 coordsAtPos 返回 null，视为不可见。
 */
function isFullyVisible(view: EditorView, pos: number): boolean {
  const rect = view.coordsAtPos(pos);
  if (rect === null) return false;
  return isInViewport(view, rect);
}
