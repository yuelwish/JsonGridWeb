/**
 * 编辑器搜索面板的匹配计数。
 *
 * 数据只能来自文档本身，不能数已渲染的高亮 span：CodeMirror 只为视口区域渲染
 * 匹配高亮（外加一点余量），滚动之后才补齐。数 DOM 会让同一个查询先报
 * 「1 of 1」、按一次「下一个」又变成「1 of 9」——总量随视口漂移，序号也只在
 * 已渲染的那几个里面数，两个数字都不可信。
 *
 * 「当前是第几个」按当前选区判定：CodeMirror 的 findNext / findPrevious 会把选区
 * 落到匹配上，选中态的匹配高亮也是按「选区范围等于匹配范围」着色，两者同一口径。
 */
import { getSearchQuery } from '@codemirror/search';
import type { SearchQuery } from '@codemirror/search';
import type { Text } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';

export interface MatchInfo {
  /** 整篇文档里的匹配总数 */
  total: number;
  /** 当前匹配的序号（从 1 起；0 表示选区没有落在任何匹配上） */
  index: number;
  /** 是否存在查询（用于「无匹配」红框判定，空查询不算错） */
  hasQuery: boolean;
}

/**
 * 上一次的计算结果。
 *
 * 遍历整篇文档是 O(文档长度)，而面板每敲一个键、每按一次「下一个」都会触发
 * 重算。文档对象与查询都没变时直接复用：CodeMirror 的状态不可变，文档没改过
 * 就是同一个对象。
 */
let cached: { query: SearchQuery; doc: Text; from: number; to: number; info: MatchInfo } | null = null;

/** 计算整篇文档的匹配总数与当前匹配序号 */
export function editorMatchInfo(state: EditorState): MatchInfo {
  const query = getSearchQuery(state);
  const hasQuery = query.search.length > 0;
  // 查询非法（例如正则没写完）时遍历会抛错，按「无匹配」处理，红框由调用方显示。
  if (!hasQuery || !query.valid) return { total: 0, index: 0, hasQuery };

  const sel = state.selection.main;
  const reuse = cached;
  if (
    reuse !== null &&
    reuse.doc === state.doc &&
    reuse.from === sel.from &&
    reuse.to === sel.to &&
    reuse.query.eq(query)
  ) {
    return reuse.info;
  }

  let total = 0;
  let index = 0;
  const cursor = query.getCursor(state);
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total++;
    if (next.value.from === sel.from && next.value.to === sel.to) index = total;
  }

  const info: MatchInfo = { total, index, hasQuery };
  cached = { query, doc: state.doc, from: sel.from, to: sel.to, info };
  return info;
}
