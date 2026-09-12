/*
 * 文件名: ArticleList.tsx
 * 描述: Fluent 2 ListView — 中间文章列表（订阅源切换已移至左侧 NavigationView 抽屉）
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { Article } from "../types";
import type { ViewMode } from "../../../lib/preferences";
import { useResetScrollOnChange } from "../../../lib/scrollReset";
import { useMenuPosition } from "../../../lib/useMenuPosition";
import { classifyMedia, type MediaKind } from "../../../lib/contentRender";

interface ArticleListProps {
  articles: Article[];
  selectedArticleId: string | null;
  onSelect: (articleId: string) => void;
  /** 当前选中订阅源名称（null = 全部） */
  currentFeedName: string | null;
  /** 列表标题覆盖（如「收藏」视图）；缺省用订阅源名或「全部文章」 */
  title?: string;
  /** 完整文章总数（含未渲染的分批部分），用于计数展示 */
  total?: number;
  /** 是否还有未渲染的文章（滚动到底部自动加载） */
  hasMore?: boolean;
  /** 触发加载下一批 */
  onLoadMore?: () => void;
  /** 视图模式：紧凑 / 列表 / 卡片 */
  viewMode?: ViewMode;
  /**
   * 内容集合标识：值变化时列表滚回顶部（订阅源 / 筛选 / 排序 / 搜索 / 视图模式）。
   * 注意不要传文章数组——后台刷新追加文章时归零会打断阅读位置。
   */
  resetKey?: string;
  /** 订阅源标题表（全部视图下显示来源） */
  feedTitles?: Map<string, string>;
  /** 空列表提示文案 */
  emptyHint?: string;
  /** 空列表图标（Material Symbols 名称） */
  emptyIcon?: string;
  /** 右键菜单：在浏览器中打开原文 */
  onOpenExternal?: (articleId: string) => void;
  /** 右键菜单：标为已读 / 未读 */
  onToggleRead?: (articleId: string, read: boolean) => void;
  /** 右键菜单：切换星标 */
  onToggleStar?: (articleId: string) => void;
  /** 右键菜单：分享（打开分享面板，锚点为右键位置） */
  onShare?: (articleId: string, anchor: { left: number; top: number }) => void;
}

