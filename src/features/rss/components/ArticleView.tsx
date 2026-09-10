/*
 * 文件名: ArticleView.tsx
 * 描述: Fluent 2 阅读视图 — 右侧文章正文，Material Symbols 图标工具栏
 *       正文按内容种类渲染（HTML / 纯文本 / Markdown / 独立图片 / 外链正文），
 *       附件（图片 / 音频 / 视频 / 文档）按种类分区展示，摘要过短时可抓取原文全文
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Article, Feed, MediaItem, ProxyConfig } from "../types";
import * as rssService from "../services/rssService";
import { ArticleMedia } from "./ArticleMedia";
import { getFullContent, setFullContent } from "../../../lib/fullContentCache";
import {
  detectChallengePage,
  extractArticleFromDocument,
  findVideoEmbeds,
  MIN_USABLE_TEXT,
  type ExtractedContent,
  type VideoEmbed,
} from "../../../lib/articleExtract";
import {
  classifyMedia,
  detectContentKind,
  escapeHtml,
  plainTextLength,
  readingMinutes,
  renderContent,
} from "../../../lib/contentRender";

interface ArticleViewProps {
  article: Article;
  feed: Feed | null;
  onToggleStarred: () => void;
  onOpenLink: () => void;
  /** 在浏览器中打开任意地址（附件 / 原文） */
  onOpenExternal?: (url: string) => void;
  fontSize: number;
  proxyArg?: ProxyConfig;
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

/** 从 srcset 里挑一个可用地址（优先最大的候选，取不到时用 src） */
function pickFromSrcset(srcset: string): string {
  const candidates = srcset
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
  return candidates.length > 0 ? candidates[candidates.length - 1] : "";
}

/** 图片地址是否已是本地代理地址（避免二次改写） */
function isProxied(src: string): boolean {
  return src.startsWith(IMG_PROTOCOL_BASE);
}

/**
 * 规范化正文 HTML：
 * 1. 回填懒加载图片（data-src / data-original / data-lazy-src / data-original-src / srcset）；
 * 2. http(s) 图片统一改走本地 rssimg 协议，由 Rust 侧带 UA + 代理抓取，
 *    绕开防盗链 Referer 校验与 http 图片的混合内容拦截；
 * 3. 移除脚本类节点与 srcset（避免浏览器选中未代理的原图地址）；
 * 4. 补齐图片懒加载与缩略图尺寸属性，减少加载时的版面跳动（排版优化）。
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
      img.getAttribute("data-lazy-src") ??
      img.getAttribute("data-original-src");
    // srcset 没有被前面的 data-* 命中时也作为候选（不少站点只给 srcset）
    const fromSrcset = pickFromSrcset(
      img.getAttribute("srcset") ??
        img.getAttribute("data-srcset") ??
        img.getAttribute("data-lazy-srcset") ??
        "",
    );
    // src 缺失或是占位 data URI 时，用懒加载 / srcset 的真实地址回填
    const candidate =
      ((lazy && (!current || current.startsWith("data:")) ? lazy : current) ||
        fromSrcset ||
        lazy) ??
      "";
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
    for (const attr of [
      "srcset",
      "data-src",
      "data-srcset",
      "data-lazy-srcset",
      "data-original",
      "data-original-src",
      "data-lazy-src",
    ]) {
      img.removeAttribute(attr);
    }
    // 排版：懒加载 + 异步解码；只对没有尺寸声明的图片加，避免覆盖站点自己的宽高
    if (!img.hasAttribute("loading")) img.setAttribute("loading", "lazy");
    if (!img.hasAttribute("decoding")) img.setAttribute("decoding", "async");
  });

  doc.querySelectorAll("source").forEach((source) => source.removeAttribute("srcset"));

  // 排版：过长的标题层级收敛到 h2 以下（正文里的 h1 会与文章标题冲突）
  doc.querySelectorAll("h1").forEach((h1) => {
    const h2 = doc.createElement("h2");
    h2.innerHTML = h1.innerHTML;
    h1.replaceWith(h2);
  });

  // 排版：无 src 的 <video>/<audio> 不渲染，避免空白占位
  doc.querySelectorAll("video, audio").forEach((node) => {
    if (!node.getAttribute("src") && node.querySelector("source") === null) node.remove();
  });

  return doc.body.innerHTML;
}

/** 收集正文里已出现的图片原始地址（用于附件区判重） */
function collectInlineImageSrcs(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: string[] = [];
  doc.querySelectorAll("img").forEach((img) => {
    const orig = img.getAttribute("data-orig-src");
    if (orig) out.push(orig);
  });
  return out;
}

