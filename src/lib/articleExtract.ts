/*
 * 文件名: articleExtract.ts
 * 描述: 原文正文提取（纯函数，输入已解析的 Document/Element，不依赖 DOMParser，便于单独验证）
 *
 * 背景：RSS 摘要过短时要抓原文全文。此前只看 article / main / 几个固定类名，
 * 取不到就用整个 <body>，再把 header / footer 删掉——结构不标准的站点（正文放在
 * 无语义 <div> 里、侧栏与正文同层、类名是 hash）会得到「侧栏 + 正文」或空内容，
 * 前端便提示「原文内容不够丰富，可能站点结构与提取器不兼容」。
 *
 * 这里的做法：
 * 1) 先去掉全局噪声（script/style/nav/aside/... 以及明显的评论、分享、广告块）；
 * 2) 语义容器（article/main/[role=main]/已知正文类名）里挑一个「文字最多」的，质量达标就用它；
 * 3) 否则用密度评分在所有候选中选最佳块：文字量为正、链接文字占比低、
 *    段落多且长的块得分高，并适当偏向更深的节点（正文块通常比站点外壳更深）；
 * 4) 若最佳块的父节点能带来明显更多文字而噪声增加不多，则上浮到父节点（正文常被
 *    拆在多个兄弟 <div> 里），随后剥离其中剩余的非正文子块。
 */

/** 提取结果 */
export interface ExtractedContent {  /** 正文 HTML */
  html: string;
  /** 命中的选择器或来源（用于诊断） */
  source: string;
  /** 去标签后的正文字符数 */
  textLength: number;
  /**
   * 正文里发现的视频嵌入（Bilibili / YouTube / Vimeo / 腾讯视频 / 优酷等）。
   * 有些博客的文章正文整个就是一条嵌入播放器、没有任何文字，
   * 这时「正文字数」会接近 0，但页面其实有内容。
   */
  embeds: VideoEmbed[];
  /**
   * 正文里是否存在**任何**媒体元素（iframe / audio / video / embed / object）。
   *
   * 与 `embeds` 的区别很重要：`embeds` 只含**认得出平台**的视频；
   * 而音频播放器（网易云外链、Spotify、播客托管…）是认不出平台的 iframe，
   * 不会进 `embeds`。只看 `embeds` 会把「整篇只有一个音频播放器」的帖子
   * 当成「什么都没抓到」而丢弃（真实案例：博客的分享歌曲帖）。
   */
  hasMedia: boolean;
}

/** 正文里的视频嵌入（iframe 播放器） */
export interface VideoEmbed {
  /** 播放器地址（协议相对地址已补全为 https） */
  src: string;
  /** 平台名（Bilibili / YouTube / …），识别不出时为 null */
  platform: string | null;
  /** 可内嵌播放（站点允许被 iframe 嵌入）时为 true，否则只给浏览器入口 */
  embeddable: boolean;
  /** 观看页地址（用于「在浏览器中打开」） */
  watchUrl: string;
  /** 标题（平台 API 可查时才填，目前仅 B 站） */
  title?: string;
  /** 封面图地址 */
  thumbnail?: string;
  /** 时长（秒） */
  durationSecs?: number;
}

