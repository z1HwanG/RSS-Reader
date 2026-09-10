/*
 * 文件名: ArticleView.tsx
 * 描述: Fluent 2 阅读视图 — 右侧文章正文，Material Symbols 图标工具栏
 *       RSS 摘要过短时可抓取原文全文
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Article, Feed, ProxyConfig } from "../types";
import * as rssService from "../services/rssService";

interface ArticleViewProps {
  article: Article;
  feed: Feed | null;
  onToggleStarred: () => void;
  onOpenLink: () => void;
  fontSize: number;
  proxyArg?: ProxyConfig;
}

/** 去除 HTML 标签后的纯文本长度 */
function textLength(html: string): number {
  return html.replace(/<[^>]+>/g, "").trim().length;
}

/**
 * 图片本地代理协议基址。
 * Windows / Android 上 Tauri 自定义协议以 http://<scheme>.localhost 暴露，其余平台用原生 scheme。
 */
const IMG_PROTOCOL_BASE = /Windows|Android/i.test(navigator.userAgent)
  ? "http://rssimg.localhost"
  : "rssimg://localhost";

/** 把 http(s) 图片地址改写为本地代理协议地址（data: / blob: 等保持原样）。
 *  ref 为文章页地址：Rust 侧被 CDN 以 403 防盗链拒绝时会带上它重试。 */
function toProxyImgSrc(src: string, referer?: string): string {
  const ref = referer ? `&ref=${encodeURIComponent(referer)}` : "";
  return `${IMG_PROTOCOL_BASE}/?url=${encodeURIComponent(src)}${ref}`;
}