/** 文章右键菜单状态 */
interface ArticleCtxMenu {
  articleId: string;
  x: number;
  y: number;
}
/** 格式化日期为简洁显示（nowMs 按分钟传入，保持行组件 memo 有效） */
function formatDate(iso: string | null, nowMs: number): string {
  if (!iso) return "";
  const d = new Date(iso);
  const diffMs = nowMs - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay} 天前`;
  return d.toLocaleDateString("zh-CN", { year: "numeric", month: "short", day: "numeric" });
}

/**
 * 预览文本缓存：文章内容未变时复用去标签结果。
 * 已读 / 星标切换只会换数组引用，不改变 content，命中缓存即可跳过字符串处理。
 */
const previewCache = new Map<string, { content: string; text: string }>();

/** 清空预览文本缓存（设置里的「清理本地缓存」调用；缓存都在内存里，文章数据不动） */
export function clearPreviewCache(): number {
  const size = previewCache.size;
  previewCache.clear();
  return size;
}

/** 快速去除 HTML 标签（正则实现，避免每篇文章都构造 DOM 解析） */
function stripHtmlFast(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** 单篇文章行：memo 化，只有该文章数据 / 选中态 / 预览文本变化时才重渲染 */
interface ArticleRowProps {
  article: Article;
  selected: boolean;
  feedName: string;
  previewText: string;
  previewLen: number;
  /** 是否展示缩略图（卡片视图） */
  showThumb: boolean;
  /** 当前时间（分钟粒度），仅用于相对时间显示 */
  nowMs: number;
  onSelect: (articleId: string) => void;
  onContextMenu: (e: MouseEvent<HTMLButtonElement>, articleId: string) => void;
}

/** 列表缩略图是否启用（卡片视图才展示，紧凑 / 列表视图留给文字） */
const THUMB_VIEW_MODES: readonly ViewMode[] = ["card"];

/**
 * 缩略图同样走本地 rssimg 代理协议：Rust 侧带浏览器 UA（+ 代理）抓取，
 * 才能绕开防盗链 Referer 校验，与阅读视图里的图片走同一条链路。
 * Windows / Android 上自定义协议以 http://<scheme>.localhost 暴露，其余平台用原生 scheme。
 */
const IMG_PROTOCOL_BASE = /Windows|Android/i.test(navigator.userAgent)
  ? "http://rssimg.localhost"
  : "rssimg://localhost";

/** 把 http(s) 缩略图地址改写为本地代理地址（其余地址原样返回） */
function toProxyThumb(url: string): string {
  if (!/^https?:\/\//i.test(url)) return url;
  return `${IMG_PROTOCOL_BASE}/?url=${encodeURIComponent(url)}`;
}

const ArticleRow = memo(function ArticleRow({
  article,
  selected,
  feedName,
  previewText,
  previewLen,
  showThumb,
  nowMs,
  onSelect,
  onContextMenu,
}: ArticleRowProps): JSX.Element {
  // 附件种类提示：图片 / 音频 / 视频 / 文档各取一个代表图标（最多 3 个）
  const mediaKinds = new Set(
    (article.media ?? []).map((item) => classifyMedia(item.content_type, item.url)),
  );
  const mediaIcons: { kind: MediaKind; icon: string; label: string }[] = [];
  const KIND_HINT: { kind: MediaKind; icon: string; label: string }[] = [
    { kind: "image", icon: "image", label: "含图片" },
    { kind: "audio", icon: "graphic_eq", label: "含音频" },
    { kind: "video", icon: "movie", label: "含视频" },
    { kind: "document", icon: "description", label: "含文档" },
  ];
  for (const hint of KIND_HINT) {
    if (mediaKinds.has(hint.kind) && mediaIcons.length < 3) mediaIcons.push(hint);
  }

  return (
    <li>
      <button
        className={`article-item ${selected ? "active" : ""} ${
          article.read ? "read" : "unread"
        }`}
        onClick={() => onSelect(article.id)}
        onContextMenu={(e) => onContextMenu(e, article.id)}
      >
        <span className="article-item-dot" aria-hidden="true" />
        {showThumb && article.thumbnail && (
          <img
            className="article-item-thumb"
            src={toProxyThumb(article.thumbnail)}
            alt=""
            loading="lazy"
            data-orig-src={article.thumbnail}
            // 代理链路失败时回退直连原地址，两条都不行再隐藏（避免留下破图）
            onError={(e) => {
              const img = e.currentTarget;
              const original = img.dataset.origSrc;
              if (original && img.src.includes("rssimg")) {
                img.src = original;
                return;
              }
              img.style.display = "none";
            }}
          />
        )}
        <div className="article-item-body">
          <div className="article-item-title">
            {article.title || "（无标题）"}
            {article.starred && (
              <span
                className="material-symbols-rounded filled article-star"
                style={{ fontSize: "16px", verticalAlign: "middle" }}
              >
                star
              </span>
            )}
          </div>
          <div className="article-item-meta">
            {feedName && <span className="article-item-feed">{feedName}</span>}
            <span className="article-item-date">{formatDate(article.published_at, nowMs)}</span>
            {article.author && (
              <span className="article-item-author" title={article.author}>
                {article.author}
              </span>
            )}
            {mediaIcons.map((hint) => (
              <span
                key={hint.kind}
                className="material-symbols-rounded article-item-media-icon"
                title={hint.label}
              >
                {hint.icon}
              </span>
            ))}
          </div>
          {previewText && (
            <div className="article-item-preview">{previewText.slice(0, previewLen)}</div>
          )}
        </div>
      </button>
    </li>
  );
});

export function ArticleList({
  articles,
  selectedArticleId,
  onSelect,
  currentFeedName,
  title,
  total,
  hasMore,
  onLoadMore,
  viewMode = "compact",
  resetKey,
  feedTitles,
  emptyHint,
  emptyIcon,
  onOpenExternal,
  onToggleRead,
  onToggleStar,
  onShare,
}: ArticleListProps): JSX.Element {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // 列表滚动容器（.article-items）：内容集合变化时回到顶部
  const itemsRef = useResetScrollOnChange<HTMLUListElement>(resetKey);
  const [ctxMenu, setCtxMenu] = useState<ArticleCtxMenu | null>(null);
  // 分钟级时钟：行组件已 memo 化，不会随父组件重渲染自动刷新相对时间
  const [nowMs, setNowMs] = useState(() => Date.now());
  // 右键菜单按真实尺寸夹进视口（列表底部右键时不再被窗口下沿切掉）
  const { ref: ctxMenuRef, position: ctxMenuPosition } = useMenuPosition<HTMLDivElement>(ctxMenu);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  // 右键命中的文章（列表项一定在当前渲染集合内）
  const menuArticle = ctxMenu
    ? articles.find((a) => a.id === ctxMenu.articleId) ?? null
    : null;

  const handleContextMenu = useCallback(
    (e: MouseEvent<HTMLButtonElement>, articleId: string): void => {
      e.preventDefault();
      e.stopPropagation();
      // 收边交给 useMenuPosition：菜单挂载后按真实尺寸夹进视口
      setCtxMenu({ articleId, x: e.clientX, y: e.clientY });
    },
    [],
  );

  const runAction = (fn: (articleId: string) => void): void => {
    if (ctxMenu) {
      fn(ctxMenu.articleId);
      setCtxMenu(null);
    }
  };

  // 点击外部关闭右键菜单
  useEffect(() => {
    if (!ctxMenu) return;
    const close = (): void => setCtxMenu(null);
    document.addEventListener("click", close);
    document.addEventListener("contextmenu", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("contextmenu", close);
    };
  }, [ctxMenu]);

  // 不同视图模式的预览截断长度（卡片显示更长摘要，配合 CSS 行数钳制）
  const previewLen = viewMode === "compact" ? 80 : viewMode === "list" ? 120 : 220;
  const showThumb = THUMB_VIEW_MODES.includes(viewMode);

  // 预览文本：内容未变的文章直接命中缓存，只处理新增 / 变更的文章
  const previews = useMemo(() => {
    const map = new Map<string, string>();
    const live = new Set<string>();
    for (const a of articles) {
      live.add(a.id);
      // 正文与元数据分离后走 preview（纯文本，抓取落盘正文时生成）；内存正文兜底
      const content = a.preview ?? a.content;
      if (!content) continue;
      const cached = previewCache.get(a.id);
      if (cached && cached.content === content) {
        map.set(a.id, cached.text);
        continue;
      }
      const text = stripHtmlFast(content);
      previewCache.set(a.id, { content, text });
      map.set(a.id, text);
    }
    // 清掉已不在当前列表里的缓存，避免长期占用
    for (const id of [...previewCache.keys()]) {
      if (!live.has(id)) previewCache.delete(id);
    }
    return map;
  }, [articles]);

  // 滚动到接近底部时自动加载下一批
  useEffect(() => {
    const el = sentinelRef.current;
    if (!hasMore || !onLoadMore || !el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting)) onLoadMore();
      },
      { rootMargin: "600px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, onLoadMore]);
  return (
    <div className="article-list">
      <div className="article-list-header">
        <h2>{title ?? currentFeedName ?? "全部文章"}</h2>
        <span className="article-list-count">
          {total ?? articles.length} 篇文章
        </span>
      </div>

      {articles.length === 0 ? (
        <div className="article-list-empty">
          <span className="material-symbols-rounded">
            {emptyIcon ?? (emptyHint ? "search_off" : "inbox")}
          </span>
          <div>{emptyHint ?? "暂无文章，添加订阅源或刷新试试"}</div>
        </div>
      ) : (
        <ul ref={itemsRef} className={`article-items mode-${viewMode}`}>
          {articles.map((article, index) => (
            <ArticleRow
              // key 带上下标：存量数据若仍有重复 id（旧版本写入的两条同 id 记录），
              // 撞 key 会让 React 在协调时残留上一次渲染的 DOM 节点，
              // 表现为列表里混进其他订阅源的文章。载入时已做合并，这里是兜底。
              key={`${article.id}#${index}`}
              article={article}
              selected={selectedArticleId === article.id}
              feedName={!currentFeedName ? feedTitles?.get(article.feed_id) ?? "" : ""}
              previewText={previews.get(article.id) ?? ""}
              previewLen={previewLen}
              showThumb={showThumb}
              nowMs={nowMs}
              onSelect={onSelect}
              onContextMenu={handleContextMenu}
            />
          ))}
        </ul>
      )}

      {/* 分批加载哨兵：滚动接近底部时触发 onLoadMore */}
      {hasMore && (
        <div ref={sentinelRef} className="article-list-more">
          加载更多…
        </div>
      )}

      {/* 文章右键菜单 */}
      {ctxMenu && menuArticle && (
        <div
          ref={ctxMenuRef}
          className="feed-ctx-menu article-ctx-menu"
          style={{ left: ctxMenuPosition.left, top: ctxMenuPosition.top }}
          onClick={(e) => e.stopPropagation()}
        >
          <button className="dropdown-item" onClick={() => runAction(onSelect)}>
            <span className="material-symbols-rounded">menu_book</span>
            阅读
          </button>
          <button
            className="dropdown-item"
            disabled={!menuArticle.link}
            onClick={() => {
              if (onOpenExternal) runAction(onOpenExternal);
            }}
          >
            <span className="material-symbols-rounded">open_in_new</span>
            在浏览器中打开
          </button>
          <button
            className="dropdown-item"
            onClick={() => {
              if (onToggleRead) runAction((id) => onToggleRead(id, !menuArticle.read));
            }}
          >
            <span className="material-symbols-rounded">
              {menuArticle.read ? "undo" : "done"}
            </span>
            {menuArticle.read ? "标为未读" : "标为已读"}
          </button>
          <button
            className="dropdown-item"
            onClick={() => {
              if (onToggleStar) runAction(onToggleStar);
            }}
          >
            <span className={`material-symbols-rounded ${menuArticle.starred ? "filled" : ""}`}>
              star
            </span>
            {menuArticle.starred ? "取消星标" : "设为星标"}
          </button>
          <button
            className="dropdown-item"
            onClick={() => {
              if (!onShare || !ctxMenu) return;
              // 面板接着右键位置展开；这里不走 runAction（它只传 articleId，带不出锚点）
              onShare(ctxMenu.articleId, { left: ctxMenu.x, top: ctxMenu.y });
              setCtxMenu(null);
            }}
          >
            <span className="material-symbols-rounded">share</span>
            分享…
          </button>
        </div>
      )}
    </div>
  );
}
