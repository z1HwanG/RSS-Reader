/*
 * 文件名: articleFilter.ts
 * 描述: 文章列表的过滤规则（纯函数，便于单独验证）
 *
 * 这里刻意把两个「星标」概念分开：
 * - `starredView`：抽屉里的「收藏」视图（跨订阅源看星标文章），会话内状态；
 * - `viewFilter === "starred"`：顶栏筛选里的「仅星标文章」，属于持久化偏好。
 * 两者互不驱动、互不覆盖，只在本函数里按同一优先级叠加。
 */
import type { Article } from "../features/rss/types";
import type { Preferences } from "./preferences";

export function filterArticles(
  articles: Article[],
  options: {
    selectedFeedId: string | null;
    /** 抽屉「收藏」视图是否激活（优先于 viewFilter） */
    starredView: boolean;
    prefs: Pick<Preferences, "viewFilter">;
    /** 搜索关键字（已去空白、小写化前的原文） */
    searchQuery: string;
    /** 文章 id → 小写搜索文本 */
    searchIndex: Map<string, string>;
  },
): Article[] {
  const { selectedFeedId, starredView, prefs, searchQuery, searchIndex } = options;
  const query = searchQuery.trim().toLowerCase();
  // 搜索与视图筛选并列：任一不满足即过滤掉
  const matchesQuery = (a: Article): boolean =>
    !query || (searchIndex.get(a.id) ?? "").includes(query);

  return articles.filter((a) => {
    if (selectedFeedId && a.feed_id !== selectedFeedId) return false;
    // 抽屉「收藏」是独立视图：只看星标文章，顶栏的「全部 / 未读 / 仅星标」一概不参与
    // （否则「未读」会把已读的收藏文章滤掉，收藏视图就不完整了）
    if (starredView) return a.starred && matchesQuery(a);
    if (prefs.viewFilter === "unread" && a.read) return false;
    if (prefs.viewFilter === "starred" && !a.starred) return false;
    return matchesQuery(a);
  });
}
