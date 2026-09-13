/*
 * 文件名: gcoresEnrich.ts
 * 描述: 机核（gcores.com）正文媒体增强（纯函数，不依赖网络；API 数据由调用方经 Rust 通道取回）
 *
 * 机核是 React SPA：后端用爬虫 UA 重试能拿到 SSR 正文（见 feed.rs 的壳页重试），
 * 但 SSR 里视频嵌入只是懒加载占位符，音频（文章朗读、电台节目）完全不在页面里。
 * 机核自己的 JSON API（gapi）有全部数据：
 * - 文章：attributes.content 是 Draft.js JSON，entityMap 的 EMBED 实体带真实播放器
 *   iframe（B 站等）；attributes["speech-path"] 是 TTS 朗读音频的文件名。
 * - 电台（include=media）：included 里 type=medias 的 attributes.audio 是音频文件名。
 * 音频文件统一落在 https://alioss.gcores.com/uploads/audio/{文件名}（实测可直连、支持 Range）。
 */

export interface GcoresLink {
  kind: "articles" | "radios";
  id: string;
}

/** 识别机核文章 / 电台链接（RSS 里的 link 都指向 www.gcores.com） */
export function parseGcoresLink(link: string | null | undefined): GcoresLink | null {
  if (!link) return null;
  const m = link.match(/^https?:\/\/(?:www\.)?gcores\.com\/(articles|radios)\/(\d+)(?:[/?#]|$)/i);
  if (!m) return null;
  return { kind: m[1].toLowerCase() as GcoresLink["kind"], id: m[2] };
}

/** 机核 JSON API 地址（电台必须带 include=media，否则不给音频实体） */
export function gcoresApiUrl(link: GcoresLink): string {
  return link.kind === "radios"
    ? `https://www.gcores.com/gapi/v1/radios/${link.id}?include=media`
    : `https://www.gcores.com/gapi/v1/articles/${link.id}`;
}

const AUDIO_BASE = "https://alioss.gcores.com/uploads/audio/";

/** 音频文件名 → 完整地址；文件名不合预期时返回 null（防止 API 异常值污染 src） */
function audioUrl(filename: unknown): string | null {
  if (typeof filename !== "string" || !/^[\w-]+\.(?:mp3|m4a|aac)$/i.test(filename)) return null;
  return AUDIO_BASE + filename;
}

export interface GcoresMedia {
  /** 按文档顺序排列的 EMBED 播放器 HTML（iframe 等，来自 Draft.js 实体） */
  embeds: string[];
  /** 按文档顺序排列的正文图片（Draft.js IMAGE 实体；SSR 里只有 loadingPlaceholder 占位符） */
  images: { src: string; width?: number; height?: number }[];
  /** 朗读 / 电台音频地址（API 没给或文件名异常时为 null） */
  audio: string | null;
}

/** 图片文件名 → 完整地址：文件名形如 {hash}-2560-1440.webp，落在 image.gcores.com。
 *  加 OSS 缩放参数压到 1280 宽（limit_1 不放大），gif 动图不动以免丢帧。 */
function imageUrl(filename: unknown): { src: string; width?: number; height?: number } | null {
  if (typeof filename !== "string") return null;
  const m = filename.match(/^([a-f0-9]{16,40}-\d+-\d+)\.(webp|jpe?g|png|gif)$/i);
  if (!m) return null;
  const ext = m[2].toLowerCase();
  const src =
    ext === "gif"
      ? `https://image.gcores.com/${m[0]}`
      : `https://image.gcores.com/${m[0]}?x-oss-process=image/resize,limit_1,m_lfit,w_1280/quality,q_90`;
  return { src };
}

/** 从 gapi JSON 里取出 EMBED 播放器（按文档顺序）与音频地址 */
export function gcoresMediaFromApi(apiJson: string, kind: GcoresLink["kind"]): GcoresMedia {
  const empty: GcoresMedia = { embeds: [], images: [], audio: null };
  let data: unknown;
  try {
    data = JSON.parse(apiJson);
  } catch {
    return empty;
  }
  const raw = data as {
    data?: Record<string, unknown>;
    /** JSON:API 的 included 在响应顶层，不在 data 下 */
    included?: Array<{ type?: string; attributes?: Record<string, unknown> }>;
  };
  const root = raw.data;
  if (!root) return empty;
  const attrs = (root.attributes ?? {}) as Record<string, unknown>;

  const media: GcoresMedia = { embeds: [], images: [], audio: null };
  const takeAudio = (filename: unknown): void => {
    if (!media.audio) media.audio = audioUrl(filename);
  };

  if (kind === "radios") {
    for (const entry of raw.included ?? []) {
      if (entry?.type === "medias") takeAudio(entry.attributes?.audio);
    }
  } else {
    takeAudio(attrs["speech-path"]);
    // Draft.js 正文：按 block 顺序取 EMBED / IMAGE 实体
    try {
      const draft = JSON.parse((attrs.content as string | undefined) ?? "") as {
        blocks?: Array<{ entityRanges?: Array<{ key?: number | string }> }>;
        entityMap?: Record<string, { type?: string; data?: Record<string, unknown> }>;
      };
      const map = draft.entityMap ?? {};
      for (const block of draft.blocks ?? []) {
        for (const range of block.entityRanges ?? []) {
          const entity = range.key == null ? undefined : map[String(range.key)];
          if (!entity) continue;
          if (entity.type === "EMBED" && typeof entity.data?.content === "string") {
            media.embeds.push(entity.data.content);
          } else if (entity.type === "IMAGE") {
            const image = imageUrl(entity.data?.path);
            if (image) {
              const width = entity.data?.width;
              const height = entity.data?.height;
              if (typeof width === "number" && width > 1) image.width = width;
              if (typeof height === "number" && height > 1) image.height = height;
              media.images.push(image);
            }
          }
        }
      }
    } catch {
      // content 不是 Draft.js JSON（旧文章等）：当没有嵌入处理
    }
  }
  return media;
}

/**
 * 把 API 里的图片、播放器与音频注入 SSR HTML：
 * 1. 正文约束到 .story-show（游戏资料卡、右栏「最热资讯 / 文章精选」等站点外壳全部丢弃）；
 * 2. atomic 块占位符（懒加载空壳 / loadingPlaceholder）按顺序换成真实图片与播放器 iframe；
 * 3. 音频（朗读 / 电台节目）接在正文末尾。
 * API 不可用时调用方会传入空的 media —— 此时只做正文约束，行为安全退化。
 */
export function applyGcoresMedia(html: string, media: GcoresMedia): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const story = doc.querySelector(".story-show, .md-RichEditor-root");
  if (story) doc.body.innerHTML = story.outerHTML;

  // 正文 atomic 块按自身类别从对应队列里取（API 与页面的块都是文档序）
  let embedIndex = 0;
  let imageIndex = 0;
  doc.querySelectorAll("figure.story_block-atomic").forEach((figure) => {
    if (figure.classList.contains("story_block-atomic-embed")) {
      if (embedIndex < media.embeds.length) figure.innerHTML = media.embeds[embedIndex];
      embedIndex += 1;
      return;
    }
    if (figure.classList.contains("story_block-atomic-image")) {
      const image = media.images[imageIndex];
      imageIndex += 1;
      // SSR 已经给出 img 的（部分文章）保留原样，只填空壳
      if (image && !figure.querySelector("img")) {
        const img = doc.createElement("img");
        img.setAttribute("src", image.src);
        img.setAttribute("loading", "lazy");
        if (image.width) img.setAttribute("width", String(image.width));
        if (image.height) img.setAttribute("height", String(image.height));
        figure.innerHTML = "";
        figure.appendChild(img);
      }
    }
  });
  for (; embedIndex < media.embeds.length; embedIndex += 1) {
    // 占位符比嵌入少（页面结构变了）：多余的追加到文末，至少不丢
    const holder = doc.createElement("div");
    holder.innerHTML = media.embeds[embedIndex];
    doc.body.appendChild(holder);
  }
  for (; imageIndex < media.images.length; imageIndex += 1) {
    const image = media.images[imageIndex];
    const img = doc.createElement("img");
    img.setAttribute("src", image.src);
    img.setAttribute("loading", "lazy");
    doc.body.appendChild(img);
  }

  if (media.audio) {
    const audio = doc.createElement("audio");
    audio.setAttribute("controls", "");
    audio.setAttribute("preload", "none");
    audio.setAttribute("src", media.audio);
    // 标记 + 提取器收走（articleExtract.collectVodMarkers）：正文块可能选不中
    // body 末尾这个位置，靠提取器插回正文顶部才不会丢
    audio.setAttribute("data-rss-audio", "");
    doc.body.appendChild(audio);
  }
  return doc.body.innerHTML;
}
