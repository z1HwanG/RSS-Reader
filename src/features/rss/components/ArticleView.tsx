/*
 * 文件名: ArticleView.tsx
 * 描述: Fluent 2 阅读视图 — 右侧文章正文，Material Symbols 图标工具栏
 *       正文按内容种类渲染（HTML / 纯文本 / Markdown / 独立图片 / 外链正文），
 *       附件（图片 / 音频 / 视频 / 文档）按种类分区展示，摘要过短时可抓取原文全文
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Article, Feed, MediaItem, ProxyConfig } from "../types";
import * as rssService from "../services/rssService";
import type { ShareAnchor } from "./ShareMenu";
import { getFullContent, setFullContent } from "../../../lib/fullContentCache";
import {
  isTranslateConfigured,
  loadTranslateConfig,
  loadTranslatePicker,
  onTranslateConfigChange,
  selectTranslationTarget,
  setTranslateLanguages,
  translateBlocks,
  type TranslatePickerState,
} from "../services/translateService";
import { extractTranslatableBlocks, interleaveTranslations } from "../../../lib/articleTranslate";
import { SelectionTranslate } from "./SelectionTranslate";
import { LANGUAGE_OPTIONS, SOURCE_LANGUAGE_OPTIONS } from "../types";
import { resolveAnchorUrl } from "../../../lib/linkGuard";
import { useMenuPosition } from "../../../lib/useMenuPosition";
import { canonicalEmbedKey, extractArticleFromDocument, findVideoEmbeds, identifyVideoEmbed, MIN_USABLE_TEXT, type ExtractedContent, type VideoEmbed } from "../../../lib/articleExtract";
import {
  classifyMedia,
  detectContentKind,
  escapeHtml,
  looksTruncated,
  plainTextLength,
  readingMinutes,
  renderContent,
  videoWatchPageHost,
} from "../../../lib/contentRender";

interface ArticleViewProps {
  article: Article;
  feed: Feed | null;
  onToggleStarred: () => void;
  onOpenLink: () => void;
  /** 在浏览器中打开任意地址（附件 / 原文） */
  onOpenExternal?: (url: string) => void;
  /** 打开分享面板（锚点由分享按钮的位置算出） */
  onShare?: (anchor: ShareAnchor) => void;
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
    .querySelectorAll('script, object, embed, form, base, meta[http-equiv="refresh"]')
    .forEach((el) => el.remove());

  // iframe **不再一律删除**：认不出平台的 iframe 里可能有音频播放器
  // （Spotify / 小宇宙 / 网易云 / 各家播客托管的嵌入都是 iframe），
  // 早先一律删掉等于直接丢内容。改成保留但收紧：懒加载 + sandbox，
  // 与视频嵌入同一套权限；CSP 的 frame-src 决定哪些域真的能加载。
  doc.querySelectorAll("iframe").forEach((frame) => {
    // 懒加载写法：正文里常是 data-src，真正的 src 要补上（否则整块空白）
    const lazy =
      frame.getAttribute("data-src") ??
      frame.getAttribute("data-original") ??
      frame.getAttribute("data-lazy-src");
    const current = (frame.getAttribute("src") ?? "").trim();
    if (!current && lazy) frame.setAttribute("src", lazy.trim());

    // **协议相对地址必须补成 https**：`//music.163.com/...`（网易云外链播放器就是这种写法）
    // 在本应用的页面源下会解析成 http://，而 CSP 的 frame-src 只放行 https → 播放器被静默拦掉，
    // 界面上一片空白、也看不到报错。这里统一补成 https。
    const src = (frame.getAttribute("src") ?? "").trim();
    if (src.startsWith("//")) frame.setAttribute("src", `https:${src}`);

    frame.setAttribute("loading", "lazy");
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation allow-popups");
  });

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
    // 排版：懒加载 + 异步解码；只对没有尺寸声明的图片加，避免覆盖站点自己的宽高。
    // 「加载前先给一块浅底」由 CSS 按 `img[width][height]` 命中（这类图会按宽高比预留高度），
    // 不在这里打标记：标记要跟着 DOM 生存，而正文是 dangerouslySetInnerHTML 注入的，
    // 实测挂载后补的 class 会丢（渲染结果里只剩 class=""），交给 CSS 选择器反而稳。
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
 * 把视频嵌入放回正文的**原位**，并回传按出现顺序排好的 embeds（sentinel 的下标即数组下标）。
 *
 * 三条规则：
 * 1. 认得平台的视频 iframe（B 站 / YouTube / Vimeo / 腾讯 / 优酷），**就地**换成 sentinel，
 *    交给自家播放器渲染（带 16:9 占位，加载时不会跳版）；
 * 2. 只在链接里出现地址的（最常见：正文就一句「视频地址」加个链接），插到**该链接所在块之后**，
 *    原链接保留；
 * 3. 实在定位不到就追加到正文末尾，至少不丢。
 *
 * **认不出平台的 iframe 保持原样**（不删、也不包成视频框）：音频播放器几乎都是这类 iframe
 * （Spotify / 小宇宙 / 网易云 / 播客托管），删掉就等于把播放器丢了；
 * 它们由 normalizeArticleHtml 统一加 sandbox 后按原尺寸加载。
 *
 * 早期实现是「删掉所有 iframe，再把 sentinel 全部追加到正文末尾」，
 * 于是播放器跑到文末、和底部附件区里的同一个播放器重复出现两遍。
 */
