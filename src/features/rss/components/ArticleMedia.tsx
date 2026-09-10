/*
 * 文件名: ArticleMedia.tsx
 * 描述: 文章附件区 — 按内容种类分别渲染图片 / 音频 / 视频 / 文档卡片
 *       图片走本地 rssimg 代理（调用方已改写地址并带 data-orig-src 回退）；
 *       音视频直接内嵌原生播放器（需在 tauri.conf.json 的 CSP 里放行 media-src），
 *       播放失败（站点防盗链 / 需要登录 / 平台观看页）时给出明确提示与浏览器打开入口
 */
import { useMemo, useState } from "react";
import type { MediaItem } from "../types";
import {
  classifyMedia,
  formatBytes,
  formatDuration,
  normalizeMime,
  videoWatchPageHost,
  type MediaKind,
} from "../../../lib/contentRender";

interface ArticleMediaProps {
  /** 附件列表（图片地址已改写为本地代理协议） */
  media: MediaItem[];
  /** 正文里已经出现过的图片原始地址：附件区不再重复展示 */
  inlineImages: string[];
  /** 缩略图原始地址：正文顶部已展示，附件区跳过 */
  thumbnail?: string | null;
  /** 视频海报图地址（已代理；通常就是文章缩略图） */
  posterUrl?: string | null;
  /** 在浏览器中打开资源（由上层调用系统 opener） */
  onOpen: (url: string) => void;
}

/** 放大查看的图片 */
interface LightboxState {
  src: string;
  alt: string;
}

const KIND_ICON: Record<MediaKind, string> = {
  image: "image",
  audio: "graphic_eq",
  video: "movie",
  document: "description",
  unknown: "attach_file",
};

const KIND_LABEL: Record<MediaKind, string> = {
  image: "图片",
  audio: "音频",
  video: "视频",
  document: "文档",
  unknown: "附件",
};

/** 「其他附件」折叠区一次最多列出的条数 */
const EXTRA_LIMIT = 12;

/**
 * 附件标题：优先订阅源给的标题，其次文件名，最后退化为种类名。
 * 图片地址已被改写成本地代理协议，文件名要从代理参数里的原始地址取。
 */
function mediaLabel(item: MediaItem, kind: MediaKind): string {
  const title = item.title?.trim();
  if (title) return title;
  const path = originalPathOf(item.url);
  const name = path.split("#")[0].split("?")[0].split("/").pop() ?? "";
  if (name) {
    try {
      const decoded = decodeURIComponent(name);
      if (decoded.length <= 80) {
        // 观看页 URL 的末段不是文件名（watch?v=xxx / 12345），用平台名代替
        const host = videoWatchPageHost(item.url);
        if (host && /^(watch|v|embed|shorts|live|\d+)$/i.test(decoded)) return `${host} 视频`;
        return decoded;
      }
    } catch {
      return name;
    }
  }
  return KIND_LABEL[kind];
}

