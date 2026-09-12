/*
 * 文件名: articleDedupe.ts
 * 描述: 文章去重（读取旧状态时的自愈 + 追加新文章时的兜底）
 *
 * 为什么需要：文章 id = hash(feed_id + 条目标识)，而「条目标识」取自订阅源自己发布的
 * entry.id。订阅源改过一次 entry.id（或中途换了 feed URL）之后，同一篇文章会以不同的 id
 * 落库；而 v0.3.2 之前写入的记录还没有 entry_key，只剩链接可用。于是同一个条目会在磁盘上
 * 留下两条记录，表现就是列表里同一篇文章出现两次。
 *
 * 重复会直接破坏渲染：React 的 key 撞车后协调过程不会清理上一次的 DOM 节点，列表里还会
 * 混进其他订阅源的文章（表现为「选了源但列表没变」）。
 *
 * 判定「同一篇」不能只比一个字段：一条老记录只有链接、一条新记录才有 entry_key，
 * 单看某一边会得出「不同」的结论。所以这里给一篇文章登记它的**全部**身份线索
 * （entry_key / 链接 / 标题+发布时间，最后兜 id），线索交叠即视为同一篇（并查集归组）。
 * 合并时保留先出现的那条的位置与字段，只从同组其它记录补空缺，已读 / 收藏取并集。
 */
import { type Article, type MediaItem } from "../features/rss/types";

/** 一篇文章登记的身份线索：任一线索与他人相同即视为同一篇 */
function identityKeysOf(article: Article): string[] {
  const keys: string[] = [];
  if (article.entry_key) keys.push(`k:${article.entry_key}`);
  if (article.link) keys.push(`l:${article.link}`);
  // 标题 + 发布时间：老数据既无 entry_key 也无链接时的最后线索
  if (article.title) keys.push(`t:${article.title}|${article.published_at ?? ""}`);
  return keys;
}

/**
 * 合并同一篇文章的两条记录。
 * 字段以 existing 为准（列表顺序与显示保持稳定），只从 incoming 补空缺；
 * 已读 / 收藏取并集，避免合并时丢掉用户数据。
 */
function mergeArticle(existing: Article, incoming: Article): Article {
  return {
    ...existing,
    // entry_key 有值优先：它同时影响去重与 URL 变更后的 id 重算
    entry_key: existing.entry_key ?? incoming.entry_key,
    read: existing.read || incoming.read,
    starred: existing.starred || incoming.starred,
    published_at: existing.published_at ?? incoming.published_at,
    // 正文取更长的一份：旧记录可能只有摘要，新抓到的才是全文
    content: pickLongerContent(existing.content, incoming.content),
    preview: existing.preview ?? incoming.preview,
    title: existing.title ?? incoming.title,
    link: existing.link ?? incoming.link,
    content_type: existing.content_type ?? incoming.content_type,
    summary: existing.summary ?? incoming.summary,
    author: existing.author ?? incoming.author,
    categories: mergeList(existing.categories, incoming.categories),
    thumbnail: existing.thumbnail ?? incoming.thumbnail,
    media: mergeMedia(existing.media, incoming.media),
  };
}

/** 取更长的一份正文（长度按去标签后的纯文本算，两边都空则返回 null） */
function pickLongerContent(
  existing: string | null | undefined,
  incoming: string | null | undefined,
): string | null {
  if (!existing) return incoming ?? null;
  if (!incoming) return existing;
  const len = (html: string): number => html.replace(/<[^>]+>/g, "").trim().length;
  return len(incoming) > len(existing) ? incoming : existing;
}

/** 字符串数组合并去重（保持现有顺序，新值追加在后） */
function mergeList(
  existing: string[] | undefined,
  incoming: string[] | undefined,
): string[] | undefined {
  if (!existing || existing.length === 0) return incoming ?? existing;
  if (!incoming || incoming.length === 0) return existing;
  const merged = [...existing];
  for (const item of incoming) {
    if (!merged.includes(item)) merged.push(item);
  }
  return merged;
}