function placeEmbedsInPlace(
  bodyHtml: string,
  embeds: readonly VideoEmbed[],
): { html: string; embeds: VideoEmbed[] } {
  if (embeds.length === 0) return { html: bodyHtml, embeds: [] };
  const doc = new DOMParser().parseFromString(bodyHtml, "text/html");
  const ordered: VideoEmbed[] = [];
  // 用规范化身份去重：正则扫出的地址里 `&` 是 `&amp;`，DOM 里是 `&`，
  // 直接比字符串会把同一个播放器当成两个（正文里就会出现两个一样的播放器）
  const orderedKeys = new Set<string>();
  /** 登记一个嵌入，返回对应的 sentinel 节点 */
  const sentinelFor = (embed: VideoEmbed): HTMLElement => {
    const el = doc.createElement("div");
    el.setAttribute("data-rss-embed", String(ordered.length));
    ordered.push(embed);
    orderedKeys.add(canonicalEmbedKey(embed.src));
    return el;
  };

  // 规则 1：认得的视频平台 iframe 就地换成 sentinel（换成带 16:9 占位的自家播放器）；
  // **认不出的保留原样** —— 音频播放器（Spotify / 小宇宙 / 网易云…）都在这类里，
  // 删掉就等于把播放器丢了。它们由 normalizeArticleHtml 加 sandbox 后原样加载。
  doc.body.querySelectorAll("iframe").forEach((frame) => {
    const embed = identifyVideoEmbed(frame.getAttribute("src") ?? "");
    if (!embed) return;
    // 同一个播放器在正文里出现两次：只留第一处，第二处删掉（参数不同的会算作两个，不受影响）
    if (orderedKeys.has(canonicalEmbedKey(embed.src))) {
      frame.remove();
      return;
    }
    frame.replaceWith(sentinelFor(embed));
  });

  // 规则 2 / 3：只在链接里出现的，插到链接所在块之后；找不到就追加末尾
  for (const embed of embeds) {
    if (orderedKeys.has(canonicalEmbedKey(embed.src))) continue;
    const anchor = findEmbedAnchor(doc, embed);
    const sentinel = sentinelFor(embed);
    if (!anchor) {
      doc.body.appendChild(sentinel);
      continue;
    }
    // 整段就是那个链接时插在段落之后（更接近「视频在正文里的位置」）
    const block = anchor.closest("p, li, blockquote, figure, td");
    if (block && block !== doc.body) block.after(sentinel);
    else anchor.after(sentinel);
  }
  return { html: doc.body.innerHTML, embeds: ordered };
}