/** 取资源的原始地址路径（rssimg 代理地址取 url 参数里的原地址） */
function originalPathOf(url: string): string {
  const marker = "?url=";
  const at = url.indexOf(marker);
  if (at < 0) return url;
  const rest = url.slice(at + marker.length).split("&ref=")[0];
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

/** 卡片副行：类型 + 体积 + 时长 / 尺寸 */
function mediaMeta(item: MediaItem, kind: MediaKind): string {
  const parts: string[] = [];
  const mime = normalizeMime(item.content_type);
  // 嵌入播放器没有有意义的 MIME，用平台名代替
  if (item.embed_platform) parts.push(item.embed_platform);
  else parts.push(mime && mime !== "video/embed" ? mime : KIND_LABEL[kind]);
  const size = formatBytes(item.size);
  if (size) parts.push(size);
  const duration = formatDuration(item.duration_secs);
  if (duration) parts.push(duration);
  if (item.width && item.height) parts.push(`${item.width}×${item.height}`);
  return parts.join(" · ");
}

export function ArticleMedia({
  media,
  inlineImages,
  thumbnail,
  posterUrl,
  onOpen,
}: ArticleMediaProps): JSX.Element | null {
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);
  const [showAllExtra, setShowAllExtra] = useState(false);
  /** 播放失败的资源地址 → 失败原因（提示 + 回退到浏览器） */
  const [playErrors, setPlayErrors] = useState<Record<string, string>>({});

  const groups = useMemo(() => {
    const seen = new Set<string>();
    for (const src of inlineImages) seen.add(src);
    if (thumbnail) seen.add(thumbnail);

    const images: MediaItem[] = [];
    const audio: MediaItem[] = [];
    const video: MediaItem[] = [];
    const extra: MediaItem[] = [];
    for (const item of media) {
      if (!item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      const kind = classifyMedia(item.content_type, item.url);
      if (kind === "image") images.push(item);
      else if (kind === "audio") audio.push(item);
      else if (kind === "video") video.push(item);
      else extra.push(item);
    }
    return { images, audio, video, extra };
  }, [media, inlineImages, thumbnail]);

  const total =
    groups.images.length + groups.audio.length + groups.video.length + groups.extra.length;
  if (total === 0) return null;

  const extraShown = showAllExtra ? groups.extra : groups.extra.slice(0, EXTRA_LIMIT);

  const markPlayError = (url: string, reason: string): void => {
    setPlayErrors((prev) => (prev[url] ? prev : { ...prev, [url]: reason }));
  };

  /** 音视频卡片：能内嵌播放就内嵌，失败时给提示与浏览器入口 */
  const renderPlayer = (item: MediaItem, kind: MediaKind): JSX.Element => {
    const watchHost = videoWatchPageHost(item.url);
    const error = playErrors[item.url];
    // 平台观看页（YouTube / Vimeo）给的是网页地址，不能当媒体源播放
    const playableInline = !watchHost && !error;
    // 正文里的嵌入播放器：有 embed_src 就直接内嵌 iframe
    const embedSrc = item.embed_src ?? null;

    return (
      <div key={item.url} className="article-media-player">
        <div className="article-media-player-head">
          <span className="material-symbols-rounded article-media-icon">
            {KIND_ICON[kind]}
          </span>
          <div className="article-media-body">
            <div className="article-media-name">{mediaLabel(item, kind)}</div>
            <div className="article-media-meta">{mediaMeta(item, kind)}</div>
          </div>
          <div className="article-media-actions">
            <button className="f2-btn-soft" onClick={() => onOpen(item.url)} title="在浏览器中打开">
              <span className="material-symbols-rounded">open_in_new</span>
              浏览器打开
            </button>
          </div>
        </div>

        {embedSrc ? (
          <div className="article-embed">
            <iframe
              src={embedSrc}
              loading="lazy"
              allowFullScreen
              // 播放器只拿到脚本与同源权限，不能顶掉整页或跳转父窗口
              sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
              title={item.title ?? "视频播放器"}
            />
          </div>
        ) : playableInline ? (
          kind === "video" ? (
            <video
              className="article-media-video"
              controls
              preload="metadata"
              playsInline
              src={item.url}
              poster={posterUrl ?? undefined}
              onError={() =>
                markPlayError(item.url, "站点不允许内嵌播放（防盗链或需要登录）")
              }
            >
              你的系统 WebView 不支持内嵌视频播放，请用「浏览器打开」。
            </video>
          ) : (
            <audio
              className="article-media-audio"
              controls
              preload="metadata"
              src={item.url}
              onError={() =>
                markPlayError(item.url, "站点不允许内嵌播放（防盗链或需要登录）")
              }
            />
          )
        ) : (
          <div className="article-media-fallback">
            <span className="material-symbols-rounded">info</span>
            {watchHost
              ? `${watchHost} 的条目只提供观看页地址，应用内无法播放。`
              : error}
            <button className="f2-btn-soft" onClick={() => onOpen(item.url)}>
              <span className="material-symbols-rounded">play_arrow</span>
              去浏览器播放
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="article-media">
      <div className="article-media-title">
        <span className="material-symbols-rounded">attachment</span>
        附件（{total}）
      </div>

      {groups.images.length > 0 && (
        <div className="article-media-grid">
          {groups.images.map((item) => (
            <button
              key={item.url}
              className="article-media-image"
              title={mediaLabel(item, "image")}
              onClick={() => setLightbox({ src: item.url, alt: mediaLabel(item, "image") })}
            >
              <img
                src={item.url}
                alt={mediaLabel(item, "image")}
                loading="lazy"
                data-orig-src={item.url}
              />
              <span className="article-media-image-meta">{mediaMeta(item, "image")}</span>
            </button>
          ))}
        </div>
      )}

      {groups.video.map((item) => renderPlayer(item, "video"))}
      {groups.audio.map((item) => renderPlayer(item, "audio"))}

      {extraShown.map((item) => {
        const kind = classifyMedia(item.content_type, item.url);
        return (
          <div key={item.url} className="article-media-card">
            <span className="material-symbols-rounded article-media-icon">
              {KIND_ICON[kind]}
            </span>
            <div className="article-media-body">
              <div className="article-media-name">{mediaLabel(item, kind)}</div>
              <div className="article-media-meta">{mediaMeta(item, kind)}</div>
            </div>
            <div className="article-media-actions">
              <button className="f2-btn-soft" onClick={() => onOpen(item.url)}>
                <span className="material-symbols-rounded">open_in_new</span>
                打开
              </button>
            </div>
          </div>
        );
      })}

      {groups.extra.length > EXTRA_LIMIT && (
        <button className="article-media-more" onClick={() => setShowAllExtra((v) => !v)}>
          <span className="material-symbols-rounded">
            {showAllExtra ? "expand_less" : "expand_more"}
          </span>
          {showAllExtra ? "收起附件" : `还有 ${groups.extra.length - EXTRA_LIMIT} 个附件`}
        </button>
      )}

      {lightbox && (
        <div className="article-lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox.src} alt={lightbox.alt} data-orig-src={lightbox.src} />
          <div className="article-lightbox-hint">点击任意处关闭 · {lightbox.alt}</div>
        </div>
      )}
    </section>
  );
}