/** 解析图片地址：懒加载属性、协议相对（//）、站内相对路径等，统一补全为绝对地址 */
function resolveImgSrc(raw: string, baseUrl: string | null): string {
  const src = raw.trim();
  if (!src) return "";
  if (/^(data|blob):/i.test(src)) return src;
  if (src.startsWith("//")) return `https:${src}`;
  if (/^https?:\/\//i.test(src)) return src;
  if (baseUrl) {
    try {
      return new URL(src, baseUrl).toString();
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * 规范化文章 HTML：
 * 1. 回填懒加载图片（data-src / data-original / data-lazy-src）；
 * 2. http(s) 图片统一改走本地 rssimg 协议，由 Rust 侧带 UA + 代理抓取，
 *    绕开防盗链 Referer 校验与 http 图片的混合内容拦截；
 * 3. 移除脚本类节点与 srcset（避免浏览器选中未代理的原图地址）。
 */
function normalizeArticleHtml(html: string, baseUrl: string | null): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // 移除脚本类节点，以及可能触发整页跳转的 base / meta refresh / 表单
  doc
    .querySelectorAll('script, iframe, object, embed, form, base, meta[http-equiv="refresh"]')
    .forEach((el) => el.remove());

  doc.querySelectorAll("img").forEach((img) => {
    const current = img.getAttribute("src") ?? "";
    const lazy =
      img.getAttribute("data-src") ??
      img.getAttribute("data-original") ??
      img.getAttribute("data-lazy-src");
    // src 缺失或是占位 data URI 时，用懒加载真实地址回填
    const candidate = lazy && (!current || current.startsWith("data:")) ? lazy : current;
    const resolved = resolveImgSrc(candidate, baseUrl);

    if (resolved && /^(https?:\/\/|data:|blob:)/i.test(resolved)) {
      img.setAttribute(
        "src",
        /^https?:\/\//i.test(resolved) ? toProxyImgSrc(resolved, baseUrl ?? undefined) : resolved,
      );
      // 记录原始 http(s) 地址：代理协议加载失败时可回退直连
      if (/^https?:\/\//i.test(resolved)) img.setAttribute("data-orig-src", resolved);
    } else {
      img.remove();
      return;
    }
    for (const attr of ["srcset", "data-src", "data-srcset", "data-original", "data-lazy-src"]) {
      img.removeAttribute(attr);
    }
  });

  doc.querySelectorAll("source").forEach((source) => source.removeAttribute("srcset"));

  return doc.body.innerHTML;
}
/**
 * 获取全文结果缓存：同一篇文章切走再切回不再重复抓取与提取。
 * 上限 20 篇，超出后按插入顺序淘汰最早的。
 */
const FULL_CONTENT_CACHE_LIMIT = 20;
const fullContentCache = new Map<string, string>();

function cacheFullContent(articleId: string, html: string): void {
  if (fullContentCache.size >= FULL_CONTENT_CACHE_LIMIT) {
    const oldest = fullContentCache.keys().next().value;
    if (oldest !== undefined) fullContentCache.delete(oldest);
  }
  fullContentCache.set(articleId, html);
}

/** 从原文 HTML 中提取正文内容 */
function extractArticleContent(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");

  // 尝试定位正文容器
  let container: Element | null =
    doc.querySelector("article") ||
    doc.querySelector("main") ||
    doc.querySelector("[role=main]") ||
    doc.querySelector(
      ".post-content, .article-content, .entry-content, .post-body, .article-body, .post-entry, .content-body, #content-body, .markdown-body",
    );

  if (!container) container = doc.body;
  if (!container) return "";

  // 移除无关元素
  container
    .querySelectorAll(
      "script, style, nav, aside, header, footer, noscript, iframe, form, .ad, .advertisement, .sidebar, .comments, .comment-form, .related, .share, .social, .popup, .modal",
    )
    .forEach((el) => el.remove());

  return container.innerHTML;
}

export function ArticleView({
  article,
  feed,
  onToggleStarred,
  onOpenLink,
  fontSize,
  proxyArg,
}: ArticleViewProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // 切换文章时重置状态（已抓取过全文的命中缓存，直接显示）
  useEffect(() => {
    setCopied(false);
    setFullContent(fullContentCache.get(article.id) ?? null);
    setFetchError(null);
  }, [article.id]);

  const isShort = textLength(article.content ?? "") < 200;

  // 规范化正文 HTML（懒加载回填 + 图片走本地代理协议），按文章/全文缓存避免重复解析
  const renderedHtml = useMemo(
    () => normalizeArticleHtml(fullContent ?? article.content ?? "<p>（无内容）</p>", article.link),
    [article.content, article.link, fullContent],
  );
  const contentRef = useRef<HTMLDivElement | null>(null);

  // 图片经 rssimg 协议加载失败时回退直连原始 https 地址。
  // img 的 error 事件不冒泡，需在捕获阶段监听。
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    const onError = (event: Event): void => {
      const img = event.target as HTMLImageElement | null;
      if (!img || img.tagName !== "IMG") return;
      // 第一层：代理协议失败 → 回退直连原始 http(s) 地址
      // （CSP 的 img-src 已放行 http: / https:，回退不会被拦）
      if (img.src.includes("rssimg")) {
        const original = img.dataset.origSrc;
        if (original && /^https?:\/\//i.test(original)) {
          img.src = original;
          return;
        }
      }
      // 第二层：两条链路都失败 → 隐藏，避免留下破图图标
      img.style.display = "none";
    };
    container.addEventListener("error", onError, true);
    return () => container.removeEventListener("error", onError, true);
  }, [renderedHtml]);

  const handleFetchFull = async (): Promise<void> => {
    if (!article.link) return;
    const cached = fullContentCache.get(article.id);
    if (cached) {
      setFullContent(cached);
      return;
    }
    setLoadingFull(true);
    setFetchError(null);
    try {
      const html = await rssService.fetchArticleHtml(article.link, proxyArg);
      const extracted = extractArticleContent(html);
      if (textLength(extracted) > textLength(article.content ?? "")) {
        cacheFullContent(article.id, extracted);
        setFullContent(extracted);
      } else {
        setFetchError("原文内容不够丰富，可能站点结构与提取器不兼容");
      }
    } catch (err) {
      setFetchError(String(err));
    } finally {
      setLoadingFull(false);
    }
  };

  const handleCopyLink = async (): Promise<void> => {
    if (!article.link) return;
    try {
      await navigator.clipboard.writeText(article.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 忽略剪贴板权限错误
    }
  };

  return (
    <article className="article-view">
      <header className="article-view-header">
        <div className="article-view-source">
          {feed ? feed.title : "未知来源"}
        </div>
        <h1>{article.title || "（无标题）"}</h1>
        {article.published_at && (
          <div className="article-view-date">
            {new Date(article.published_at).toLocaleString("zh-CN", {
              year: "numeric",
              month: "long",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
        )}
      </header>

      <div className="article-view-toolbar">
        <button onClick={onToggleStarred} title={article.starred ? "取消收藏" : "收藏"}>
          <span
            className={`material-symbols-rounded ${article.starred ? "filled" : ""}`}
          >
            star
          </span>
          {article.starred ? "已收藏" : "收藏"}
        </button>
        {article.link && (
          <>
            <button onClick={onOpenLink} title="在浏览器中打开原文">
              <span className="material-symbols-rounded">open_in_new</span>
              打开原文
            </button>
            <button onClick={() => void handleCopyLink()} title="复制链接">
              <span className="material-symbols-rounded">
                {copied ? "check" : "content_copy"}
              </span>
              {copied ? "已复制" : "复制链接"}
            </button>
          </>
        )}
      </div>

      {/* 正文内容（data-link-base 供全局链接守卫解析相对链接） */}
      <div
        ref={contentRef}
        className="article-view-content"
        data-link-base={article.link ?? undefined}
        style={{ fontSize: `${fontSize}px` }}
        dangerouslySetInnerHTML={{ __html: renderedHtml }}
      />

      {/* 短摘要时显示获取全文按钮 */}
      {isShort && !fullContent && article.link && (
        <div className="article-fetch-full">
          {fetchError && <div className="article-fetch-error">{fetchError}</div>}
          <button
            className="f2-btn-soft"
            onClick={() => void handleFetchFull()}
            disabled={loadingFull}
          >
            <span className="material-symbols-rounded">
              {loadingFull ? "progress_activity" : "article"}
            </span>
            {loadingFull ? "正在获取全文…" : "获取全文"}
          </button>
        </div>
      )}
    </article>
  );
}
