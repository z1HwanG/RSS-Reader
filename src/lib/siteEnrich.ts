/*
 * 文件名: siteEnrich.ts
 * 描述: 站点适配器注册表 —— 媒体只存在站点私有 API 里的订阅源，在这里按主机名分发。
 *
 * 通用提取（articleExtract / normalizeArticleHtml）能覆盖「媒体写在 HTML 里」的绝大多数
 * 站点；但有些站点的图片/视频/音频只在其私有 JSON API 里（机核 gapi、南方周末的腾讯云
 * 点播 fileId），无法用通用算法还原 —— 这类站点写一个 adapter，按 link 主机名命中。
 *
 * 新增适配器：实现 SiteAdapter 并加入 ADAPTERS，主机名匹配即自动生效，无需改调用方。
 */

import {
  applyGcoresMedia,
  gcoresApiUrl,
  gcoresMediaFromApi,
  parseGcoresLink,
} from "./gcoresEnrich";
import { pickVodMediaUrl, vodPlayInfoUrl } from "./articleExtract";
import { escapeHtml } from "./contentRender";

export type FetchText = (url: string) => Promise<string>;

export interface SiteAdapter {
  id: string;
  /** 命中的文章 link 主机名（不含协议与路径） */
  host: RegExp;
  /**
   * 原文抓回后、正文提取前调用：把 API 数据注入 HTML / 约束正文范围。
   * 抛错或返回原样都安全 —— 提取器会按原始页面继续处理。
   */
  inject?(html: string, link: string, fetchText: FetchText): Promise<string>;
  /**
   * 解析 data-rss-vod 标记（提取后调用，见 articleExtract.collectVodMarkers）：
   * 把播放器组件的 fileId 解析成直链；返回 null 时界面降级为「到原文页观看」。
   */
  resolveVod?(fileId: string, kind: "audio" | "video", fetchText: FetchText): Promise<{
    url: string;
    durationSecs?: number;
  } | null>;
}

// ===== 机核：正文图 / 视频嵌入 / 朗读与电台音频都在 gapi =====

const GCORES: SiteAdapter = {
  id: "gcores",
  host: /(^|\.)gcores\.com$/i,
  inject: async (html, link, fetchText) => {
    const parsed = parseGcoresLink(link);
    if (!parsed) return html;
    try {
      const apiJson = await fetchText(gcoresApiUrl(parsed));
      return applyGcoresMedia(html, gcoresMediaFromApi(apiJson, parsed.kind));
    } catch {
      // gapi 拿不到：按原 SSR 提取（没有嵌入与音频，但正文仍在）
      return html;
    }
  },
};

// ===== 南方周末：音视频组件的 fileId 走腾讯云点播 =====

const INFZM: SiteAdapter = {
  id: "infzm",
  host: /(^|\.)infzm\.com$/i,
  resolveVod: async (fileId, kind, fetchText) => {
    try {
      return pickVodMediaUrl(JSON.parse(await fetchText(vodPlayInfoUrl(fileId))), kind);
    } catch {
      return null;
    }
  },
};

/** 把 HTML 切到指定选择器的元素范围内；元素不存在时原样返回（走通用提取） */
function sliceHtmlTo(html: string, selector: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const el = doc.querySelector(selector);
    return el ? el.outerHTML : html;
  } catch {
    return html;
  }
}

// ===== 二丫讲梵的 wiki（VuePress vdoing 主题）：正文约束到 .content-wrapper =====
// 页面外壳的面包屑、编辑时间与上一篇/下一篇导航都带不少文字，通用评分会把它们
// 连着正文一起选进来；正文在 .content-wrapper 里（内含标题 h1 + 正文），注入时
// 直接把 HTML 切到这个范围，外壳文字从源头不再参与提取。

const ERYAJF_WIKI: SiteAdapter = {
  id: "eryajf-wiki",
  host: /(^|\.)wiki\.eryajf\.net$/i,
  inject: async (html) => sliceHtmlTo(html, ".content-wrapper"),
};

const ADAPTERS: SiteAdapter[] = [GCORES, INFZM, ERYAJF_WIKI];

/** 按文章 link 找适配器；未命中返回 null（走纯通用提取） */
export function findSiteAdapter(link: string | null | undefined): SiteAdapter | null {
  if (!link) return null;
  let host: string;
  try {
    host = new URL(link).hostname;
  } catch {
    return null;
  }
  return ADAPTERS.find((adapter) => adapter.host.test(host)) ?? null;
}

/** 原文抓回后、正文提取前的站点注入（无适配器时原样返回） */
export async function enrichArticleHtml(
  html: string,
  link: string | null | undefined,
  fetchText: FetchText,
): Promise<string> {
  const adapter = findSiteAdapter(link);
  if (!adapter?.inject || !link) return html;
  return adapter.inject(html, link, fetchText);
}

/**
 * 解析正文里的点播标记（data-rss-vod，由 articleExtract.collectVodMarkers 从
 * 南方周末等站点的播放器组件抽出）：经适配器解析出直链后换成真正的播放器；
 * 解析失败降级为「到原文页观看」，不静默丢内容。
 */
export async function resolveVodMarkers(
  html: string,
  link: string | null | undefined,
  fetchText: FetchText,
): Promise<string> {
  const adapter = findSiteAdapter(link);
  const doc = new DOMParser().parseFromString(html, "text/html");
  await Promise.all(
    Array.from(doc.querySelectorAll("[data-rss-vod]")).map(async (node) => {
      const fileId = node.getAttribute("data-rss-vod") ?? "";
      const kind = node.getAttribute("data-rss-vod-kind") === "audio" ? "audio" : "video";
      let media: { url: string; durationSecs?: number } | null = null;
      const resolve = adapter?.resolveVod;
      if (!resolve) return;
      try {
        media = (await resolve(fileId, kind, fetchText)) ?? null;
      } catch {
        // 直链解析失败：走下面的原文引导
      }
      if (media) {
        const player = doc.createElement(kind);
        player.setAttribute("src", media.url);
        player.setAttribute("controls", "");
        player.setAttribute("preload", kind === "audio" ? "none" : "metadata");
        if (kind === "video") {
          const cover = node.getAttribute("data-rss-vod-cover");
          if (cover) player.setAttribute("poster", cover);
        }
        node.replaceWith(player);
        return;
      }
      const fallback = doc.createElement("p");
      fallback.className = "article-embed-fallback";
      if (link) {
        fallback.innerHTML = `此${kind === "audio" ? "音频" : "视频"}暂时无法在应用内播放，<a href="${escapeHtml(
          link,
        )}">请到原文页观看</a>`;
      } else {
        fallback.textContent = `此${kind === "audio" ? "音频" : "视频"}暂时无法在应用内播放`;
      }
      node.replaceWith(fallback);
    }),
  );
  return doc.body.innerHTML;
}