/** 找正文里承载这个嵌入的链接（用同一套识别逻辑比对，避免两处规则不一致） */
function findEmbedAnchor(doc: Document, embed: VideoEmbed): Element | null {
  for (const anchor of doc.querySelectorAll("a[href]")) {
    const found = identifyVideoEmbed(anchor.getAttribute("href") ?? "");
    if (found && found.src === embed.src) return anchor;
  }
  return null;
}

/**
 * 元信息行里的一项 */
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
  const body = renderContent(raw, article.content_type);
  // iframe 就地换成 sentinel（认不出的删掉），只在链接里出现的插到链接之后
  const placed = placeEmbedsInPlace(body, embeds);
  return {
    html: normalizeArticleHtml(placed.html, article.link),
    embeds: placed.embeds,
  };
}

export function ArticleView({
  article,
  feed,
  onToggleStarred,
  onOpenLink,
  onOpenExternal,
  onShare,
  fontSize,
  proxyArg,
}: ArticleViewProps): JSX.Element {
  const [fullContent, setFullContentState] = useState<ExtractedContent | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  /** 是否已经为当前文章尝试过抓取全文（用于区分「抓取中」与「抓不到」） */
  const [hasAttemptedFull, setHasAttemptedFull] = useState(false);
  /**
   * 正文链接上的右键菜单。WebView 的原生菜单被全局右键守卫屏蔽了（lib/contextMenuGuard.ts），
   * 不补这个入口的话，正文里的链接地址根本拿不到 —— 只能点开，没法复制。
   */
  const [linkMenu, setLinkMenu] = useState<{ href: string; x: number; y: number } | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  /**
   * AI 翻译：把译文逐段插回原文后的 HTML（null = 当前还没翻译）+ 进度。
   * 逐段对照，而不是把整篇译文堆在文末——读者不必来回对照。
   */
  const [interleavedHtml, setInterleavedHtml] = useState<string | null>(null);
  const [translateProgress, setTranslateProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);
  /**
   * 每次翻译运行的令牌。回调里拿它跟当前值比对：
   * 不一致说明这次运行已经作废（用户点了停止 / 换了文章 / 正文被替换），
   * 就**不许再写 state** —— 否则上一篇文章的译文会写进这一篇（真实踩过）。
   */
  const translateRunRef = useRef(0);
  /**
   * 翻译设置（在文章页面选）：按网关分组的模型 + 源/目标语言。
   * 设置页只负责增删改网关，用哪个网关的哪个模型在这里定。
   */
  const [picker, setPicker] = useState<TranslatePickerState | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** 下拉的根容器（按钮 + 菜单）：点它之外的地方才收起 */
  const pickerRootRef = useRef<HTMLDivElement | null>(null);
  const { ref: linkMenuRef, position: linkMenuPosition } = useMenuPosition<HTMLDivElement>(linkMenu);

  // 切换文章时重置状态（已抓取过全文的命中缓存，直接显示）
  useEffect(() => {
    // 作废在途翻译：它的回调属于上一篇文章，绝不能再写这一篇的 state
    translateRunRef.current += 1;
    setFullContentState(getFullContent(article.id));
    setHasAttemptedFull(Boolean(getFullContent(article.id)));
    // 切换文章时重置翻译状态（译文属于上一篇文章，不跨篇残留）
    setInterleavedHtml(null);
    setTranslateProgress(null);
    setTranslateError(null);
    setTranslating(false);
  }, [article.id]);

  const contentKind = detectContentKind(article.content ?? "", article.content_type);
  /** 正文内容种类：html / text / markdown / image / external / empty */
  const summaryText = plainTextLength(article.content ?? "");
  /**
   * 正文疑似在这里就断了（源只给了摘要）。只用来把工具栏按钮的悬浮提示说清楚 ——
   * 正文末尾不再挂任何说明，入口常驻在工具栏。
   */
  const bodyTruncated = looksTruncated(article.content ?? "");

  // 正文渲染（按内容种类分发 + 懒加载回填 + 图片走本地代理协议 + 视频嵌入单独成块）
  const { html: renderedHtml, embeds } = useMemo(
    () => buildRenderedHtml(article, fullContent),
    [article, fullContent],
  );
  const contentRef = useRef<HTMLDivElement | null>(null);

  // 阅读时长：按渲染后正文的纯文本长度估算（正文种类不同，长度口径也不同）
  const renderedTextLength: number = plainTextLength(renderedHtml);
  const minutes = readingMinutes(renderedTextLength);

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

  /**
   * 订阅源给的原生音视频（播客音频 / 视频文件），且**正文里还没有**的。
   *
   * 只挑音频与视频：图片在正文里本来就会渲染（缺失的由首图兜底），
   * 其它文件（PDF / 压缩包等）不再单独列出来 —— 附件区已移除。
   * 正文里的嵌入不在这里：它们已经由 placeEmbedsInPlace 放回原位了。
   *
   * 必须去重：很多源既在正文里放播放器、又把它作为 enclosure 给一份，
   * 不看正文就补一个播放器 → 同一段音频出现两个播放器。
   */
  const inlineMedia = useMemo<MediaItem[]>(() => {
    // 正文里已经能播的地址（audio / video / source 的 src）
    const playable = new Set<string>();
    // 正文里已经放了播放器的嵌入（按播放器地址与观看页地址比对）
    const embedded = new Set<string>();
    for (const embed of embeds) {
      embedded.add(embed.src);
      embedded.add(embed.watchUrl);
    }
    const doc = new DOMParser().parseFromString(renderedHtml, "text/html");
    doc.querySelectorAll("audio[src], video[src], source[src]").forEach((el) => {
      const src = el.getAttribute("src") ?? "";
      if (!src) return;
      // 原文里可能是相对地址：原样与解析成绝对地址两种写法都记上，避免比对漏掉
      playable.add(src);
      const resolved = resolveImgSrc(src, article.link);
      if (resolved) playable.add(resolved);
    });

    return (article.media ?? []).filter((item) => {
      const kind = classifyMedia(item.content_type, item.url);
      if (kind !== "audio" && kind !== "video") return false;
      const resolved = resolveImgSrc(item.url, article.link) || item.url;
      return !playable.has(item.url) && !playable.has(resolved) && !embedded.has(item.url);
    });
  }, [article.media, renderedHtml, embeds, article.link]);

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
  }, [renderedHtml, interleavedHtml, embeds]);

  // 图片经 rssimg 协议加载失败时回退直连原始 https 地址。
  // img 的 error 事件不冒泡，需在捕获阶段监听。
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    /**
     * 图片经 rssimg 协议加载失败时回退直连原始 https 地址（img 的 error 不冒泡，故捕获监听）。
     * 「加载前先给一块浅底」不在这里管：它由 CSS 按 `img[width][height]` 命中，
     * 不依赖任何挂载后补的标记 —— 正文是 dangerouslySetInnerHTML 注入的，那类标记实测会丢。
     */
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
      // 第二层：两条链路都失败 → 隐藏，避免留下破图图标（连带把预留高度一起收掉）
      img.style.display = "none";
    };

    container.addEventListener("error", onError, true);
    return () => container.removeEventListener("error", onError, true);
  }, [renderedHtml]);

  const handleFetchFull = async (): Promise<void> => {
    if (!article.link) return;
    // 切换文章时的缓存回填（正文已经显示着就跳过）；当前文章已有全文时再点 = 重新抓取
    const cached = getFullContent(article.id);
    if (cached && !fullContent) {
      setFullContentState(cached);
      return;
    }
    setLoadingFull(true);
    setHasAttemptedFull(true);
    try {
      const html = await rssService.fetchArticleHtml(article.link, proxyArg);
      const extracted = extractArticleContent(html);
      // 正文文字够多，**或**正文本身就是媒体（博客正文只有一条播放器的情形）。
      // 判据必须用 hasMedia 而不是 embeds：embeds 只含认得出平台的**视频**，
      // 而音频播放器（网易云外链等）是认不出平台的 iframe ——
      // 只看 embeds 会把「整篇只有一个音频播放器」的帖子判成没抓到而静默丢弃。
      const hasEmbeddedMedia = extracted.hasMedia && embeds.length === 0;
      if (
        hasEmbeddedMedia ||
        (extracted.textLength >= MIN_USABLE_TEXT && extracted.textLength > summaryText)
      ) {
        setFullContent(article.id, extracted);
        setFullContentState(extracted);
        // 成功与失败都不发通知：唯一的反馈是按钮状态（获取中… → 已获取全文）与正文本身
        return;
      }
      // 抓不到（站点拦截 / 正文靠 JS 渲染 / 确实没有更多）就静默结束，成功也不发通知：
      // 这个入口唯一的反馈是按钮状态与正文本身，不弹提示、不进消息中心
    } catch {
      // 网络或解析出错同样静默
    } finally {
      setLoadingFull(false);
    }
  };

  /**
   * 翻译设置：进页面时读一次（按网关分组的模型 + 语言）。
   * 改动立即落盘，下次翻译就用新的选择。
   */
  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void loadTranslatePicker()
        .then((state) => {
          if (!cancelled) setPicker(state);
        })
        .catch(() => {
          // 未配置 / 还没存过配置：不显示翻译选择区即可
        });
    };
    load();
    // 在设置里新加了网关 / 模型之后，回到文章页要能立刻用上，而不是等下次重新打开文章
    const unsubscribe = onTranslateConfigChange(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // 下拉打开时：点外面或按 Esc 收起。
  // 这里必须用 mousedown + 「目标是否在容器内」判断（与标题栏的下拉同一套写法）：
  // 挂在 click 上会踩到「打开菜单的那次点击还在往 document 冒泡，而同一次点击又把它关掉」
  // —— 表现就是菜单一闪都不闪，等于打不开。
  useEffect(() => {
    if (!pickerOpen) return;
    const onMouseDown = (e: MouseEvent): void => {
      if (pickerRootRef.current && !pickerRootRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  /** 选定「哪个网关的哪个条目」：本地先更新（界面立刻反馈），再落盘 */
  const handleSelectTarget = async (
    providerId: string,
    modelId: string,
    label: string,
  ): Promise<void> => {
    setPicker((p) =>
      p ? { ...p, activeProviderId: providerId, currentModel: modelId, currentLabel: label } : p,
    );
    setPickerOpen(false);
    try {
      await selectTranslationTarget(providerId, modelId);
    } catch {
      // 落盘失败不回滚：本次会话仍按新选择翻译
    }
  };

  const handleLangChange = async (source: string, target: string): Promise<void> => {
    setPicker((p) => (p ? { ...p, sourceLang: source, targetLang: target } : p));
    try {
      await setTranslateLanguages(source, target);
    } catch {
      // 同上
    }
  };

  /**
   * 正文 HTML 变了（例如刚点完「获取全文」）就作废已有译文：
   * 交错译文是按当时的 HTML 拼出来的，不复位的话会显示上一版正文的对照。
   * 同样要作废在途翻译（它在拼旧 HTML）。
   */
  useEffect(() => {
    translateRunRef.current += 1;
    setInterleavedHtml(null);
    setTranslateProgress(null);
    setTranslating(false);
  }, [renderedHtml]);

  /** 停止翻译：作废本次运行（后续批次不再发出），已翻好的部分保留 */
  const cancelTranslate = (): void => {
    translateRunRef.current += 1;
    setTranslating(false);
    setTranslateProgress(null);
  };

  const handleTranslate = async (): Promise<void> => {
    const run = translateRunRef.current + 1;
    translateRunRef.current = run;
    const isStale = (): boolean => translateRunRef.current !== run;
    setTranslating(true);
    setTranslateError(null);
    setTranslateProgress(null);
    try {
      const config = await loadTranslateConfig();
      if (isStale()) return;
      if (!isTranslateConfigured(config)) {
        setTranslateError(
          "翻译还没配好：到「设置 → 翻译」填好服务商的地址与模型（机器翻译服务商填 API 密钥即可）",
        );
        return;
      }
      // 翻「当前实际展示的正文」：点过「获取全文」就是抓到的全文（renderedHtml 已包含它）
      const blocks = extractTranslatableBlocks(renderedHtml);
      if (blocks.length === 0) {
        setTranslateError("这篇文章没有可翻译的正文");
        return;
      }
      // 从前往后依次翻，每翻完一段就把这一段插进正文显示出来（不等整篇翻完）
      const partial: (string | null)[] = new Array(blocks.length).fill(null);
      const failedIndexes = new Set<number>();
      const result = await translateBlocks(
        blocks,
        config,
        (index, text, done, total) => {
          if (isStale()) return; // 已停止 / 已换文章：不许动 state
          partial[index] = text;
          // 失败的段落标记出来：界面会在原位显示「本段未能翻译」，而不是凭空少一行
          if (!text) failedIndexes.add(index);
          setInterleavedHtml(interleaveTranslations(renderedHtml, partial, failedIndexes));
          setTranslateProgress({ done, total });
        },
        article.title ?? undefined,
        isStale,
        // 流式中间结果：某段才翻了一半也先贴上去，边生成边看，不用等整批回来。
        // 用同一份 partial 数组覆盖写，完成时会被 onBlock 的最终译文替换掉。
        (index, text) => {
          if (isStale()) return;
          if (partial[index] === text) return; // 内容没变就别重排 DOM
          partial[index] = text;
          setInterleavedHtml(interleaveTranslations(renderedHtml, partial, failedIndexes));
        },
      );
      if (isStale()) return;
      const okCount = result.translations.filter((t) => (t ?? "").trim()).length;
      if (okCount === 0) {
        throw result.firstError ?? new Error("翻译服务未返回任何译文");
      }
      if (result.failed > 0) {
        setTranslateError(`有 ${result.failed} 段未能翻译（其余已按段显示）`);
      }
    } catch (err) {
      if (!isStale()) setTranslateError(`翻译失败：${String(err)}`);
    } finally {
      if (!isStale()) {
        setTranslating(false);
        setTranslateProgress(null);
      }
    }
  };

  /**
   * 正文链接的右键菜单：给出「复制链接地址」。
   *
   * 两个要点：
   * 1. WebView 的原生菜单被全局右键守卫屏蔽了（lib/contextMenuGuard.ts），不补这个入口
   *    就只能点开、拿不到地址；
   * 2. 用原生监听器而不是 React 的 onContextMenu —— 正文是 dangerouslySetInnerHTML 注入的，
   *    实测浏览器真实右键（button=2 / trusted）走不到 React 的合成事件上，只有脚本派发才会
   *    触发。linkGuard 处理点击用的是同一套路。
   */
  useEffect(() => {
    const onContextMenu = (event: MouseEvent): void => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as
        | HTMLAnchorElement
        | null;
      if (!anchor || !anchor.closest(".article-view-content")) return;
      const url = resolveAnchorUrl(anchor);
      if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return;
      event.preventDefault();
      setLinkCopied(false);
      setLinkMenu({ href: url.toString(), x: event.clientX, y: event.clientY });
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  const copyLinkAddress = async (): Promise<void> => {
    if (!linkMenu) return;
    try {
      await navigator.clipboard.writeText(linkMenu.href);
      setLinkCopied(true);
      // 短暂显示「已复制」再收起，让用户确认复制成功
      window.setTimeout(() => {
        setLinkMenu(null);
        setLinkCopied(false);
      }, 700);
    } catch {
      setLinkMenu(null);
    }
  };

  // 点击别处或再次右键时收起链接菜单
  useEffect(() => {
    if (!linkMenu) return;
    const close = (): void => setLinkMenu(null);
    document.addEventListener("click", close);
    document.addEventListener("contextmenu", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("contextmenu", close);
    };
  }, [linkMenu]);

  // 入口常驻：只要文章有原文链接就一直在。抓到全文后按钮不消失，只是换成「已获取全文」，
  // 否则用户刚点完就看到入口没了，会以为功能出问题、也没法重抓一次。
  const canFetchFull = Boolean(article.link);

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
          {/* 有原生音视频时才提示（附件区已移除，这里只报「这篇带音频/视频」） */}
          {inlineMedia.length > 0 && (
            <MetaChip icon="attachment" text={`${inlineMedia.length} 个音视频`} />
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
            {/* 常驻入口：不必等系统判断「正文偏短」才给，任何文章都能手动抓一次原文 */}
            {canFetchFull && (
              <button
                onClick={() => void handleFetchFull()}
                disabled={loadingFull}
                title={
                  fullContent
                    ? "已经拿到原文全文，再点一次可重新抓取"
                    : bodyTruncated
                      ? "订阅源只给了摘要（正文以省略号收尾），抓原文页可读全文"
                      : "抓取原文页，还原完整正文"
                }
              >
                <span className="material-symbols-rounded">
                  {loadingFull ? "progress_activity" : fullContent ? "check" : "article"}
                </span>
                {loadingFull ? "获取中…" : fullContent ? "已获取全文" : "获取全文"}
              </button>
            )}
          </>
        )}
        {/* 分享：没有原文链接的文章也能分享摘要 / 存成文件，所以不放进 link 判断里 */}
        <button
          onClick={(e) => {
            if (!onShare) return;
            const rect = e.currentTarget.getBoundingClientRect();
            onShare({ left: rect.right, top: rect.bottom + 6, align: "right" });
          }}
          title="分享这篇文章"
        >
          <span className="material-symbols-rounded">share</span>
          分享
        </button>
        {/* 翻译设置：按网关分组的模型选择（点开是「网关 → 模型」列表，当前项打勾）+ 源/目标语言 */}
        {picker && picker.groups.length > 0 && (
          <>
            <label className="article-view-lang" title="源语言（自动检测 = 由模型判断）">
              <span className="article-view-lang-cap">源</span>
              <select
                value={picker.sourceLang}
                onChange={(e) => void handleLangChange(e.target.value, picker.targetLang)}
              >
                {SOURCE_LANGUAGE_OPTIONS.map((lang) => (
                  <option key={lang} value={lang}>
                    {lang}
                  </option>
                ))}
              </select>
            </label>
            <label className="article-view-lang" title="目标语言">
              <span className="article-view-lang-cap">译</span>
              <select
                value={picker.targetLang}
                onChange={(e) => void handleLangChange(picker.sourceLang, e.target.value)}
              >
                {LANGUAGE_OPTIONS.map((lang) => (
                  <option key={lang} value={lang}>
                    {lang}
                  </option>
                ))}
              </select>
            </label>
            <div className="toolbar-dropdown translate-picker" ref={pickerRootRef}>
              <button
                type="button"
                className="translate-picker-btn"
                onClick={() => setPickerOpen((o) => !o)}
                title="选择翻译使用的服务商与模型"
              >
                <span className="translate-picker-current">
                  {picker.currentLabel || "选择模型"}
                </span>
                <span className="material-symbols-rounded">expand_more</span>
              </button>
              {pickerOpen && (
                <div className="dropdown-menu translate-picker-menu">
                  {picker.groups.map((group) => (
                    <div className="translate-picker-group" key={group.providerId}>
                      {/* 机器翻译服务没有模型可选，整组就是一条：不再显示「服务名 + 无需模型」
                          两行（同一件事说两遍），服务名直接落在可点的那一条上 */}
                      {!group.machine && (
                        <div className="translate-picker-group-label">{group.displayName}</div>
                      )}
                      {group.items.map((item) => {
                        const selected =
                          group.providerId === picker.activeProviderId &&
                          item.value === picker.currentModel;
                        return (
                          <button
                            key={`${group.providerId}:${item.value}`}
                            type="button"
                            className={`dropdown-item translate-picker-item ${selected ? "selected" : ""}`}
                            onClick={() =>
                              void handleSelectTarget(group.providerId, item.value, item.label)
                            }
                          >
                            <span className="translate-picker-item-name">{item.label}</span>
                            {selected && (
                              <span className="material-symbols-rounded">check</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
        {/* 配了网关但目录里没有模型：说明缺什么，别让选择器凭空消失 */}
        {picker && picker.groups.length === 0 && picker.needsSetup && (
          <span className="article-view-hint">
            翻译未就绪：到「设置 → 翻译」添加模型
          </span>
        )}
        {/* AI 翻译：有正文时可用；翻译进行中时同一个按钮变成「停止」 */}
        {contentKind !== "empty" && contentKind !== "image" && contentKind !== "external" && (
          <button
            onClick={() => (translating ? cancelTranslate() : void handleTranslate())}
            title={
              translating
                ? "停止翻译（已经翻好的部分会保留）"
                : interleavedHtml
                  ? "按当前服务商与语言重新翻译一遍"
                  : "用 AI 翻译这篇正文（译文逐段跟在原文后面）"
            }
          >
            <span className="material-symbols-rounded">
              {translating ? "close" : interleavedHtml ? "refresh" : "public"}
            </span>
            {translating ? "停止" : interleavedHtml ? "重新翻译" : "翻译"}
          </button>
        )}
        {/* 翻译进度：挨着翻译按钮放（原在文末的一行挪到这里） */}
        {translating && (
          <span className="translate-progress">
            <span className="material-symbols-rounded">progress_activity</span>
            正在翻译
            {translateProgress ? ` ${translateProgress.done}/${translateProgress.total}` : ""}
          </span>
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

      {/* 正文内容（译文按段插在原文之后；data-link-base 供全局链接守卫解析相对链接） */}
      <div
        ref={contentRef}
        className={`article-view-content kind-${contentKind}`}
        data-link-base={article.link ?? undefined}
        style={{ fontSize: `${fontSize}px` }}
        dangerouslySetInnerHTML={{ __html: interleavedHtml ?? renderedHtml }}
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
      {/* AI 译文：已按段插进上面的正文里（interleavedHtml）；进度与失败都报在工具栏，
          文末不再重复提示「正在翻译」 */}
      {translateError && (
        <p className="article-empty-hint translation-error">
          <span className="material-symbols-rounded">error</span>
          {translateError}
        </p>
      )}

      {/* 订阅源给的原生音视频（播客音频 / 视频文件）：它们在正文里没有位置可放，
          就接在正文之后就地播放。不再单独开一块「附件」区域 —— 图片本来就在正文里、
          正文里的播放器也已经按原位插好了，附件区只会把同一份媒体再列一遍。 */}
      {inlineMedia.length > 0 && (
        <div className="article-inline-media">
          {inlineMedia.map((item) =>
            videoWatchPageHost(item.url) ? (
              // 平台观看页地址不能当媒体源播放，给个入口
              <button
                key={item.url}
                className="f2-btn-soft article-inline-media-open"
                onClick={() => openUrl(item.url)}
                title={item.url}
              >
                <span className="material-symbols-rounded">open_in_new</span>
                在浏览器中观看
              </button>
            ) : classifyMedia(item.content_type, item.url) === "audio" ? (
              <audio key={item.url} className="article-inline-audio" src={item.url} controls preload="none" />
            ) : (
              <video key={item.url} className="article-inline-video" src={item.url} controls preload="metadata" />
            ),
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

      {/* 正文链接的右键菜单：原生菜单被全局守卫屏蔽，这里给回「复制链接地址」 */}
      {linkMenu && (
        <div
          ref={linkMenuRef}
          className="feed-ctx-menu link-ctx-menu"
          style={{ left: linkMenuPosition.left, top: linkMenuPosition.top }}
          onClick={(e) => e.stopPropagation()}
        >
          <button className="dropdown-item" onClick={() => void copyLinkAddress()}>
            <span className="material-symbols-rounded">{linkCopied ? "check" : "insert_link"}</span>
            {linkCopied ? "已复制" : "复制链接地址"}
          </button>
          <button
            className="dropdown-item"
            onClick={() => {
              onOpenExternal?.(linkMenu.href);
              setLinkMenu(null);
            }}
          >
            <span className="material-symbols-rounded">open_in_new</span>
            在浏览器中打开
          </button>
        </div>
      )}
    {/* 划词翻译：选中正文文本后出现悬浮按钮，点开浮窗对照显示原文与译文 */}
      <SelectionTranslate containerRef={contentRef} context={article.title ?? undefined} />
    </article>
  );
}
