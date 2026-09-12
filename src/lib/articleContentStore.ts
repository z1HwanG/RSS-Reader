/*
 * 文件名: articleContentStore.ts
 * 描述: 文章正文的会话级缓存与按需加载。存储 v5 起正文与元数据分离：
 *       前端 state 与 state.json 只保留元数据；正文持久化在 Rust 侧
 *       articles/<feed_id>/<article_id>，打开文章时从这里按需取一次。
 */
import * as rssService from "../features/rss/services/rssService";

/** articleId -> 正文；null = 已确认无正文（文件不存在），undefined = 还没加载过 */
const cache = new Map<string, string | null>();

/** 只查缓存不发起加载（undefined = 没加载过） */
export function peekArticleContent(articleId: string): string | null | undefined {
  return cache.get(articleId);
}

/** 按需加载正文：命中缓存直接返回，否则读一次正文文件并缓存 */
export async function loadArticleContent(
  feedId: string,
  articleId: string,
): Promise<string | null> {
  const cached = cache.get(articleId);
  if (cached !== undefined) return cached;
  const content = await rssService.getArticleContent(feedId, articleId);
  cache.set(articleId, content);
  return content;
}