/**
 * 全文结果缓存（模块见 src/lib/fullContentCache.ts）：同一篇文章切走再切回不重复抓取与提取，
 * 设置里的「清理本地缓存」会清空它。
 */
/** 从原文 HTML 中提取正文内容（提取策略见 src/lib/articleExtract.ts） */
function extractArticleContent(html: string): ExtractedContent {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return extractArticleFromDocument(doc);
}

/**
 * 视频嵌入占位：正文里出现视频嵌入时，在正文位置留一个 sentinel 元素，
 * 挂载后由 replaceEmbedSentinels 换成真正的播放器节点。
 * 不直接把 iframe 塞进 dangerouslySetInnerHTML，是为了让 React 不再管这块 DOM
 * ——否则每次重渲染都会把正在播放的播放器整个重建。
 */
function embedSentinelHtml(embeds: VideoEmbed[]): string {
  if (embeds.length === 0) return "";
  return embeds.map((_, index) => `<div data-rss-embed="${index}"></div>`).join("");
}

/** 元信息行里的一项 */
function MetaChip({ icon, text }: { icon: string; text: string }): JSX.Element {
  return (
    <span className="article-meta-chip">
      <span className="material-symbols-rounded">{icon}</span>
      {text}
    </span>
  );
}

/**
 * 按内容种类渲染正文：
 * - external：正文是外链文件（Atom content src），给出打开入口而不塞进正文；
 * - empty：没有任何正文，给出提示；
 * - 其余：html / markdown / text / image 统一转成 HTML 片段后走 normalizeArticleHtml；
 * - 正文里的视频嵌入（iframe 播放器）抽出来单独渲染，原位留 sentinel。
 */
function buildRenderedHtml(
  article: Article,
  fullContent: ExtractedContent | null,
): { html: string; embeds: VideoEmbed[] } {
  if (fullContent) {
    return {
      html: normalizeArticleHtml(fullContent.html, article.link),
      embeds: fullContent.embeds,
    };
  }
  const raw = article.content ?? "";
  const kind = detectContentKind(raw, article.content_type);
  if (kind === "empty") {
    // 正文为空时不写死提示：可能正在自动抓取原文，也许原文里只有视频嵌入
    return { html: "", embeds: [] };
  }
  if (kind === "external") {
    const url = raw.trim();
    return {
      html: `<p class="article-external-hint">这篇订阅源的正文是一个外部文件：<a href="${escapeHtml(
        url,
      )}">${escapeHtml(url)}</a></p>`,
      embeds: [],
    };
  }
  // 订阅源自身给的正文里也可能直接嵌了播放器（RSS 的 description 常带 iframe）
  const embeds = findVideoEmbeds(raw);
  const body = kind === "html" ? stripIframes(raw) : renderContent(raw, article.content_type);
  return {
    html: normalizeArticleHtml(body + embedSentinelHtml(embeds), article.link),
    embeds,
  };
}

/** 去掉正文里的 iframe（嵌入已由 embeds 单独渲染，留在正文里只会是空白框） */
function stripIframes(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("iframe").forEach((frame) => frame.remove());
  return doc.body.innerHTML;
}

/** 正文是否只是内容不可用的占位（无可读文字） */
function hasReadableText(html: string): boolean {
  return plainTextLength(html) > 0;
}

