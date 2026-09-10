/*
 * 文件名: feedOrder.ts
 * 描述: 「全部订阅源」列表的排序规则（纯函数，便于单独验证）
 *
 * 两种排序方式：
 * - `added`：按添加时间，可切换方向（`desc` 最新在前 / `asc` 最早在前）；
 * - `group`：按分组（分组本身的顺序 + 组内排序），未分组的排在最后。
 *
 * 注意 `feed.sort_order` 是**组内**序号（每个分组都从 0 开始），
 * 不能拿它做全局排序 —— 那样会把同一分组拆散。
 */
import type { Feed, Group } from "../features/rss/types";

export type FeedSortMode = "added" | "group";
export type FeedSortDirection = "desc" | "asc";

/**
 * 订阅源在组内的移动档位。
 * 界面（「分组与排序」页签）只发 "top" / "bottom"：逐格移动已改为拖拽排序；
 * "up" / "down" 作为纯函数能力保留（配合 `beforeId` 表达插入位置）。
 */
export type FeedMovePosition = "up" | "down" | "top" | "bottom";

/**
 * 重排组内顺序：把 `feedId` 移到目标位置，返回重新编号后的数组。
 * 返回 null 表示无需变更（下标越界、原地不动、或找不到该源）。
 * `sort_order` 是组内序号，因此这里只处理同组，并统一重新编号 0..n-1。
 */
export function reorderFeedsInGroup(
  groupFeeds: Feed[],
  feedId: string,
  position: FeedMovePosition,
  beforeId?: string | null,
): Feed[] | null {
  const idx = groupFeeds.findIndex((f) => f.id === feedId);
  if (idx === -1) return null;

  let targetIdx: number;
  if (beforeId !== undefined && beforeId !== null) {
    const dropIdx = groupFeeds.findIndex((f) => f.id === beforeId);
    if (dropIdx === -1 || dropIdx === idx) return null;
    // 自身先移除，插入位置随之前移
    targetIdx = dropIdx > idx ? dropIdx - 1 : dropIdx;
  } else if (position === "top") {
    targetIdx = 0;
  } else if (position === "bottom") {
    targetIdx = groupFeeds.length - 1;
  } else {
    targetIdx = position === "up" ? idx - 1 : idx + 1;
  }
  if (targetIdx < 0 || targetIdx >= groupFeeds.length || targetIdx === idx) return null;

  const next = [...groupFeeds];
  const [moved] = next.splice(idx, 1);
  next.splice(targetIdx, 0, moved);
  return next.map((f, i) => ({ ...f, sort_order: i }));
}

/** 未分组（或者分组已被删除）时的排序位置：排在所有分组之后 */
function groupRank(groupId: string | null, groups: Group[]): number {
  if (groupId === null) return groups.length;
  const index = groups.findIndex((g) => g.id === groupId);
  return index === -1 ? groups.length : index;
}

/** 分组槽位：先按分组先后，组内再按 sort_order */
function compareByGroup(a: Feed, b: Feed, groups: Group[]): number {
  return groupRank(a.group_id, groups) - groupRank(b.group_id, groups) || a.sort_order - b.sort_order;
}

/** 时间戳：无法解析时按 0 处理，保证排序结果稳定 */
function addedTime(feed: Feed): number {
  const ts = Date.parse(feed.added_at);
  return Number.isNaN(ts) ? 0 : ts;
}

/**
 * 返回排好序的新数组（不修改入参）。
 * `direction` 只影响「按添加时间」；时间相同（或缺失）时退回分组 + 组内顺序，避免顺序抖动。
 */
export function sortFeeds(
  feeds: Feed[],
  groups: Group[],
  mode: FeedSortMode,
  direction: FeedSortDirection = "desc",
): Feed[] {
  const next = [...feeds];
  if (mode === "added") {
    const sign = direction === "asc" ? 1 : -1;
    next.sort((a, b) => sign * (addedTime(a) - addedTime(b)) || compareByGroup(a, b, groups));
    return next;
  }
  next.sort((a, b) => compareByGroup(a, b, groups));
  return next;
}

/**
 * 「分组与排序」用的顺序：分组先后 + 组内 `sort_order`。
 *
 * 与 `sortFeeds(feeds, groups, "group")` 的区别是**不看**「按添加时间」偏好 ——
 * 那个偏好只描述「订阅源」页签希望怎么浏览，而排序页签展示的就是用户排出来的真实顺序。
 * 若这里跟着偏好走，用户在「按添加时间」下点置顶/置底/拖动，界面顺序会被时间戳覆盖，
 * 看起来就是「点了没反应」。
 */
export function sortFeedsByGroupOrder(feeds: Feed[], groups: Group[]): Feed[] {
  return sortFeeds(feeds, groups, "group");
}

/**
 * 按名称过滤订阅源（大小写不敏感、忽略首尾空白）。
 * 命中范围：显示名（标题）与订阅地址 —— 订阅源常常没有标题，只按标题搜会搜不到。
 * 空关键字返回原数组（不做任何拷贝）。
 */
export function filterFeedsByName(feeds: Feed[], query: string): Feed[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return feeds;
  return feeds.filter((feed) => {
    const title = (feed.title ?? "").toLowerCase();
    const url = (feed.url ?? "").toLowerCase();
    return title.includes(keyword) || url.includes(keyword);
  });
}
