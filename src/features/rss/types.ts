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
}

/** 文章附带的媒体资源（RSS enclosure / MediaRSS / JSON Feed 附件 / Atom 媒体链接） */
export interface MediaItem {
  /** 资源地址 */
  url: string;
  /** MIME 类型（可能缺失，前端按扩展名兜底判断） */
  content_type?: string | null;
  /** 资源标题 */
  title?: string | null;
  /** 字节大小 */
  size?: number | null;
  /** 时长（秒） */
  duration_secs?: number | null;
  /** 宽度（像素） */
  width?: number | null;
  /** 高度（像素） */
  height?: number | null;
  /**
   * 可直接内嵌的播放器地址（正文里的 Bilibili / YouTube 等 iframe 嵌入）。
   * 有值时按嵌入播放器渲染；为空表示只能开浏览器（平台观看页或禁止内嵌）。
   */
  embed_src?: string | null;
  /** 嵌入平台名（Bilibili / YouTube / …） */
  embed_platform?: string | null;
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
  /**
   * 正文内容。HTML / XHTML 是标记文本；text/plain、text/markdown 按原文保存，
   * 由 ArticleView 依据 content_type 决定渲染方式。
   */
  content: string | null;
  /** 正文内容类型（MIME，如 text/html、text/plain、text/markdown）；旧数据缺失按 HTML 处理 */
  content_type?: string | null;
  /** 正文之外另存的摘要文本（仅供预览与「正文即摘要」提示） */
  summary?: string | null;
  /** 作者（多人以「、」连接） */
  author?: string | null;
  /** 标签 / 分类 */
  categories?: string[];
  /** 缩略图地址 */
  thumbnail?: string | null;
  /** 媒体附件（图片 / 音频 / 视频 / 文档） */
  media?: MediaItem[];
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

/** 抓取订阅源的中间结果（每次都是全量抓取，没有 304 / 条件请求分支） */
export interface FetchResult {
  feed_id: string;
  feed_title: string;
  feed_description: string | null;
  feed_site_url: string | null;
  articles: Article[];
}

/** 代理配置 */
export interface ProxyConfig {
  enabled: boolean;
  host: string | null;
  port: number | null;
  /** 代理类型：缺省/"http" = HTTP 代理；"socks5" = SOCKS5 代理 */
  kind?: string | null;
}