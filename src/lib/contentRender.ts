/*
 * 文件名: contentRender.ts
 * 描述: 文章正文的内容种类识别与渲染前置处理（纯函数，不依赖 DOM）
 *
 * 订阅源给出的正文并不都是 HTML：Atom 允许 type="text" / "text/plain"（纯文本）、
 * type="markdown"（部分博客）、以及 base64 内联的 data: URI 图片；
 * RSS 的 description 常是「按纯文本排版」的摘要（feed-rs 警告过这一点）。
 * 这些内容直接丢进 innerHTML 会挤成一坨（换行丢失）或被当成标记解析。
 * 这里统一按 content_type 分发，把它们都转成可渲染的 HTML 片段。
 */

/** 正文的渲染方式：HTML 标记 / 纯文本 / Markdown / 独立图片 / 外链正文 */
export type ContentKind = "html" | "text" | "markdown" | "image" | "external" | "empty";

/** 媒体附件的种类（决定卡片形态与图标） */
export type MediaKind = "image" | "audio" | "video" | "document" | "unknown";

/** 取 MIME 的短名：去掉参数、转小写（text/HTML; charset=utf-8 → text/html） */
export function normalizeMime(raw: string | null | undefined): string {
  return (raw ?? "").split(";")[0].trim().toLowerCase();
}