/** 附件数组合并：按地址去重，保留字段更全的一条 */
function mergeMedia(
  existing: MediaItem[] | undefined,
  incoming: MediaItem[] | undefined,
): MediaItem[] | undefined {
  if (!existing || existing.length === 0) return incoming ?? existing;
  if (!incoming || incoming.length === 0) return existing;
  const byUrl = new Map<string, MediaItem>();
  for (const item of [...existing, ...incoming]) {
    const prev = byUrl.get(item.url);
    if (!prev) {
      byUrl.set(item.url, item);
      continue;
    }
    byUrl.set(item.url, {
      url: item.url,
      content_type: prev.content_type ?? item.content_type,
      title: prev.title ?? item.title,
      size: prev.size ?? item.size,
      duration_secs: prev.duration_secs ?? item.duration_secs,
      width: prev.width ?? item.width,
      height: prev.height ?? item.height,
    });
  }
  return [...byUrl.values()];
}

/**
 * 按「身份线索交叠」去重。返回新数组；若没有重复则返回 null（调用方据此判断是否需要回写磁盘）。
 * 输出保持首次出现顺序，每篇文章只占一条（合并结果以先出现者为准）。
 */
export function dedupeArticlesById(articles: Article[]): Article[] | null {
  let changed = false;

  // 第一遍：线索交叠归组（并查集）。owner = 线索 → 首次出现该线索的文章下标，
  // 组内保留更早出现的下标作为根，输出顺序因此与输入顺序一致。
  const owner = new Map<string, number>();
  const parent: number[] = [];
  const rootOf = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };

  articles.forEach((article, index) => {
    parent[index] = index;
    for (const key of identityKeysOf(article)) {
      const first = owner.get(key);
      if (first === undefined) {
        owner.set(key, index);
        continue;
      }
      const rootFirst = rootOf(first);
      const rootSelf = rootOf(index);
      if (rootFirst === rootSelf) continue;
      changed = true;
      parent[rootSelf] = rootFirst;
    }
  });

  const grouped = new Map<number, Article>();
  for (let i = 0; i < articles.length; i++) {
    const root = rootOf(i);
    const existing = grouped.get(root);
    grouped.set(root, existing === undefined ? articles[i] : mergeArticle(existing, articles[i]));
  }

  // 第二遍：组内剩下的记录仍可能撞 id（链接被订阅源改过的老记录），按 id 再兜一次。
  // 只在这里用 id 判定：id 相同但身份线索完全不同的两条，多半是同一篇被重算过 id 的残留，
  // 合并会保留先出现者的标题 / 链接，用户数据取并集，不会丢已读与收藏。
  const byId = new Map<string, number>();
  const result: Article[] = [];
  for (const article of grouped.values()) {
    const at = byId.get(article.id);
    if (at === undefined) {
      byId.set(article.id, result.length);
      result.push(article);
      continue;
    }
    changed = true;
    result[at] = mergeArticle(result[at], article);
  }

  return changed ? result : null;
}

/**
 * 把新抓到的文章并入现有列表，保证同一篇文章只留一条、且没有两条记录共用同一个 id。
 * 追加新文章的入口（刷新 / 添加源）都走这里：抓取侧的去重是「按线索建已知集合」，
 * 老记录缺 entry_key 时线索退化为链接，与同 id 的历史记录对不上，仍可能插重。
 * 现有记录排在前面（保持列表顺序与显示稳定），新文章补在末尾；空字段由同组记录补全。
 */
export function appendArticles(existing: Article[], incoming: Article[]): Article[] {
  if (incoming.length === 0) return existing;
  // 快路径：没有任何历史记录时不可能有重复，直接引用 incoming，免去一次全量扫描与拷贝
  if (existing.length === 0) return incoming;
  // 现有记录在前：合并时以它们为准，新数据只用来补空缺字段
  return dedupeArticlesById([...existing, ...incoming]) ?? [...existing, ...incoming];
}
