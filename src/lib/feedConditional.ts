/*
 * 文件名: feedConditional.ts
 * 描述: 条件请求（ETag / Last-Modified）与本地缓存的一致性判断
 *
 * 背景：抓取走 `If-None-Match` / `If-Modified-Since`，服务端回 304 就跳过下载解析。
 * 这个前提是「本地文章没被清过」。本地文章被清理后条件请求头还在，只靠条件请求每次都是
 * 304「无更新」，被清掉的文章永远取不回来——所以「取回」需要一个明确的入口与判据。
 *
 * 判据用水位线 `peak_article_count`（该源本地文章数的历史最高值）：
 *   本地篇数 < 水位线 → 说明被清理过（或文章被删过）→ 单源「刷新」忽略条件请求完整重抓一次。
 *   水位线为 0（旧数据、刚导入还没抓过）时退化为原来的规则：只有「本地 0 篇 + 304」才重抓。
 *
 * 分工（按用户约定：**只有单源的「刷新」会重新完整抓取**）：
 * - 单源「刷新」：命中上述判据就完整重抓，是取回被清理文章的唯一入口；
 * - 「刷新所有订阅源」：不做这件事，304 就跳过，保持增量更新（多源全量下载明显更慢，
 *   也会把刚清理掉的旧文章整批拉回列表）；它只负责把水位线抬到当前篇数；
 * - 「清理缓存」：刻意不动 ETag / Last-Modified，否则下次标题栏刷新会变成全量下载、
 *   把清掉的旧文章拉回来；它只把受影响源的水位线抬到「清理前」的篇数，留下被清理过的痕迹。
 */
import type { Feed, FetchResult } from "../features/rss/types";

/**
 * 该源是否应该忽略条件请求、完整重抓一次。
 *
 * 两种情况：
 * 1. 本地篇数低于水位线（被清理过）——即使还剩几篇新文章，也要把清掉的那部分补回来；
 * 2. 本地一篇都没有却收到 304（水位线缺失时的兜底：自相矛盾的回包）。
 * 仅用于单源刷新路径；`localArticleCount` 是该源在本地的文章数（不是本次抓取结果里的条数）。
 */
export function shouldRefetchInFull(
  result: FetchResult,
  feed: Pick<Feed, "peak_article_count">,
  localArticleCount: number,
): boolean {
  if (!result.not_modified) return false;
  const peak = feed.peak_article_count ?? 0;
  if (peak > localArticleCount) return true;
  return localArticleCount === 0;
}

/**
 * 抓取成功后抬高水位线：该源本地篇数多于历史最高值时就记下来。
 * 返回新的 feeds 数组；没有变化时返回原引用（调用方据此判断是否需要写盘）。
 */
export function recordPeakCounts(feeds: Feed[], articles: { feed_id: string }[]): Feed[] {
  const counts = new Map<string, number>();
  for (const a of articles) counts.set(a.feed_id, (counts.get(a.feed_id) ?? 0) + 1);
  if (counts.size === 0) return feeds;

  let changed = false;
  const next = feeds.map((feed) => {
    const count = counts.get(feed.id) ?? 0;
    if (count <= (feed.peak_article_count ?? 0)) return feed;
    changed = true;
    return { ...feed, peak_article_count: count };
  });
  return changed ? next : feeds;
}

/**
 * 清理缓存时抬高水位线：把水位线记到「清理后 + 被清掉」的篇数（即清理前的篇数，只升不降）。
 * 于是清理过后本地篇数必然低于水位线，单源「刷新」才知道该完整重抓。
 */
export function raisePeakAfterCleanup(
  feeds: Feed[],
  kept: { feed_id: string }[],
  removed: { feed_id: string }[],
): Feed[] {
  if (removed.length === 0) return feeds;
  const counts = new Map<string, number>();
  for (const a of kept) counts.set(a.feed_id, (counts.get(a.feed_id) ?? 0) + 1);
  for (const a of removed) counts.set(a.feed_id, (counts.get(a.feed_id) ?? 0) + 1);

  let changed = false;
  const next = feeds.map((feed) => {
    const count = counts.get(feed.id) ?? 0;
    if (count <= (feed.peak_article_count ?? 0)) return feed;
    changed = true;
    return { ...feed, peak_article_count: count };
  });
  return changed ? next : feeds;
}
