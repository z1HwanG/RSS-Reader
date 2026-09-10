/*
 * 文件名: articleDedupe.ts
 * 描述: 文章按 id 去重（读取旧状态时的自愈）
 *
 * 为什么需要：entry_key 是 v0.3.2 才加进 state.json 的字段，此前写入的文章没有它。
 * 抓取侧的去重是「按 entry_key → 链接 → 标题 建已知集合」，而老行的 entry_key 缺失时
 * 只有链接可用；一旦订阅源 URL 变更导致文章被按新 feed_id 重算 id，同一条目就会以同一个
 * id 留下两条记录（一条有 entry_key、一条为 null）。
 *
 * 同一个 id 出现两次会直接破坏渲染：React 的 key 撞车后协调过程不会清理上一次的
 * DOM 节点，列表里就会混进其他订阅源的文章（表现为「选了源但列表没变」）。
 * 因此这里在状态载入时做一次合并 + 持久化。
 */
import type { Article } from "../features/rss/types";

/** 合并同 id 的两条记录：字段尽量取「更有信息」的那一份 */
function mergeArticle(current: Article, incoming: Article): Article {
  return {
    ...current,
    // entry_key 有值优先：它同时影响去重与 URL 变更后的 id 重算
    entry_key: current.entry_key ?? incoming.entry_key,
    // 用户数据取并集，避免合并时丢掉已读 / 收藏
    read: current.read || incoming.read,
    starred: current.starred || incoming.starred,
    published_at: current.published_at ?? incoming.published_at,
    content: current.content ?? incoming.content,
    title: current.title ?? incoming.title,
    link: current.link ?? incoming.link,
  };
}

/**
 * 按 id 去重。返回新数组；若没有重复则返回 null（调用方据此判断是否需要回写磁盘）。
 */
export function dedupeArticlesById(articles: Article[]): Article[] | null {
  const seen = new Map<string, Article>();
  let changed = false;
  for (const article of articles) {
    const existing = seen.get(article.id);
    if (existing === undefined) {
      seen.set(article.id, article);
      continue;
    }
    changed = true;
    seen.set(article.id, mergeArticle(existing, article));
  }
  return changed ? [...seen.values()] : null;
}
