/*
 * 文件名: feedHygiene.ts
 * 描述: 订阅源「清理」的判定逻辑（纯函数，便于单独验证 —— 与 lib/menuPosition.ts 同套路）
 *
 * 用途：一键找出该清理的订阅源，交给列表的多选删除去执行。
 * 两类目标，判定口径不同：
 *
 * 1. 刷新失败（failed）：最近一次刷新失败的源。判定**只看当前状态**（下一次刷新成功即自动消失），
 *    严重程度用连续失败次数展示给用户看 —— 见下方 isFailedFeed 的说明（曾用计数做门槛，是错的）。
 * 2. 长期不更新（stale）：以「最新一篇文章的时间」为基准，**没有文章的源退回用订阅时间**——
 *    否则刚订阅、还没抓到首篇文章的新源会被立刻判成「不更新」。
 */
import type { Article, Feed } from "../features/rss/types";

/** 「长时间不更新」可选的天数档位（从「一个季度没动静」到「整年没动静」） */
export const STALE_DAY_OPTIONS = [30, 60, 90, 180, 365] as const;

/**
 * 默认档位：365 天。
 * 「清理订阅源」不可撤销，默认取最保守的一档 —— 只挑真正整年没动静的源，
 * 用户想放宽再自己往下调。
 */
export const DEFAULT_STALE_DAYS = 365;

/**
 * 「刷新失败」的判定：**最近一次刷新是失败的**（last_error 非空）。
 *
 * 这里曾经要求「连续失败 ≥ 3 次」以躲开网络抖动，结果是按钮在功能上线后**一直是灰的**：
 * 存量数据里没有历史次数，必须连着刷三次才亮，看起来就是坏的。
 * 改成按「当前是否失败」判定，严重程度改为**展示**连续失败次数（列表里标「失败 N 次」），
 * 让用户自己判断该不该删；删除前还有一次确认弹窗兜底。
 *
 * 它是自愈的：下一次刷新成功会把 last_error 清掉，所以偶发抖动不会长期赖在列表里。
 */
export function isFailedFeed(feed: Feed): boolean {
  return (feed.last_error ?? null) !== null;
}

/** 失败次数的人话标签：只有一次就说「刷新失败」，多于一次带上次数 */
export function failLabel(feed: Feed): string {
  const n = feed.fail_count ?? 0;
  return n > 1 ? `失败 ${n} 次` : "刷新失败";
}

/** 坏源列表（顺序与入参一致，方便按列表顺序展示） */
export function failedFeeds(feeds: readonly Feed[]): Feed[] {
  return feeds.filter(isFailedFeed);
}

/** 解析时间戳为毫秒；解析不出来返回 null（脏数据不该让整个判定崩掉） */
function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/**
 * 一次遍历算出「每个源最新一篇文章的时间」。
 * 不按源逐个扫全量文章：文章动辄上万条、源上百个，那样是 O(源 × 文章)。
 */
export function newestArticleTimeByFeed(articles: readonly Article[]): Map<string, number> {
  const newest = new Map<string, number>();
  for (const a of articles) {
    const t = parseTime(a.published_at);
    if (t === null) continue;
    const prev = newest.get(a.feed_id);
    if (prev === undefined || t > prev) newest.set(a.feed_id, t);
  }
  return newest;
}

/**
 * 某个源「最后一次有动静」的时间：
 * 有文章 → 最新一篇的发布时间；没有文章 → 订阅时间。
 * 两者都取不到时返回 null（调用方按「无法判定」处理，不当成不更新）。
 */
export function lastActivityAt(
  feed: Feed,
  newestByFeed: ReadonlyMap<string, number>,
): number | null {
  return newestByFeed.get(feed.id) ?? parseTime(feed.added_at);
}

/**
 * 长期不更新的源：最后一次有动静距 now 超过 days 天。
 * @param now 当前时间（毫秒），由调用方传入以便测试
 */
export function staleFeeds(
  feeds: readonly Feed[],
  articles: readonly Article[],
  days: number,
  now: number = Date.now(),
): Feed[] {
  const limit = days * 24 * 60 * 60 * 1000;
  const newestByFeed = newestArticleTimeByFeed(articles);
  return feeds.filter((feed) => {
    const last = lastActivityAt(feed, newestByFeed);
    if (last === null) return false; // 判定不了就不动它
    return now - last > limit;
  });
}