/** 地址的扩展名（不含点，小写）；取不到时返回空串 */
export function extensionOf(url: string): string {
  const path = url.split(/[?#]/)[0];
  const last = path.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  if (dot <= 0) return "";
  return last.slice(dot + 1).toLowerCase();
}

/** 各扩展名对应的 MIME（仅在订阅源没给类型时兜底） */
const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  wav: "audio/wav",
  flac: "audio/flac",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  pdf: "application/pdf",
  epub: "application/epub+zip",
  zip: "application/zip",
};

/** 依据 MIME 与扩展名判断媒体种类；两者都缺时算 unknown */
export function classifyMedia(mime: string | null | undefined, url: string): MediaKind {
  let type = normalizeMime(mime);
  // 正文嵌入播放器（Bilibili / YouTube 等）统一按视频处理
  if (type === "video/embed") return "video";
  if (!type) type = EXT_MIME[extensionOf(url)] ?? "";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  // 音频 / 视频容器被站点标成 application/octet-stream 时用扩展名兜底
  if (/^(application\/(octet-stream|ogg|x-mpegurl)|binary\/octet-stream)$/.test(type)) {
    const byExt = EXT_MIME[extensionOf(url)] ?? "";
    if (byExt.startsWith("audio/")) return "audio";
    if (byExt.startsWith("video/")) return "video";
    if (byExt.startsWith("image/")) return "image";
    // 字节流且无扩展名：无从判断，交给「未知附件」兜底而不是当成文档
    if (type.includes("octet-stream")) return "unknown";
  }
  // 视频平台的观看页（YouTube / Vimeo 的 Atom 源只给 watch 链接，MIME 还常写成
  // application/x-shockwave-flash 这类历史值）：按视频处理，便于给「播放」入口
  const watchPage = videoWatchPageHost(url);
  if (watchPage) return "video";
  if (!type) return "unknown";
  if (
    type === "text/html" ||
    type.startsWith("text/") && type !== "text/plain" && type !== "text/markdown"
  ) {
    // 网页 / 富文本：不属于可下载附件
    return "unknown";
  }
  return "document";
}

/** 视频平台观看页的判定（返回平台名，不是观看页时返回 null） */
export function videoWatchPageHost(url: string): string | null {
  let host = "";
  let path = "";
  try {
    const parsed = new URL(url);
    host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    path = parsed.pathname;
  } catch {
    return null;
  }
  if (host === "youtu.be" || host.endsWith("youtube.com") || host === "youtube-nocookie.com") {
    if (host === "youtu.be" || /^\/(watch|v|embed|shorts|live)\b/.test(path)) return "YouTube";
    return null;
  }
  if (host.endsWith("vimeo.com") && /^\/\d+/.test(path)) return "Vimeo";
  if (host.endsWith("bilibili.com") && /^\/(video|bangumi\/play)\//.test(path)) return "Bilibili";
  if (host.endsWith("v.qq.com") && /^\/(x\/)?cover\//.test(path)) return "腾讯视频";
  if (host.endsWith("youku.com") && /^\/v_show\//.test(path)) return "优酷";
  return null;
}

/** 依据 content_type 与内容特征判断正文该怎么渲染 */
export function detectContentKind(
  content: string | null | undefined,
  contentType?: string | null,
): ContentKind {
  const raw = (content ?? "").trim();
  if (!raw) return "empty";
  // 外链正文（Atom content src）：正文就是一条地址，Rust 侧把地址放在 content 里并记录类型。
  // 必须先于内容类型判断——外链正文的类型通常正是 text/html（内容在远处，而不是本地的 HTML）。
  if (/^https?:\/\/\S+$/i.test(raw)) return "external";
  const type = normalizeMime(contentType);
  if (type === "text/html" || type === "application/xhtml+xml" || type.includes("xhtml")) {
    return "html";
  }
  if (isStandaloneImageUri(raw)) return "image";
  // 外链正文：content 为空但有 src，Rust 侧把地址放在 content 里、类型照实记录
  if (/^https?:\/\//i.test(raw) && !/\s/.test(raw) && !/[<>]/.test(raw)) return "external";
  if (type === "text/plain" || type === "text/x-markdown") return isMarkdownish(raw) ? "markdown" : "text";
  if (type.includes("markdown")) return "markdown";
  if (!type && looksLikeHtml(raw)) return "html";
  if (isMarkdownish(raw)) return "markdown";
  return "text";
}

/** 内容是否带 HTML 结构特征（无 content_type 时的兜底判断） */
export function looksLikeHtml(raw: string): boolean {
  return /<\/?(p|div|br|img|a|ul|ol|li|h[1-6]|table|blockquote|figure|section|span|strong|em|pre|code|iframe|video|audio)\b[^>]*>/i.test(
    raw,
  );
}

/**
 * 内容是否更像 Markdown 而非 HTML。
 * 判据偏保守：HTML 片段（<p> 等标签）一律不算；只有出现明确 Markdown 语法才认。
 * 「行首 ## 标题」「行首 - 列表」「围栏代码块」「[文字](链接)」都满足，
 * 而普通中文段落（以「#」开头的正文很常见）不会被误判。
 */
export function isMarkdownish(raw: string): boolean {
  if (looksLikeHtml(raw)) return false;
  const s = raw.trim();
  if (/^```/m.test(s)) return true;
  if (/^#{1,6}\s+\S/m.test(s)) return true;
  if (/^\s*[-*+]\s+\S/m.test(s)) return true;
  if (/^\s*\d+\.\s+\S/m.test(s)) return true;
  if (/^\s*>\s+\S/m.test(s)) return true;
  if (/!\[[^\]]*\]\([^)\s]+/.test(s)) return true;
  if (/\[[^\]\n]+\]\([^)\s]+\)/.test(s)) return true;
  if (/^\|.*\|.*\|/m.test(s)) return true;
  return false;
}

/** 整段内容是否就是一张图片（data: URI 或单个 <img> / Markdown 图片） */
export function isStandaloneImageUri(raw: string): boolean {
  const s = raw.trim();
  if (/^data:image\//i.test(s)) return true;
  const onlyImg = s.match(/^<img\b[^>]*>$/i);
  if (onlyImg) return true;
  return /^!\[[^\]]*\]\([^)\s]+\)$/.test(s);
}

/** HTML 转义（纯文本渲染用） */
export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 纯文本转 HTML：
 * 空行分段，段内保留换行（<br>）。订阅源的纯文本摘要常靠空行分段，
 * 直接塞进 innerHTML 会丢掉全部换行。
 */
export function textToHtml(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

/** 只允许安全协议出现在链接 / 图片地址上，挡掉 javascript: 等伪协议 */
function safeUrl(raw: string): string | null {
  const url = raw.trim();
  if (!url) return null;
  if (/^(https?:|data:image\/|blob:|\/\/|\/|\.\/|\.\.\/|#)/i.test(url)) return url;
  return null;
}

/** 行内 Markdown 语法 → HTML（图片 → 链接 → 代码 → 加粗 → 斜体 → 删除线） */
export function inlineMarkdown(raw: string): string {
  let out = escapeHtml(raw);
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (whole, alt: string, src: string) => {
    const href = safeUrl(src);
    return href ? `<img src="${href}" alt="${alt}" loading="lazy">` : whole;
  });
  out = out.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)?/g,
    (_whole, text: string, href: string) => {
      const url = safeUrl(href);
      return url ? `<a href="${url}">${text}</a>` : text;
    },
  );
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return out;
}

/**
 * Markdown → HTML 片段（覆盖订阅源里实际会出现的语法）：
 * 围栏代码块、标题、引用、有序 / 无序列表、表格、分割线、段落与行内标记。
 * 这是给「正文本身以 Markdown 发布」的源用的兜底渲染，不追求完整实现。
 */
export function markdownToHtml(raw: string): string {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  const flushParagraph = (buffer: string[]): void => {
    if (buffer.length === 0) return;
    out.push(`<p>${buffer.map((line) => inlineMarkdown(line.trim())).join("<br>")}</p>`);
    buffer.length = 0;
  };

  let paragraph: string[] = [];

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块：``` 或 ~~~，保留内部原样文本
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)\s*$/);
    if (fence) {
      flushParagraph(paragraph);
      const marker = fence[1][0].repeat(3);
      const lang = fence[2];
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过结束围栏（缺失时直接到末尾）
      const cls = lang ? ` class="lang-${lang.replace(/[^\w+-]/g, "")}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    // 独立成段的 data:image（或裸图片地址）——直接作为图片输出
    if (/^\s*data:image\/[a-z0-9.+-]+;base64,/i.test(line)) {
      flushParagraph(paragraph);
      out.push(`<p><img src="${line.trim()}" alt="" loading="lazy"></p>`);
      i += 1;
      continue;
    }

    // 分割线
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flushParagraph(paragraph);
      out.push("<hr>");
      i += 1;
      continue;
    }

    // 标题
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph(paragraph);
      const level = Math.min(heading[1].length + 1, 6);
      out.push(`<h${level}>${inlineMarkdown(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    // 引用（连续 > 行并入同一块）
    if (/^\s*>/.test(line)) {
      flushParagraph(paragraph);
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${markdownToHtml(quoted.join("\n"))}</blockquote>`);
      continue;
    }

    // 表格：表头 + 分隔行 + 数据行
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      flushParagraph(paragraph);
      const cells = (row: string): string[] =>
        row
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((cell) => inlineMarkdown(cell.trim()));
      const header = cells(line);
      i += 2;
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(`<tr>${cells(lines[i]).map((c) => `<td>${c}</td>`).join("")}</tr>`);
        i += 1;
      }
      out.push(
        `<table><thead><tr>${header
          .map((c) => `<th>${c}</th>`)
          .join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`,
      );
      continue;
    }

    // 无序列表（允许缩进子项，统一按一层渲染）
    if (/^\s*[-*+]\s+\S/.test(line)) {
      flushParagraph(paragraph);
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+\S/.test(lines[i])) {
        items.push(`<li>${inlineMarkdown(lines[i].replace(/^\s*[-*+]\s+/, ""))}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // 有序列表
    if (/^\s*\d+[.)]\s+\S/.test(line)) {
      flushParagraph(paragraph);
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+\S/.test(lines[i])) {
        items.push(`<li>${inlineMarkdown(lines[i].replace(/^\s*\d+[.)]\s+/, ""))}</li>`);
        i += 1;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // 空行：结束当前段落
    if (!line.trim()) {
      flushParagraph(paragraph);
      i += 1;
      continue;
    }

    paragraph.push(line);
    i += 1;
  }

  flushParagraph(paragraph);
  return out.join("\n");
}

/** 正文转可渲染 HTML（不含图片代理改写与安全清理，那些在 ArticleView 的 DOM 环节做） */
export function renderContent(content: string, contentType?: string | null): string {
  const kind = detectContentKind(content, contentType);
  switch (kind) {
    case "html":
      return content;
    case "markdown":
      return markdownToHtml(content);
    case "image": {
      const src = extractImageSrc(content);
      return src ? `<img src="${escapeHtml(src)}" alt="" loading="lazy">` : "";
    }
    case "external": {
      const url = content.trim();
      return `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`;
    }
    case "text":
      return textToHtml(content);
    default:
      return "";
  }
}

/** 从「整段就是一张图」的内容里取出地址（Markdown 图片或 <img> 标签） */
export function extractImageSrc(raw: string): string {
  const s = raw.trim();
  if (/^data:image\//i.test(s)) return s;
  const markdown = s.match(/^!\[[^\]]*\]\(([^)\s]+)/);
  if (markdown) return markdown[1];
  const tag = s.match(/<img\b[^>]*\bsrc=["']?([^"'\s>]+)/i);
  if (tag) return tag[1];
  return "";
}

/** 去掉 HTML 标签取纯文本长度（判断「正文是否只有摘要那么短」） */
export function plainTextLength(html: string): number {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    // 标签替换为空格而不是空串：<p>ab</p><p>cd</p> 才会算成 4 个字符而不是 6 个
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

/** 估算阅读时长（分钟，最少 1 分钟）：按每分钟 400 个字符计；输入为纯文本字符数 */
export function readingMinutes(charCount: number): number {
  if (!Number.isFinite(charCount) || charCount <= 0) return 0;
  return Math.max(1, Math.round(charCount / 400));
}

/** 字节大小的可读表示（B / KB / MB / GB）；整数不带小数位（1024 → 1 KB） */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value >= 10 || unit === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  return `${text} ${units[unit]}`;
}

/** 秒数的可读表示（mm:ss 或 h:mm:ss） */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