export function ArticleView({
  article,
  feed,
  onToggleStarred,
  onOpenLink,
  onOpenExternal,
  fontSize,
  proxyArg,
}: ArticleViewProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [fullContent, setFullContentState] = useState<ExtractedContent | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  /** 是否已经为当前文章尝试过抓取全文（用于区分「抓取中」与「抓不到」） */
  const [hasAttemptedFull, setHasAttemptedFull] = useState(false);

  // 切换文章时重置状态（已抓取过全文的命中缓存，直接显示）
  useEffect(() => {
    setCopied(false);
    setFullContentState(getFullContent(article.id));
    setFetchError(null);
    setHasAttemptedFull(Boolean(getFullContent(article.id)));
  }, [article.id]);

  const contentKind = detectContentKind(article.content ?? "", article.content_type);
  /** 正文内容种类：html / text / markdown / image / external / empty */
  const summaryText = plainTextLength(article.content ?? "");
  // 摘要过短、且正文不是外链文件时，才提示可以抓取全文
  const isShort = summaryText < 200 && contentKind !== "external" && contentKind !== "empty";

  // 正文渲染（按内容种类分发 + 懒加载回填 + 图片走本地代理协议 + 视频嵌入单独成块）
  const { html: renderedHtml, embeds } = useMemo(
    () => buildRenderedHtml(article, fullContent),
    [article, fullContent],
  );
  const contentRef = useRef<HTMLDivElement | null>(null);

  // 阅读时长：按渲染后正文的纯文本长度估算（正文种类不同，长度口径也不同）
  const renderedTextLength: number = plainTextLength(renderedHtml);
  const minutes = readingMinutes(renderedTextLength);

  // 正文里出现过的图片原始地址 → 附件区判重（避免同一张图出现两次）
  const inlineImages = useMemo(() => collectInlineImageSrcs(renderedHtml), [renderedHtml]);

  // 首图：正文没有大图时用媒体缩略图补一张（提升进入阅读视图的第一印象）
  const inlineHasImage = useMemo(
    () => /<img\b/i.test(renderedHtml),
    [renderedHtml],
  );
  const leadImage = useMemo(() => {
    if (inlineHasImage) return null;
    const raw = (article.thumbnail ?? "").trim();
    if (!raw) return null;
    const resolved = resolveImgSrc(raw, article.link);
    if (!/^https?:\/\//i.test(resolved)) return null;
    return resolved;
  }, [article.thumbnail, article.link, inlineHasImage]);

  // 视频海报图：用订阅源缩略图（走本地代理；加载失败由全局 error 处理隐藏）
  const posterUrl = useMemo(() => {
    const raw = (article.thumbnail ?? "").trim();
    if (!raw) return null;
    const resolved = resolveImgSrc(raw, article.link);
    if (!/^https?:\/\//i.test(resolved)) return null;
    return toProxyImgSrc(resolved, article.link ?? undefined);
  }, [article.thumbnail, article.link]);

  /**
   * 附件：订阅源给的媒体 + 正文里抽出来的视频嵌入。
   * 图片地址统一改写为本地代理协议；音视频 / 嵌入保持原地址（播放器直接加载或交给浏览器）。
   */
  const media = useMemo<MediaItem[]>(() => {
    const fromFeed = (article.media ?? []).map((item) => {
      const resolved = resolveImgSrc(item.url, article.link);
      if (!/^https?:\/\//i.test(resolved) || isProxied(resolved)) return item;
      return {
        ...item,
        url:
          classifyMedia(item.content_type, item.url) === "image"
            ? toProxyImgSrc(resolved, article.link ?? undefined)
            : resolved,
      };
    });
    // 正文里的嵌入排在前面：它才是这篇文章的主要内容
    const embedded: MediaItem[] = embeds.map((embed) => ({
      url: embed.watchUrl,
      content_type: "video/embed",
      title: embed.title ?? `${embed.platform ?? "视频"} 嵌入播放器`,
      thumbnail: embed.thumbnail ?? null,
      duration_secs: embed.durationSecs ?? null,
      embed_src: embed.embeddable ? embed.src : null,
      embed_platform: embed.platform,
    }));
    return [...embedded, ...fromFeed];
  }, [article.media, article.link, embeds]);

  const openUrl = (url: string): void => {
    if (onOpenExternal) onOpenExternal(url);
    else void rssService.openExternal(url);
  };

  // 把正文里的 sentinel 换成真正的播放器节点（交由浏览器直接管理这块 DOM）
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    container.querySelectorAll<HTMLElement>("[data-rss-embed]").forEach((sentinel) => {
      const index = Number(sentinel.dataset.rssEmbed ?? "-1");
      const embed = embeds[index];
      if (!embed) {
        sentinel.remove();
        return;
      }
      if (!embed.embeddable) {
        const link = document.createElement("p");
        link.className = "article-embed-fallback";
        link.innerHTML = `${escapeHtml(embed.platform ?? "视频")} 的播放器不允许内嵌，<a href="${escapeHtml(
          embed.watchUrl,
        )}">在浏览器中观看</a>`;
        sentinel.replaceWith(link);
        return;
      }
      const wrap = document.createElement("div");
      wrap.className = "article-embed";
      const frame = document.createElement("iframe");
      frame.src = embed.src;
      frame.loading = "lazy";
      frame.setAttribute("allowfullscreen", "true");
      frame.setAttribute(
        "sandbox",
        "allow-scripts allow-same-origin allow-presentation allow-popups",
      );
      frame.setAttribute("title", embed.title ?? `${embed.platform ?? "视频"} 播放器`);
      wrap.appendChild(frame);
      sentinel.replaceWith(wrap);
    });
  }, [renderedHtml, embeds]);

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
    const cached = getFullContent(article.id);
    if (cached) {
      setFullContentState(cached);
      return;
    }
    setLoadingFull(true);
    setFetchError(null);
    setHasAttemptedFull(true);
    try {
      const html = await rssService.fetchArticleHtml(article.link, proxyArg);
      const extracted = extractArticleContent(html);
      // 正文文字够多，或页面内容本来就是视频嵌入（博客正文只有一条播放器的情形）
      const hasEmbeddedMedia = extracted.embeds.length > 0 && embeds.length === 0;
      if (
        hasEmbeddedMedia ||
        (extracted.textLength >= MIN_USABLE_TEXT && extracted.textLength > summaryText)
      ) {
        setFullContent(article.id, extracted);
        setFullContentState(extracted);
        return;
      }
      // 失败原因分开说：站点拦截 / 正文靠脚本渲染 / 确实没抓到更多
      const challenge = detectChallengePage(html);
      const pageText = plainTextLength(
        html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " "),
      );
      if (challenge) {
        setFetchError(`${challenge}，抓不到正文。可点上方「打开原文」在浏览器里阅读。`);
      } else if (pageText < MIN_USABLE_TEXT) {
        setFetchError(
          "原文页几乎没有正文文本（正文多半由 JavaScript 渲染），HTML 里抓不到内容。可点上方「打开原文」。",
        );
      } else {
        setFetchError(
          `提取到的正文（${extracted.textLength} 字）没有比订阅源已给的内容（${summaryText} 字）更多，` +
            `命中的容器是「${extracted.source}」。可点上方「打开原文」查看完整页面。`,
        );
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

  // 可用的按钮：获取全文（正文为空或外部文件时也算可用）
  const canFetchFull = Boolean(article.link) && !fullContent;

  /**
   * 订阅源完全没给正文（content 为空）：自动抓一次原文。
   * 这类文章要么正文全靠客户端渲染、要么整篇就是一条视频嵌入（例如博客里内嵌 B 站播放器），
   * 让用户为每篇都手点一次「获取全文」没有意义。抓不到时保持自动状态、只提示结果。
   */
  const needsFullText = contentKind === "empty" && summaryText === 0;
  const attemptedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!needsFullText || !article.link || fullContent) return;
    if (attemptedRef.current === article.id) return;
    attemptedRef.current = article.id;
    void handleFetchFull();
    // handleFetchFull 每次渲染都会重建，这里只以文章身份为准触发一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsFullText, article.id, article.link, fullContent]);

  return (
    <article className="article-view">
      <header className="article-view-header">
        <div className="article-view-source">
          {feed ? feed.title : "未知来源"}
        </div>
        <h1>{article.title || "（无标题）"}</h1>
        {/* 元信息行：作者 / 时间 / 阅读时长 / 附件数 */}
        <div className="article-view-meta">
          {article.author && <MetaChip icon="person" text={article.author} />}
          {article.published_at && (
            <MetaChip
              icon="schedule"
              text={new Date(article.published_at).toLocaleString("zh-CN", {
                year: "numeric",
                month: "long",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            />
          )}
          {minutes > 0 && <MetaChip icon="menu_book" text={`约 ${minutes} 分钟`} />}
          {media.length > 0 && (
            <MetaChip icon="attachment" text={`${media.length} 个附件`} />
          )}
        </div>
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

      {/* 标签 */}
      {(article.categories?.length ?? 0) > 0 && (
        <div className="article-tags">
          {article.categories?.slice(0, 12).map((tag) => (
            <span key={tag} className="article-tag">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* 首图：正文无图但有缩略图时补一张 */}
      {leadImage && (
        <figure className="article-lead-image">
          <img
            src={toProxyImgSrc(leadImage, article.link ?? undefined)}
            alt=""
            data-orig-src={leadImage}
            loading="lazy"
          />
        </figure>
      )}

      {/* 正文内容（data-link-base 供全局链接守卫解析相对链接） */}
      <div
        ref={contentRef}
        className={`article-view-content kind-${contentKind}`}
        data-link-base={article.link ?? undefined}
        style={{ fontSize: `${fontSize}px` }}
        dangerouslySetInnerHTML={{ __html: renderedHtml }}
      />

      {/* 订阅源没给正文时的状态说明（自动抓取中 / 原文页没抓到 / 无从抓取） */}
      {needsFullText &&
        !renderedHtml &&
        (loadingFull ? (
          <p className="article-empty-hint">
            <span className="material-symbols-rounded">progress_activity</span>
            订阅源没有提供正文，正在抓取原文…
          </p>
        ) : !article.link ? (
          <p className="article-empty-hint">（这篇订阅源没有提供正文，也没有原文链接）</p>
        ) : (
          hasAttemptedFull && (
            <p className="article-empty-hint">（原文页也没能提取到正文，可点上方「打开原文」查看）</p>
          )
        ))}
      {/* 附件区：图片 / 音频 / 视频 / 文档分种类展示（音视频可直接内嵌播放） */}
      <ArticleMedia
        media={media}
        inlineImages={inlineImages}
        thumbnail={article.thumbnail}
        posterUrl={posterUrl}
        onOpen={openUrl}
      />

      {/* 摘要式正文时显示获取全文按钮 */}
      {canFetchFull && (isShort || !hasReadableText(renderedHtml) || contentKind === "external") && (
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
          {contentKind === "external" && (
            <div className="article-fetch-note">订阅源只给了外部文件链接，抓取原文页可还原正文</div>
          )}
        </div>
      )}

      {/* 正文另存有摘要时提示：正文可能只是摘要 */}
      {article.summary &&
        summaryText > 0 &&
        article.summary.trim() !== (article.content ?? "").trim() && (
          <details className="article-summary-block">
            <summary>
              <span className="material-symbols-rounded">notes</span>
              订阅源附带的摘要（{plainTextLength(article.summary)} 字）
            </summary>
            <div
              className="article-summary-body"
              dangerouslySetInnerHTML={{
                __html: normalizeArticleHtml(
                  renderContent(article.summary, article.content_type),
                  article.link,
                ),
              }}
            />
          </details>
        )}
    </article>
  );
}