/** 认得的视频平台：embed = 播放器地址特征；watch = 由播放器地址推出观看页 */
const VIDEO_PLATFORMS: {
  platform: string;
  host: RegExp;
  embeddable: boolean;
  toWatch: (url: URL) => string | null;
  thumbnail?: (url: URL) => string | null;
}[] = [
  {
    platform: "Bilibili",
    host: /(^|\.)bilibili\.com$/i,
    embeddable: true,
    toWatch: (url) => {
      const bvid = url.searchParams.get("bvid") ?? url.pathname.match(/\/video\/(BV[\w]+)/)?.[1];
      return bvid ? `https://www.bilibili.com/video/${bvid}` : null;
    },
    thumbnail: (url) => {
      const bvid = url.searchParams.get("bvid") ?? url.pathname.match(/\/video\/(BV[\w]+)/)?.[1];
      // B 站封面有固定推导规则：BV1QVbT6mEAB → i0.hdslb.com/bfs/archive/BV1QVbT6mEAB.jpg
      return bvid ? `https://i0.hdslb.com/bfs/archive/${bvid}.jpg` : null;
    },
  },
  {
    platform: "YouTube",
    host: /(^|\.)(youtube\.com|youtube-nocookie\.com)$/i,
    embeddable: true,
    toWatch: (url) => {
      const id = url.pathname.match(/\/embed\/([\w-]+)/)?.[1] ?? url.searchParams.get("v");
      return id ? `https://www.youtube.com/watch?v=${id}` : null;
    },
    thumbnail: (url) => {
      const id = url.pathname.match(/\/embed\/([\w-]+)/)?.[1] ?? url.searchParams.get("v");
      return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
    },
  },
  {
    platform: "Vimeo",
    host: /(^|\.)vimeo\.com$/i,
    embeddable: true,
    toWatch: (url) => {
      const id = url.pathname.match(/\/video\/(\d+)/)?.[1];
      return id ? `https://vimeo.com/${id}` : null;
    },
  },
  {
    platform: "腾讯视频",
    host: /(^|\.)(v\.qq\.com|qq\.com)$/i,
    embeddable: true,
    toWatch: (url) => (url.pathname.includes("/cover/") ? `https://v.qq.com${url.pathname}` : null),
  },
  {
    platform: "优酷",
    host: /(^|\.)youku\.com$/i,
    embeddable: true,
    toWatch: (url) => {
      const id = url.pathname.match(/embed\/([\w=]+)/)?.[1];
      return id ? `https://v.youku.com/v_show/id_${id}.html` : null;
    },
  },
];

/**
 * 嵌入地址的**规范化身份**：用来判断「两个地址是不是同一个播放器」。
 *
 * 为什么需要它：识别一个嵌入有两条路 —— 正则扫**原始 HTML 字符串**、以及读**解析后 DOM 的属性**。
 * 同一条地址在两者里写法不同：原始 HTML 里 `&` 写作 `&amp;`，DOM 取出来是 `&`。
 * 直接拿字符串比就会认为「不是同一个」，于是同一个播放器被登记两次、界面上出现两个。
 * 这里统一：解 HTML 实体 → 补全协议相对地址 → 只留 host + path + query。
 */
export function canonicalEmbedKey(rawSrc: string): string {
  const decoded = rawSrc.trim().replace(/&amp;/gi, "&");
  const withScheme = decoded.startsWith("//") ? `https:${decoded}` : decoded;
  try {
    const url = new URL(withScheme);
    return `${url.hostname.toLowerCase()}${url.pathname}${url.search}`;
  } catch {
    return withScheme;
  }
}

/** 由播放器地址判断平台与观看页（识别不出时返回 null） */
export function identifyVideoEmbed(rawSrc: string): VideoEmbed | null {
  const src = rawSrc.trim().startsWith("//") ? `https:${rawSrc.trim()}` : rawSrc.trim();
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  for (const entry of VIDEO_PLATFORMS) {
    if (!entry.host.test(url.hostname)) continue;
    const watchUrl = entry.toWatch(url);
    if (!watchUrl) continue;
    return {
      src: url.toString(),
      platform: entry.platform,
      embeddable: entry.embeddable,
      watchUrl,
      thumbnail: entry.thumbnail?.(url) ?? undefined,
    };
  }
  return null;
}

