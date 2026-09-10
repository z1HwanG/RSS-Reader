/**
 * RSS Reader 的共享类型定义（与 Rust 侧 DTO 保持一致，字段名与 Rust snake_case 对齐）。
 */

/** 订阅源分组 */
export interface Group {
  /** 分组唯一 ID */
  id: string;
  /** 分组名称 */
  name: string;
}

/** 一条订阅源 */
export interface Feed {
  /** 唯一 ID（URL 的 hash） */
  id: string;
  /** 订阅源 URL */
  url: string;
  /** 源标题 */
  title: string;
  /** 源描述 */
  description: string | null;
  /** 站点链接 */
  site_url: string | null;
  /** 订阅时间（ISO 时间戳） */
  added_at: string;
  /** 所属分组 ID（无分组为 null） */
  group_id: string | null;
  /** 分组内排序序号 */
  sort_order: number;
  /** 文章打开方式：null=内部阅读，"external"=外部浏览器 */
  open_method: string | null;
  /** 上次抓取响应的 ETag（条件请求用；历史数据可能缺失） */
  etag?: string | null;
  /** 上次抓取响应的 Last-Modified（条件请求用；历史数据可能缺失） */
  last_modified?: string | null;
}

/** 一篇文章 */
export interface Article {
  /** 唯一 ID（源 ID + 条目 ID 的组合 hash） */
  id: string;
  /**
   * 生成 id 用的条目标识（Rust 侧 feed-rs 的 entry.id）。
   * 订阅源 URL 变更后需要按新 feed_id 重算 id，靠它还原原始标识；
   * 旧数据（schema_version < 2）缺该字段，退化按 link / title 匹配。
   */
  entry_key?: string | null;
  /** 所属订阅源 ID */
  feed_id: string;
  /** 标题 */
  title: string | null;
  /** 正文摘要（HTML） */
  content: string | null;
  /** 原文链接 */
  link: string | null;
  /** 发布日期（ISO 时间戳，可能为空） */
  published_at: string | null;
  /** 是否已读 */
  read: boolean;
  /** 是否收藏 */
  starred: boolean;
}

/**
 * 跨次抓取稳定去重的键：优先用 Rust 侧给的 entry 标识（与文章 id 同源），
 * 旧数据没有 entry_key 时退化为原文链接；两者都缺时用「标题 + 发布时间」兜底。
 * 返回 null 表示无法稳定识别（既无标识也无标题），此时不做去重。
 */
export function articleKey(article: Article): string | null {
  if (article.entry_key) return `k:${article.entry_key}`;
  if (article.link) return `l:${article.link}`;
  if (article.title) return `t:${article.title}|${article.published_at ?? ""}`;
  return null;
}

/** 应用状态（本地持久化） */
export interface AppState {
  /** 状态文件结构版本（由 Rust 侧写入与迁移，前端只透传） */
  schema_version?: number;
  feeds: Feed[];
  articles: Article[];
  groups: Group[];
}

/** 抓取订阅源的中间结果 */
export interface FetchResult {
  feed_id: string;
  feed_title: string;
  feed_description: string | null;
  feed_site_url: string | null;
  articles: Article[];
  /** 本次响应的 ETag（供下次条件请求） */
  etag: string | null;
  /** 本次响应的 Last-Modified（供下次条件请求） */
  last_modified: string | null;
  /** 订阅源未变化（304）：articles 为空，标题等元信息不更新 */
  not_modified: boolean;
}

/** 代理配置 */
export interface ProxyConfig {
  enabled: boolean;
  host: string | null;
  port: number | null;
  /** 代理类型：缺省/"http" = HTTP 代理；"socks5" = SOCKS5 代理 */
  kind?: string | null;
}