/** 从文本里抓出所有视频嵌入地址（用于从 HTML 字符串里补漏，如 img 的 data-* 里带播放器地址） */
export function findVideoEmbeds(html: string): VideoEmbed[] {
  const out: VideoEmbed[] = [];
  const seen = new Set<string>();
  const re = /(?:https?:)?\/\/(?:player\.bilibili\.com|www\.youtube\.com\/embed|youtube-nocookie\.com\/embed|player\.vimeo\.com|v\.qq\.com\/[^"'\s]*\/cover|player\.youku\.com)[^"'\s<)]*/gi;
  for (const match of html.matchAll(re)) {
    const embed = identifyVideoEmbed(match[0]);
    if (!embed || seen.has(embed.src)) continue;
    seen.add(embed.src);
    out.push(embed);
  }
  return out;
}

/** 提取器能接受的最小正文长度：低于它视为「没抓到正文」 */
export const MIN_USABLE_TEXT = 120;

/**
 * 页面是否是「机器人拦截 / 需要 JS」的壳：
 * 36kr 等站点对非浏览器请求返回「安全检测」页，Cloudflare 返回 challenge 页，
 * 这类页面里没有文章正文，必须与「站点结构不认识」区分开，否则用户会反复点「获取全文」。
 */
export function detectChallengePage(html: string): string | null {
  const sample = html.slice(0, 20000);
  const fingerprints: [RegExp, string][] = [
    [/安全检测|安全验证|访问验证|人机验证/, "页面返回的是安全校验页"],
    [/cf-browser-verification|cf_chl_|Just a moment\.\.\.|Checking your browser/i, "页面被 CDN 的浏览器校验拦住"],
    [/g-recaptcha|hcaptcha|turnstile/i, "页面要求通过人机验证"],
    [/enable javascript|please turn on javascript|requires javascript/i, "页面需要执行 JavaScript 才有正文"],
  ];
  for (const [pattern, reason] of fingerprints) {
    if (pattern.test(sample)) return reason;
  }
  return null;
}

/**
 * 全局噪声：这些节点在任何站点上都不是正文。
 * 注意：**不含 iframe**——正文里的视频播放器就是 iframe，
 * 必须留给 extractEmbeds 先识别成嵌入条目，再由它统一移除（顺序反了就等于把视频删掉）。
 */
const NOISE_SELECTOR = [
  "script",
  "style",
  "link",
  "meta",
  "noscript",
  "template",
  "svg",
  "canvas",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "nav",
  "aside",
  "header",
  "footer",
  "dialog",
  // ARIA 语义角色：banner/complementary/navigation/contentinfo 是页头、侧栏、导航、页脚
  '[role="banner"]',
  '[role="complementary"]',
  '[role="navigation"]',
  '[role="contentinfo"]',
].join(",");

/**
 * 互动区 / 导航等「结构性噪声」的命名特征。
 * 评论类单独一套更严的判据：评论块里链接不多，靠链接密度筛不掉，
 * 而它们常常长达数千字，会把评分与父节点上浮直接带偏（周刊页的评论区就是典型）。
 */
const COMMENT_PATTERN =
  /(^|[-_ ])(comment|comments|reply|replies|respond|discussion|disqus|isso|giscus|duoshuo|utterances)([-_ ]|$)/i;

const BOILERPLATE_PATTERN =
  /(^|[-_ ])(share|social|sharing|related|recommend|recirc|promo|newsletter|subscribe|signup|login|signin|register|advert|ads?|sponsor|banner|breadcrumb|pagination|pager|sidebar|side-bar|widget|footer|masthead|byline-social|meta-nav|nav|menu|toolbar|tags?-list|author-box|back-to-top|back2top|cookie|gdpr|paywall|popup|modal|overlay|search|search-panel|search-modal|site-header|site-footer)([-_ ]|$)/i;

/** 语义候选：站点自己声明的正文容器 */
const SEMANTIC_SELECTORS = [
  "article",
  "[itemprop=articleBody]",
  "[role=main]",
  "main",
  ".post-content",
  ".article-content",
  ".entry-content",
  ".post-body",
  ".article-body",
  ".post-entry",
  ".content-body",
  "#content-body",
  ".markdown-body",
  ".rich_media_content",
  ".article__content",
  ".article-content__body",
  ".post__content",
];

/** 链接文字占比阈值：超过则认为是导航 / 列表而非正文 */
const LINK_DENSITY_LIMIT = 0.4;

/** 语义容器的可接受下限：正文短于这个长度时继续找更合适的块 */
const SEMANTIC_MIN_TEXT = 200;

/** 上浮到父节点需要的最小收益（文字量至少多这么多，才值得扩大范围） */
const PARENT_GROWTH_MIN = 120;

/** 计算元素的纯文本长度（压缩空白） */
export function elementTextLength(el: Element): number {
  const text = el.textContent ?? "";
  return text.replace(/\s+/g, " ").trim().length;
}

/** 元素内可见图片数量（用于给包含配图的正文加分） */
function imageCount(el: Element): number {
  return el.querySelectorAll("img").length;
}

/** 链接文字占元素文字的比例（导航块通常很高） */
function linkDensity(el: Element): number {
  const total = elementTextLength(el);
  if (total === 0) return 1;
  let linkText = 0;
  el.querySelectorAll("a").forEach((a) => {
    linkText += (a.textContent ?? "").replace(/\s+/g, " ").trim().length;
  });
  return Math.min(1, linkText / total);
}

/** 是否站点外壳（按 class / id 命名判断） */
export function isBoilerplate(el: Element): boolean {
  const signature = `${el.getAttribute("class") ?? ""} ${el.getAttribute("id") ?? ""}`;
  if (!signature.trim()) return false;
  return BOILERPLATE_PATTERN.test(signature);
}

/** 是否评论区 / 互动区（命名命中即算，不看链接密度） */
export function isCommentArea(el: Element): boolean {
  const signature = `${el.getAttribute("class") ?? ""} ${el.getAttribute("id") ?? ""}`;
  if (!signature.trim()) return false;
  return COMMENT_PATTERN.test(signature);
}

/**
 * 结构性噪声：评论区一律移除；其余外壳节点按「命名 + 链接密度」判断。
 *
 * 体积护栏：占页面文字大半的容器是主包装，不是外壳。VuePress 这类框架会把
 * `sidebar-open` / `menu-open` 状态类挂在最外层容器上，命名规则命中其中的
 * sidebar / menu 就删，等于把整篇正文连根拔掉（wiki.eryajf.net 实测整页清零）。
 * 外壳（导航/侧栏/页脚）只会占页面文字的小头，超半数的一律放行。
 */
function removeStructuralNoise(root: Element): number {
  const rootLength = elementTextLength(root);
  let removed = 0;
  root.querySelectorAll("div, section, ul, ol, article, aside").forEach((el) => {
    if (el === root) return;
    if (isCommentArea(el)) {
      el.remove();
      removed += 1;
      return;
    }
    const holdsMostText = rootLength > 0 && elementTextLength(el) > rootLength * 0.5;
    if (isBoilerplate(el) && linkDensity(el) > 0.2 && !holdsMostText) {
      el.remove();
      removed += 1;
    }
  });
  return removed;
}

/** 去掉噪声节点与站点外壳节点（原地修改；返回被移除的节点数） */
export function stripNoise(root: Element): number {
  let removed = 0;
  root.querySelectorAll(NOISE_SELECTOR).forEach((el) => {
    el.remove();
    removed += 1;
  });
  removed += removeStructuralNoise(root);
  return removed;
}

/**
 * 候选块评分：文字量为主，段落数与平均段长加成，链接密度高则重罚。
 * 深度加成让正文块优先于包住整页的外壳；若站点已声明正文容器，
 * 该容器本身与它内部的块优先（覆盖 GitHub Blog 这类 main 里还塞着导航的站点）。
 */
function scoreElement(el: Element, preferred?: Element | null): number {
  const textLength = elementTextLength(el);
  if (textLength < 80) return 0;
  const density = linkDensity(el);
  if (density > LINK_DENSITY_LIMIT) return 0;

  const paragraphs = Array.from(el.querySelectorAll("p"));
  const paragraphCount = Math.max(1, paragraphs.length);
  const averageParagraph = textLength / paragraphCount;
  let score = textLength * (1 - density);
  score += Math.min(paragraphs.length, 20) * 25;
  if (averageParagraph > 100) score += 100;
  if (averageParagraph < 30) score *= 0.5;
  score += Math.min(imageCount(el), 5) * 20;
  // 深度加成：同一批候选里更深的节点通常是正文本身而不是外层容器
  let depth = 0;
  for (let node: Element | null = el; node; node = node.parentElement) depth += 1;
  score *= 1 + Math.min(depth, 12) * 0.02;
  if (preferred) {
    if (el === preferred) score *= 1.3;
    else if (preferred.contains(el)) score *= 1.15;
  }
  return score;
}

/** 收集候选块：块级元素（div/section/article/main/td/li 的父级等） */
function collectCandidates(root: Element): Element[] {
  const candidates: Element[] = [];
  root.querySelectorAll("article, main, section, div, td").forEach((el) => {
    candidates.push(el);
  });
  if (candidates.length === 0) candidates.push(root);
  return candidates;
}

/**
 * 计数容器内的**媒体元素**：iframe / audio / video / embed / object。
 *
 * 刻意**不限于**认得出平台的视频嵌入：音频播放器基本都是认不出平台的 iframe
 * （`//music.163.com/outchain/player` 这种），只数视频会让「整篇只有一个音频播放器」
 * 的正文被判成「没有内容」。真实案例：博客的分享歌曲帖，正文就是一条网易云外链播放器，
 * 结果获取原文静默失败、播放器始终不出现。
 */
function mediaElementCount(el: Element): number {
  // `[data-rss-vod]` 是南方周末这类站点的播放器组件标记（见 collectVodMarkers）：
  // 组件本身无文字，不计入的话视频文章会被判成「没有内容」
  return el.querySelectorAll("iframe, audio, video, embed, object, [data-rss-vod]").length;
}

/** 计数容器内的视频嵌入（iframe 播放器），用于给容器打分排序 */
function embedCount(el: Element): number {
  let count = 0;
  el.querySelectorAll("iframe").forEach((frame) => {
    if (identifyVideoEmbed(frame.getAttribute("src") ?? "")) count += 1;
  });
  return count;
}

/**
 * 语义容器：挑「文字最多」的一个（站点声明优先，但仍要文字量达标）。
 * 例外：正文可能整篇只有一条嵌入播放器、一个字都没有（博客内嵌播放器的常见写法），
 * 这时按文字量会把真正的容器筛掉、退回整页 body，把站点外壳当正文。
 * 因此只要容器里有**媒体元素**，就不再要求文字量。
 *
 * 判据用 mediaElementCount 而不是 embedCount：音频播放器是认不出平台的 iframe，
 * 用视频嵌入作判据会把「只有音频播放器」的帖子筛掉。
 */
function pickSemanticContainer(
  root: Element,
): { el: Element; selector: string; hasMediaOnly: boolean } | null {
  const found: { el: Element; selector: string; length: number; embeds: number; media: number }[] = [];
  for (const selector of SEMANTIC_SELECTORS) {
    root.querySelectorAll(selector).forEach((el) => {
      const length = elementTextLength(el);
      const media = mediaElementCount(el);
      if (length < SEMANTIC_MIN_TEXT && media === 0) return;
      // 只有嵌入没有文字时，按「嵌入越多越像正文」排，并给少量文字权重
      found.push({ el, selector, length, embeds: embedCount(el), media });
    });
  }
  if (found.length === 0) return null;
  found.sort((a, b) => b.embeds - a.embeds || b.length - a.length);
  const best = found[0];
  return { el: best.el, selector: best.selector, hasMediaOnly: best.media > 0 && best.length < SEMANTIC_MIN_TEXT };
}

/** 清理候选块内部仍然存在的噪声（保留正文里的图片与引用） */
function cleanContainer(el: Element): void {
  el.querySelectorAll(NOISE_SELECTOR).forEach((node) => node.remove());
  removeStructuralNoise(el);
  // 1×1 / 极小的装饰与埋点图片
  el.querySelectorAll("img").forEach((img) => {
    const width = Number(img.getAttribute("width") ?? 0);
    const height = Number(img.getAttribute("height") ?? 0);
    const signature = `${img.getAttribute("class") ?? ""} ${img.getAttribute("src") ?? ""}`;
    if ((width > 0 && width <= 16) || (height > 0 && height <= 16)) {
      img.remove();
      return;
    }
    if (/sprite|blank\.gif|spacer|pixel|tracking|stat\./i.test(signature)) img.remove();
  });
}

/**
 * 处理正文里的 <iframe>：
 * 认得平台的视频播放器抽成嵌入条目，并在**原位留一个标记**（`data-rss-embed=下标`），
 * 由上层把标记换成真正的播放器。
 *
 * **认不出平台的 iframe 保持原样**：音频播放器几乎都是这类 iframe
 * （Spotify / 小宇宙 / 网易云 / 播客托管），早先一律删掉等于直接丢内容。
 * 它们由上层 normalizeArticleHtml 加 sandbox 后按原尺寸加载；
 * 真正能加载哪些域由 CSP 的 frame-src 决定。
 * 返回的 HTML 里不再包含**已识别的** iframe（但保留其位置）。
 */
function extractEmbeds(container: Element): VideoEmbed[] {
  const embeds: VideoEmbed[] = [];
  const seen = new Set<string>();
  container.querySelectorAll("iframe").forEach((frame) => {
    const embed = identifyVideoEmbed(frame.getAttribute("src") ?? "");
    // 认不出：保留原样，别动它
    if (!embed) return;
    // 同一个播放器出现多次：只留第一处标记（用规范化身份比对，见 canonicalEmbedKey）
    const key = canonicalEmbedKey(embed.src);
    if (seen.has(key)) return;
    seen.add(key);
    // 原位留标记：早先这里只删不标记，位置靠上层「追加到正文末尾」补，
    // 于是播放器总跑到文末；标记法才能让它留在正文里原本的位置
    const marker = frame.ownerDocument.createElement("div");
    marker.setAttribute("data-rss-embed", String(embeds.length));
    embeds.push(embed);
    frame.replaceWith(marker);
  });
  return embeds;
}

/**
 * 组装提取结果：读取 HTML 之前先把 iframe 处理掉。
 * 这里必须由 resultOf 统一负责——若某个分支忘了调 extractEmbeds，
 * iframe 会留在正文里（等 normalizeArticleHtml 再删掉），视频就白丢了。
 *
 * `hasMedia` 在 extractEmbeds **之后**统计是刻意的：认得出平台的视频 iframe 已被换成
 * 占位 div（不再算媒体元素），但那些是「已识别的视频」；剩下仍留在正文里的 iframe
 * 正是音频播放器这类认不出平台的嵌入。两者只要有一个，就算正文有媒体。
 */
function resultOf(
  container: Element,
  source: string,
  vodMarkers: Element[] = [],
  metaImage: string | null = null,
): ExtractedContent {
  // 播放器标记插回正文最前面：它的原位置（页头播放器区）常会被评分或去噪丢掉，
  // detached 状态下收着，选完正文块再插回去，保证视频文章不丢播放器
  for (const marker of vodMarkers) container.insertBefore(marker, container.firstChild);
  // 正文一张图都没有时用页面的 og:image / twitter:image 补一张首图
  if (metaImage && !container.querySelector("img")) {
    const lead = container.ownerDocument.createElement("img");
    lead.setAttribute("src", metaImage);
    lead.setAttribute("loading", "lazy");
    container.insertBefore(lead, container.firstChild);
  }
  const embeds = extractEmbeds(container);
  const media = mediaElementCount(container);
  return {
    html: collapseWhitespace(container.innerHTML),
    source,
    textLength: elementTextLength(container),
    embeds,
    hasMedia: embeds.length > 0 || media > 0,
  };
}

/**
 * 上浮：最佳块的父节点若文字明显更多（正文被拆在兄弟节点里），
 * 且父节点的链接密度仍可接受，就用父节点。
 */
function expandToParent(best: Element, root: Element): Element {
  let current = best;
  for (let step = 0; step < 3; step += 1) {
    const parent = current.parentElement;
    if (!parent || parent === root.parentElement || parent.tagName === "BODY") break;
    const currentLength = elementTextLength(current);
    const parentLength = elementTextLength(parent);
    if (parentLength - currentLength < PARENT_GROWTH_MIN) break;
    if (linkDensity(parent) > LINK_DENSITY_LIMIT) break;
    // 父节点里混进了明显的非正文块时不再上浮
    let boilerplateChildren = 0;
    parent.querySelectorAll("div, section").forEach((node) => {
      if (isBoilerplate(node) && linkDensity(node) > 0.2) boilerplateChildren += 1;
    });
    if (boilerplateChildren > 0) break;
    current = parent;
  }
  return current;
}

/** 压缩空白：避免上游模板里成片的空行被当成正文（纯函数，便于测试） */
export function collapseWhitespace(html: string): string {
  return html
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/>\s+</g, "><")
    .trim();
}

/**
 * noscript 图片恢复：很多站点（LQIP 模式）正文里的可见 <img> 只带 base64 模糊占位图，
 * 真实图片放在紧邻的 <noscript><img src="真图"></noscript> 里 —— 去噪会把 noscript
 * 删掉，图片就只剩糊图。这里把 noscript 里的真实地址回填给同级的占位 img。
 */
function recoverNoscriptImages(root: Element): void {
  root.querySelectorAll("noscript").forEach((ns) => {
    const content = ns.textContent ?? "";
    if (!/<img\b/i.test(content)) return;
    const inner = new DOMParser().parseFromString(content, "text/html");
    const real = inner.querySelector("img[src]");
    const src = real?.getAttribute("src")?.trim();
    if (!src || !/^https?:\/\//i.test(src)) return;
    // 占位目标：紧邻的 <img>，或同容器里第一张 src 为空 / data: 占位的 <img>
    const prev = ns.previousElementSibling;
    const target =
      prev?.tagName === "IMG"
        ? prev
        : Array.from(ns.parentElement?.querySelectorAll("img") ?? []).find((img) => {
            const current = img.getAttribute("src")?.trim() ?? "";
            return current === "" || current.startsWith("data:");
          });
    if (target) {
      target.setAttribute("src", src);
      ns.remove();
    }
  });
}

/** 页面级 og:image / twitter:image（正文一张图都没有时补首图用） */
function pickMetaImage(doc: Document): string | null {
  const content =
    doc.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content ??
    doc.querySelector<HTMLMetaElement>('meta[name="twitter:image"], meta[name="og:image"]')?.content;
  const value = content?.trim();
  return value && /^https?:\/\//i.test(value) ? value : null;
}

/**
 * 南方周末的音视频组件（Vue 的 `is="IVideoPlayer"/"IAudioPlayer"`，带 `file-id` 属性）：
 * 静态 HTML 里只有组件声明，播放器由客户端渲染。这里把它们抽成 `data-rss-vod` 标记
 * （fileId / 种类 / 封面），由上层解析出点播直链后换成真正的播放器。
 * 抽取必须发生在 stripNoise 之前 —— 组件常挂在 `header.nfzm-content__header` 里，
 * 去噪会先把它连同宿主一起删掉。
 */
export function collectVodMarkers(root: Element): Element[] {
  const markers: Element[] = [];
  // gcoresEnrich 等增强步骤注入的音频播放器：同样可能落在选不中的位置，一并收走插回正文
  root.querySelectorAll("audio[data-rss-audio]").forEach((audio) => {
    audio.remove();
    markers.push(audio);
  });
  root.querySelectorAll("[file-id]").forEach((el) => {
    const fileId = (el.getAttribute("file-id") ?? "").trim();
    const component = el.getAttribute("is") ?? "";
    // 组件声明形态才认：is 属性指明播放器，fileId 是腾讯云点播的纯数字 ID
    if (!/player/i.test(component) || !/^\d{6,32}$/.test(fileId)) return;
    const marker = el.ownerDocument.createElement("div");
    marker.setAttribute("data-rss-vod", fileId);
    if (/audio/i.test(component)) marker.setAttribute("data-rss-vod-kind", "audio");
    const cover = (el.getAttribute("cover-url") ?? "").trim();
    if (cover) marker.setAttribute("data-rss-vod-cover", cover);
    el.replaceWith(marker);
    markers.push(marker);
  });
  return markers;
}

/** 南方周末播放器组件对应的腾讯云点播信息接口（appid 固定为其账号值） */
export function vodPlayInfoUrl(fileId: string): string {
  return `https://playvideo.qcloud.com/getplayinfo/v2/1251434507/${encodeURIComponent(fileId)}`;
}

/** 从点播信息里挑直链：视频取清晰度最高的 mp4，音频取第一个 mp3/aac */
export function pickVodMediaUrl(
  info: unknown,
  kind: "audio" | "video",
): { url: string; durationSecs?: number } | null {
  const list = (info as { videoInfo?: { transcodeList?: unknown } })?.videoInfo?.transcodeList;
  if (!Array.isArray(list)) return null;
  const entries = list.flatMap((item) => {
    const t = item as { container?: string; width?: number; duration?: number; url?: unknown };
    if (typeof t.url !== "string" || !/^https?:\/\//i.test(t.url)) return [];
    const entry = { url: t.url, width: t.width, duration: t.duration };
    const container = (t.container ?? "").toLowerCase();
    if (kind === "audio") {
      return /mp3|aac|m4a/.test(container) ? [entry] : [];
    }
    return container.includes("mp4") && (t.width ?? 0) > 0 ? [entry] : [];
  });
  if (entries.length === 0) return null;
  entries.sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  const best = entries[0];
  return {
    url: best.url,
    durationSecs: typeof best.duration === "number" && best.duration > 0 ? best.duration : undefined,
  };
}

/**
 * 从已解析的文档中提取正文。
 * @param doc 已解析的原文文档（调用方负责用 DOMParser 解析）
 * @returns 正文 HTML 与诊断信息；提取不到内容时 textLength 为 0
 */
export function extractArticleFromDocument(doc: Document): ExtractedContent {
  const body = doc.body;
  if (!body) return { html: "", source: "无 body", textLength: 0, embeds: [], hasMedia: false };

  // 南方周末等站点的音视频组件先抽成标记（必须在去噪前，否则连宿主一起被删）
  const vodMarkers = collectVodMarkers(body);
  // LQIP 站点的真图在 noscript 里，去噪前先回填给占位 img
  recoverNoscriptImages(body);
  const metaImage = pickMetaImage(doc);

  // 先整体去噪，避免评分被导航 / 侧栏带偏
  stripNoise(body);
  const pageTextLength = elementTextLength(body);

  const semantic = pickSemanticContainer(body);
  if (semantic) {
    cleanContainer(semantic.el);
    const length = elementTextLength(semantic.el);
    // 语义容器够长、且不是「整页外壳」（占比过高说明它包住了整个站点框架）就直接用
    const looksLikeShell = pageTextLength > 0 && length > pageTextLength * 0.6;
    if (length >= SEMANTIC_MIN_TEXT * 2 && !looksLikeShell) {
      return resultOf(semantic.el, `语义容器 ${semantic.selector}`, vodMarkers, metaImage);
    }
    // 正文只有视频嵌入、没有文字：无需再走评分（评分的文字门槛必然选不中它）
    if (semantic.hasMediaOnly) {
      return resultOf(semantic.el, `语义容器 ${semantic.selector}（仅视频嵌入）`, vodMarkers, metaImage);
    }
  }

  const candidates = collectCandidates(body);
  let best: Element | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = scoreElement(candidate, semantic?.el ?? null);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  if (best) {
    const expanded = expandToParent(best, body);
    cleanContainer(expanded);
    const length = elementTextLength(expanded);
    if (semantic && semantic.el && elementTextLength(semantic.el) > length) {
      cleanContainer(semantic.el);
      return resultOf(semantic.el, `语义容器 ${semantic.selector}`, vodMarkers, metaImage);
    }
    if (length > 0) {
      const tag = expanded.tagName.toLowerCase();
      const cls = (expanded.getAttribute("class") ?? "").split(/\s+/).filter(Boolean)[0];
      return resultOf(expanded, `评分块 <${tag}${cls ? ` class="${cls}"` : ""}>`, vodMarkers, metaImage);
    }
  }

  // 兜底：语义容器即使偏短也先用它；再不行就整篇 body
  if (semantic) {
    cleanContainer(semantic.el);
    return resultOf(semantic.el, `语义容器 ${semantic.selector}（兜底）`, vodMarkers, metaImage);
  }
  cleanContainer(body);
  // 整页兜底时也在全页找一遍嵌入（正文块可能因为无文字而被评分忽略）
  return resultOf(body, "整页 body（兜底）", vodMarkers, metaImage);
}
