/*
 * 文件名: App.tsx
 * 描述: RSS 阅读器主应用组件，Fluent 2 两栏布局 + 模态 NavigationView 抽屉
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { save as showSaveDialog, open as showOpenDialog } from "@tauri-apps/plugin-dialog";
import { AddFeedModal } from "./features/rss/components/AddFeedModal";
import { ArticleList } from "./features/rss/components/ArticleList";
import { ArticleView } from "./features/rss/components/ArticleView";
import { SettingsModal } from "./features/rss/components/SettingsModal";
import { ShareMenu, type ShareAnchor } from "./features/rss/components/ShareMenu";
import { TitleBar, type AppMessage } from "./features/rss/components/TitleBar";
import { FeedList } from "./features/rss/components/FeedList";
import * as rssService from "./features/rss/services/rssService";
import * as updateService from "./features/rss/services/updateService";
import type { AppState, Article, Feed, FetchResult, Group } from "./features/rss/types";
import { appendArticles, dedupeArticlesById } from "./lib/articleDedupe";
import { clearFullContentCache } from "./lib/fullContentCache";
import { clearPreviewCache } from "./features/rss/components/ArticleList";
import { filterArticles } from "./lib/articleFilter";
import { reorderFeedsInGroup, reorderGroups, type FeedMovePosition } from "./lib/feedOrder";
import { useResetScrollOnChange } from "./lib/scrollReset";
import { call } from "./lib/tauri";
import {
  applyTheme,
  buildProxyArg,
  buildProxyUrl,
  listenSystemTheme,
  loadPreferences,
  PREFERENCES_STORAGE_KEY,
  REFRESH_INTERVALS_MS,
  savePreferences,
  type Preferences,
} from "./lib/preferences";

/** 简单的 ID 生成 */
function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** 搜索索引里每篇文章保留的最大字符数：全文常驻内存会让几万篇文章占用上百 MB */
const SEARCH_TEXT_LIMIT = 4096;

/**
 * 抓取一个订阅源。**所有刷新都是全量抓取**（不带 ETag / Last-Modified 条件请求）：
 * 单源刷新与「刷新所有订阅源」走同一条路径，不会出现「本地文章被清理过就取不回来」的分歧，
 * 也不再需要水位线判据；代价是每次刷新都会重新下载并解析整份订阅源。
 */
async function fetchOneFeed(
  feed: Feed,
  proxy: Parameters<typeof rssService.fetchFeed>[1],
): Promise<{ result: FetchResult }> {
  const result = await rssService.fetchFeed(feed.url, proxy);
  return { result };
}

/** 搜索用去 HTML 标签（正则实现，避免大列表逐条 DOM 解析的开销） */
function stripHtmlForSearch(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 计算字符串的 SHA-256 前 16 个十六进制字符（与 Rust short_hash 一致） */
async function shortHash(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/**
 * 订阅源 URL 变更后重算该源下文章的 id：文章 id 是 feed_id + 条目标识的哈希，
 * feed_id 变了而 id 不变，下次刷新就会把同一篇文章再插一遍（同时丢失已读 / 收藏）。
 * 这里按新 feed_id 重算，并返回「旧 id → 新 id」映射供选中态一并跟随。
 * entry_key 缺失（v2 之前的数据）时退化为链接 / 标题，仍匹配不上就保持原 id 不动。
 */
async function remapFeedArticles(
  articles: Article[],
  oldFeedId: string,
  newFeedId: string,
): Promise<{ articles: Article[]; idMap: Record<string, string> }> {
  const idMap: Record<string, string> = {};
  const next: Article[] = [];
  for (const article of articles) {
    if (article.feed_id !== oldFeedId) {
      next.push(article);
      continue;
    }
    const key = article.entry_key ?? article.link ?? article.title;
    const id = key ? await shortHash(`${newFeedId}:${key}`) : article.id;
    if (id !== article.id) idMap[article.id] = id;
    next.push({ ...article, id, feed_id: newFeedId });
  }
  return { articles: next, idMap };
}

function App(): JSX.Element {
  // 应用状态
  const [state, setState] = useState<AppState>({ feeds: [], articles: [], groups: [] });
  // 最新状态的 ref：供需要读取状态但必须保持引用稳定的回调使用（避免列表项 memo 失效）
  const stateRef = useRef(state);
  stateRef.current = state;
  const [selectedFeedId, setSelectedFeedId] = useState<string | null>(null);
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 深链带来的订阅地址（非 null 时弹出添加对话框并预填）
  const [pendingFeedUrl, setPendingFeedUrl] = useState<string | null>(null);
  // 状态载入完成前收到的深链地址（载入后重放，见 handleDeepLink）
  const pendingDeepLinkRef = useRef<string | null>(null);
  // 分享面板：目标文章 + 展开锚点（阅读视图工具栏与文章列表右键菜单都是入口）
  const [shareTarget, setShareTarget] = useState<{
    articleId: string;
    anchor: ShareAnchor;
  } | null>(null);
  const [messages, setMessages] = useState<AppMessage[]>([]);
  // 文章列表宽度（可拖拽调整，持久化）
  const [articleListWidth, setArticleListWidth] = useState<number>(() => {
    const saved = window.localStorage.getItem("rss-reader-article-width");
    return saved ? Number(saved) : 380;
  });
  const articleWidthRef = useRef(articleListWidth);
  // 应用偏好（主题 / 字号 / 自动抓取频率）
  const [prefs, setPrefs] = useState<Preferences>(() => loadPreferences());
  // 最新偏好的 ref：供启动检查更新这类只读一次的场景使用，避免把 prefs 放进 effect 依赖
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  // 文章列表渲染上限：大列表分批渲染，滚动到底部自动加载更多
  const [renderLimit, setRenderLimit] = useState(300);
  // 阅读区滚动容器：切换文章时回到顶部，避免沿用上一篇的阅读位置
  const readerRef = useResetScrollOnChange<HTMLElement>(selectedArticleId);
  // 搜索关键字（会话内状态，不持久化）
  const [searchQuery, setSearchQuery] = useState("");
  // 抽屉里的「收藏」视图（跨订阅源看星标文章）：
  // 与顶栏筛选里的「仅星标文章」（prefs.viewFilter）是两件事，互不干扰——
  // 抽屉的「收藏」不改写筛选偏好，顶栏切「全部 / 未读」也不会把抽屉的收藏视图改掉。
  //
  // 实现说明：这里用 ref 承载值、用「换一个新对象」触发重渲染。
  // 该视图只是过滤条件 + 高亮，不需要参与并发渲染的值比较；这样也避开了与其它
  // setState 同批处理时被丢弃的问题（同 handler 内的 setSelectedFeedId 正常生效）。
  const starredViewRef = useRef(false);
  const [, setStarredViewTick] = useState<{ v: boolean }>({ v: false });
  const setStarredView = useCallback((next: boolean) => {
    starredViewRef.current = next;
    setStarredViewTick({ v: next });
  }, []);

  // 文章统计：分源未读数、总未读、收藏总数——一次遍历全部算出
  const stats = useMemo(() => {
    const unreadCounts: Record<string, number> = {};
    let unreadTotal = 0;
    let starredTotal = 0;

    for (const a of state.articles) {
      if (!a.read) {
        unreadTotal += 1;
        unreadCounts[a.feed_id] = (unreadCounts[a.feed_id] ?? 0) + 1;
      }
      if (a.starred) starredTotal += 1;
    }
    return { unreadCounts, unreadTotal, starredTotal };
  }, [state.articles]);

  // 订阅源标题查找表：供排序、当前源名、阅读视图查找复用，避免重复 O(n) 查找
  const feedTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of state.feeds) map.set(f.id, f.title);
    return map;
  }, [state.feeds]);

  // 搜索索引（文章 id → 小写的「标题 + 去标签正文」）。
  // 用 ref 缓存已计算文本：已读 / 收藏切换只改变数组引用不改变内容，命中缓存避免全量重建。
  // 未输入搜索词时不构建索引——否则每次文章状态变化都要全量遍历一遍。
  const searchTextCacheRef = useRef(new Map<string, string>());
  const searchIndex = useMemo(() => {
    const index = new Map<string, string>();
    if (!searchQuery.trim()) return index;
    const cache = searchTextCacheRef.current;
    const live = new Set<string>();
    for (const a of state.articles) {
      live.add(a.id);
      let text = cache.get(a.id);
      if (text === undefined) {
        // 检索范围：标题 + 去标签正文 + 摘要 + 作者 + 标签（正文种类不限，纯文本 / Markdown 原文也可命中）
        const parts = [
          a.title ?? "",
          stripHtmlForSearch(a.content ?? ""),
          a.summary ?? "",
          a.author ?? "",
          (a.categories ?? []).join(" "),
        ];
        text = parts.join(" ").slice(0, SEARCH_TEXT_LIMIT).toLowerCase();
        cache.set(a.id, text);
      }
      index.set(a.id, text);
    }
    for (const id of [...cache.keys()]) {
      if (!live.has(id)) cache.delete(id);
    }
    return index;
  }, [state.articles, searchQuery]);

  // 初始加载
  useEffect(() => {
    rssService
      .loadState()
      .then((loaded) => {
        // 旧版数据可能给同一篇文章留下两条记录（订阅源改过 entry.id / 换过 URL，
        // 而 entry_key 是后加的字段）。重复会让 React 的列表 key 撞车、残留旧 DOM 节点，
        // 必须先合并（按稳定标识 + id）再入库。
        const articles = dedupeArticlesById(loaded.articles);
        if (articles === null) {
          setState(loaded);
          return;
        }
        const next: AppState = { ...loaded, articles };
        setState(next);
        // 落盘自愈：避免每次启动都重复合并，也让后续刷新在干净数据上做去重
        void rssService.saveState(next);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  // 页面隐藏 / 关闭前把防抖挂起的变更立即落盘，避免尾部变更丢失
  useEffect(() => {
    const flush = (): void => rssService.flushPendingSave();
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, []);

  // 应用主题：挂载时 + 偏好/系统主题变化时
  useEffect(() => {
    applyTheme(prefs.theme);
    const unlisten = listenSystemTheme(() => {
      if (prefs.theme === "system") applyTheme("system");
    });
    return unlisten;
  }, [prefs.theme]);

  // 代理配置同步到 Rust 侧：文章图片经本地 rssimg 协议抓取时使用
  // （catch 掉纯浏览器预览下的 invoke 失败，避免未处理 rejection）
  useEffect(() => {
    rssService.updateProxySetting(buildProxyArg(prefs)).catch(() => {});
  }, [prefs.proxy]);

  // 启动时清一次旧版本更新残留：updater 解压安装包的临时目录是故意保留的
  // （安装包要在应用退出后才执行），每升级一个版本会留下约 3 MB，久了会积一堆
  useEffect(() => {
    void rssService.cleanupOldUpdaterDirs().catch(() => {});
  }, []);

  // 自动抓取定时器引用的刷新函数（稍后赋值）
  // 刷新入口引用：供自动抓取定时器与批量导入调用（可指定只刷新部分订阅源）
  const refreshRef = useRef<(feeds?: Feed[]) => void>(() => {});
  // 刷新重入锁（用 ref 避免把 refreshing 放进依赖里导致回调重建）
  const refreshingRef = useRef(false);

  // 消息系统
  const addMessage = useCallback((type: AppMessage["type"], text: string) => {
    setMessages((prev) => [{ id: uid(), type, text, time: Date.now() }, ...prev].slice(0, 50));
  }, []);

  const clearMessages = useCallback(() => setMessages([]), []);

  /** 深链地址：已订阅则定位到该源，否则弹添加对话框并预填 */
  const handleDeepLink = useCallback(
    (url: string) => {
      // 初始状态尚未载入时无法判断是否已订阅（state 还是空数组），
      // 直接处理会把已订阅的源误判为未订阅、弹出添加对话框。
      // 先暂存，等 loadState 落地后由下面的 effect 重放一次。
      if (loading) {
        pendingDeepLinkRef.current = url;
        return;
      }
      const existing = stateRef.current.feeds.find((feed) => feed.url === url);
      if (existing) {
        setSelectedFeedId(existing.id);
        setSelectedArticleId(null);
        setStarredView(false);
        addMessage("info", `已订阅该源：${existing.title || existing.url}`);
        return;
      }
      setPendingFeedUrl(url);
    },
    [addMessage, loading],
  );

  // 状态载入完成后重放暂存的深链（冷启动时深链与 loadState 是并发的，谁先到不确定）
  useEffect(() => {
    if (loading) return;
    const url = pendingDeepLinkRef.current;
    if (url === null) return;
    pendingDeepLinkRef.current = null;
    handleDeepLink(url);
  }, [loading, handleDeepLink]);

  // 深链：冷启动取 Rust 侧暂存的地址（事件在 webview 加载前就发出了），运行中监听 feed-link
  useEffect(() => {
    void call<string | null>("take_pending_feed_link")
      .then((url) => {
        if (url) handleDeepLink(url);
      })
      .catch(() => {});
    const unlisten = listen<string>("feed-link", (event) => handleDeepLink(event.payload));
    return () => {
      void unlisten.then((off) => off());
    };
  }, [handleDeepLink]);

  // 启动后延迟静默检查更新：离线 / 无发布包等情况静默忽略，有新版本时只提示不自动安装
  useEffect(() => {
    const timer = window.setTimeout(() => {
      updateService
        .checkForUpdate(buildProxyUrl(prefsRef.current.proxy))
        .then((update) => {
          if (update) {
            addMessage("info", `发现新版本 v${update.version}，可在「设置 → 关于」中更新`);
          }
        })
        .catch(() => {
          /* 静默忽略 */
        });
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [addMessage]);

  // 选中文章时标记为已读
  useEffect(() => {
    if (!selectedArticleId) return;
    const article = state.articles.find((a) => a.id === selectedArticleId);
    if (article && !article.read) {
      void handleSetRead(article.id, true);
    }
  }, [selectedArticleId, state.articles]);

  /**
   * 选中订阅源。
   * 注意：只在真正选中某个源（feedId 非 null）时退出抽屉的「收藏」视图。
   * 抽屉「收藏」本身也要把订阅源清空（feedId = null），若无条件重置收藏视图，
   * 同一次点击里「进入收藏」会被这次重置覆盖掉（表现为点了收藏没反应）。
   */
  const handleSelectFeed = useCallback((feedId: string | null) => {
    setSelectedFeedId(feedId);
    setSelectedArticleId(null);
    if (feedId !== null) setStarredView(false);
    setDrawerOpen(false);
  }, [setStarredView]);

  /** 选中文章（引用保持稳定：依赖 state 会让每次标记已读都重建，导致列表全量重渲染） */
  const handleSelectArticle = useCallback((articleId: string) => {
    setSelectedArticleId(articleId);
    const current = stateRef.current;
    const article = current.articles.find((a) => a.id === articleId);
    if (article) {
      const feed = current.feeds.find((f) => f.id === article.feed_id);
      if (feed?.open_method === "external" && article.link) {
        void rssService.openExternal(article.link);
      }
    }
  }, []);

  /** 拖拽调整文章列表宽度 */
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = articleWidthRef.current;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    // 用 requestAnimationFrame 节流：鼠标事件频率高于屏幕刷新率时避免多余渲染
    let frame = 0;
    let pending = startWidth;
    const commit = (): void => {
      frame = 0;
      articleWidthRef.current = pending;
      setArticleListWidth(pending);
    };
    const onMove = (ev: MouseEvent): void => {
      pending = Math.max(260, Math.min(640, startWidth + (ev.clientX - startX)));
      if (frame === 0) frame = window.requestAnimationFrame(commit);
    };
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // 收尾时落定最后一帧，并持久化
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
        commit();
      } else {
        articleWidthRef.current = pending;
      }
      window.localStorage.setItem("rss-reader-article-width", String(articleWidthRef.current));
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  /** 设置已读 / 未读状态（列表右键菜单与选中自动标读共用） */
  const handleSetRead = useCallback(async (articleId: string, read: boolean) => {
    setState((prev) => {
      const target = prev.articles.find((a) => a.id === articleId);
      if (!target || target.read === read) return prev;
      const next = {
        ...prev,
        articles: prev.articles.map((a) =>
          a.id === articleId ? { ...a, read } : a,
        ),
      };
      rssService.saveStateDebounced(next);
      return next;
    });
  }, []);

  /** 收藏切换 */
  const handleToggleStarred = useCallback(async (articleId: string) => {
    setState((prev) => {
      const next = {
        ...prev,
        articles: prev.articles.map((a) =>
          a.id === articleId ? { ...a, starred: !a.starred } : a,
        ),
      };
      rssService.saveStateDebounced(next);
      return next;
    });
  }, []);

  /** 全部标记为已读 */
  const handleMarkAllRead = useCallback(() => {
    setState((prev) => {
      if (!prev.articles.some((a) => !a.read)) return prev;
      const next = {
        ...prev,
        articles: prev.articles.map((a) => ({ ...a, read: true })),
      };
      rssService.saveStateDebounced(next);
      return next;
    });
  }, []);

  /** 标记指定订阅源的所有文章为已读 */
  const handleMarkFeedRead = useCallback((feedId: string) => {
    setState((prev) => {
      if (!prev.articles.some((a) => a.feed_id === feedId && !a.read)) return prev;
      const next = {
        ...prev,
        articles: prev.articles.map((a) =>
          a.feed_id === feedId ? { ...a, read: true } : a,
        ),
      };
      rssService.saveStateDebounced(next);
      return next;
    });
  }, []);

  /** 刷新单个订阅源（全量抓取，与「刷新所有订阅源」同一条路径） */
  const handleRefreshFeed = useCallback(async (feedId: string) => {
    const feed = state.feeds.find((f) => f.id === feedId);
    if (!feed) return;
    try {
      const fetched = await fetchOneFeed(feed, buildProxyArg(prefsRef.current));
      const result = fetched.result;
      setState((prev) => {
        // 按稳定标识 + id 去重（见 lib/articleDedupe.ts）：订阅源 URL / entry.id 变过后，
        // 存量文章的 id 可能与本次抓取结果不同，只比 id 会把同一篇文章再插一遍
        // （列表出现重复、已读 / 收藏丢失）
        const articles = appendArticles(prev.articles, result.articles);
        const feeds = prev.feeds.map((f) =>
          f.id === result.feed_id ? { ...f, title: result.feed_title } : f,
        );
        if (articles === prev.articles) return prev;
        const next: AppState = {
          feeds,
          articles,
          groups: prev.groups,
        };
        rssService.saveStateDebounced(next);
        return next;
      });
      addMessage("success", `${result.feed_title || feed.title}: 刷新完成`);
    } catch (err) {
      addMessage("error", `${feed.title}: ${String(err)}`);
    }
  }, [state.feeds, prefs, addMessage]);

  /** 更新应用偏好并持久化 */
  const updatePrefs = useCallback((patch: Partial<Preferences>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      savePreferences(next);
      return next;
    });
  }, []);

  /** 修改阅读字号 */
  const handleFontSizeChange = useCallback((size: number) => {
    updatePrefs({ fontSize: size });
  }, [updatePrefs]);

  /**
   * 切换某个「折叠键集合」偏好里的一项。
   * 左侧栏与设置页的折叠各自成一份（浏览时收起 vs 整理时收起），逻辑一致所以共用这一处。
   */
  const toggleCollapsedKey = useCallback(
    (field: "sidebarCollapsedGroups" | "organizeCollapsedGroups", key: string) => {
      const current = prefsRef.current[field];
      updatePrefs({
        [field]: current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
      });
    },
    [updatePrefs],
  );

  /** 抽屉「全部文章」：清空订阅源选择并重置筛选条件 */
  const handleSelectAllFeeds = useCallback(() => {
    updatePrefs({ viewFilter: "all" });
    setStarredView(false);
    handleSelectFeed(null);
  }, [updatePrefs, handleSelectFeed]);

  /** 抽屉「收藏」：跨订阅源查看星标文章（独立的会话视图，不改写筛选偏好） */
  const handleSelectStarred = useCallback(() => {
    setStarredView(true);
    setSelectedFeedId(null);
    setSelectedArticleId(null);
    setDrawerOpen(false);
  }, [setStarredView]);

  /** 添加订阅源（重复订阅同一 URL 时视为刷新该源，不重复写入） */
  const handleAddFeed = useCallback(async (url: string) => {
    const result = await rssService.fetchFeed(url, buildProxyArg(prefs));
    const now = new Date().toISOString();
    const newFeed: Feed = {
      id: result.feed_id,
      url,
      title: result.feed_title,
      description: result.feed_description,
      site_url: result.feed_site_url,
      added_at: now,
      group_id: null,
      sort_order: 0,
      open_method: null,
    };

    setState((prev) => {
      // 与刷新同一套去重口径（稳定标识 + id）：同一源重复抓取不会插入重复文章
      const articles = appendArticles(prev.articles, result.articles);
      const alreadySubscribed = prev.feeds.some((f) => f.id === newFeed.id);
      const next: AppState = {
        feeds: alreadySubscribed
          ? prev.feeds.map((f) =>
              f.id === newFeed.id ? { ...f, title: newFeed.title } : f,
            )
          : [newFeed, ...prev.feeds],
        articles,
        groups: prev.groups,
      };
      rssService.saveStateDebounced(next);
      return next;
    });
  }, [prefs]);

  /** 批量导入订阅源（仅写入 URL + 标题），随后只刷新本次新增的源 */
  const handleBatchImportFeeds = useCallback(async (items: { url: string; title?: string }[]) => {
    const now = new Date().toISOString();
    const known = new Set(stateRef.current.feeds.map((f) => f.id));
    const toAdd: Feed[] = [];
    for (const item of items) {
      const id = await shortHash(item.url);
      if (known.has(id)) continue;
      known.add(id);
      toAdd.push({
        id,
        url: item.url,
        title: item.title || item.url,
        description: null,
        site_url: null,
        added_at: now,
        group_id: null,
        sort_order: 0,
        open_method: null,
      });
    }
    if (toAdd.length === 0) return;

    setState((prev) => {
      // 二次去重，防止并发导入重复写入
      const ids = new Set(prev.feeds.map((f) => f.id));
      const fresh = toAdd.filter((f) => !ids.has(f.id));
      if (fresh.length === 0) return prev;
      const next: AppState = {
        feeds: [...prev.feeds, ...fresh],
        articles: prev.articles,
        groups: prev.groups,
      };
      rssService.saveStateDebounced(next);
      return next;
    });

    // 只刷新本次导入的订阅源，不再连带刷新全部存量源
    setTimeout(() => void refreshRef.current?.(toAdd), 100);
  }, []);

  /** 删除订阅源 */
  const handleRemoveFeed = useCallback(async (feedId: string) => {
    setState((prev) => {
      const next: AppState = {
        feeds: prev.feeds.filter((f) => f.id !== feedId),
        articles: prev.articles.filter((a) => a.feed_id !== feedId),
        groups: prev.groups,
      };
      rssService.saveStateDebounced(next);
      return next;
    });
    if (selectedFeedId === feedId) {
      setSelectedFeedId(null);
      setSelectedArticleId(null);
    }
  }, [selectedFeedId]);

  /** 批量删除订阅源 */
  const handleRemoveFeeds = useCallback((feedIds: string[]) => {
    setState((prev) => {
      const idSet = new Set(feedIds);
      const next: AppState = {
        feeds: prev.feeds.filter((f) => !idSet.has(f.id)),
        articles: prev.articles.filter((a) => !idSet.has(a.feed_id)),
        groups: prev.groups,
      };
      rssService.saveStateDebounced(next);
      return next;
    });
    if (selectedFeedId && feedIds.includes(selectedFeedId)) {
      setSelectedFeedId(null);
      setSelectedArticleId(null);
    }
  }, [selectedFeedId]);

  /**
   * 更新订阅源属性（名称 / URL / 打开方式）。
   * URL 变更意味着订阅源身份变化：重算 feed id，并把该源的文章按新 id 重算，
   * 后续刷新才能正常去重、保留已读与收藏。
   */
  const handleUpdateFeed = useCallback(async (
    feedId: string,
    patch: Partial<Pick<Feed, "title" | "url" | "open_method">>,
  ) => {
    const urlChanged = patch.url !== undefined && patch.url !== "";
    const newId = urlChanged ? await shortHash(patch.url as string) : feedId;
    // 重算在事件处理阶段完成：setState 的更新函数必须是纯函数（StrictMode 下会执行两次）。
    // 重算后再合并一次：旧 id 与新 id 的记录可能指向同一篇文章（该源本来就有重复，
    // 或 entry_key 缺失导致新旧 id 对不上），合掉才不会在列表里留下两条。
    const remapped = urlChanged
      ? await remapFeedArticles(stateRef.current.articles, feedId, newId)
      : null;
    const remappedArticles = remapped
      ? dedupeArticlesById(remapped.articles) ?? remapped.articles
      : null;

    setState((prev) => {
      const next: AppState = {
        ...prev,
        feeds: prev.feeds.map((f) =>
          f.id === feedId ? { ...f, ...patch, id: newId } : f,
        ),
        articles: remappedArticles
          ? remappedArticles
          : prev.articles.map((a) => (a.feed_id === feedId ? { ...a, feed_id: newId } : a)),
      };
      rssService.saveStateDebounced(next);
      return next;
    });
    if (selectedFeedId === feedId && newId !== feedId) {
      setSelectedFeedId(newId);
    }
    if (remapped) {
      setSelectedArticleId((prev) => (prev ? remapped.idMap[prev] ?? prev : prev));
    }
  }, [selectedFeedId, state.articles]);

  /**
   * 刷新订阅源（缺省全部；可传入子集，如批量导入后只刷新新增源）。
   * **全量抓取**：每个源都重新下载并解析整份订阅源（不带 ETag / Last-Modified），
   * 与单源「刷新」完全同一条路径，结果不会因本地数据状态而不同。
   */
  const runRefresh = useCallback(async (targetFeeds?: Feed[]) => {
    if (refreshingRef.current) return;
    const targets = targetFeeds ?? stateRef.current.feeds;
    if (targets.length === 0) {
      addMessage("info", "没有可刷新的订阅源");
      return;
    }
    refreshingRef.current = true;
    setRefreshing(true);
    setError(null);

    // 并发抓取，收集结果；失败不中断。
    // 限制并发数：订阅源很多时避免同时建立过多连接拖垮 UI 与网络。
    const proxyArg = buildProxyArg(prefs);
    const CONCURRENCY = 6;
    const settled: (
      | { ok: true; feed: Feed; result: FetchResult }
      | { ok: false; feed: Feed; err: string }
    )[] = [];
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(CONCURRENCY, targets.length) },
      async () => {
        while (cursor < targets.length) {
          const feed = targets[cursor++];
          try {
            const result = await rssService.fetchFeed(feed.url, proxyArg);
            settled.push({ ok: true, feed, result });
          } catch (err) {
            settled.push({ ok: false, feed, err: String(err) });
          }
        }
      },
    );
    await Promise.all(workers);

    // 汇总成功结果 + 失败错误
    const successes: { result: FetchResult }[] = [];
    const errors: { feed: string; err: string }[] = [];
    for (const r of settled) {
      if (r.ok) {
        successes.push({ result: r.result });
      } else {
        errors.push({ feed: r.feed.title || r.feed.url, err: r.err });
      }
    }

    if (successes.length > 0) {
      // 一次性合并所有新文章 + 回写订阅源标题
      setState((prev) => {
        const feedPatches = new Map<string, Partial<Feed>>();
        const fetched: typeof prev.articles = [];
        for (const { result } of successes) {
          const patch: Partial<Feed> = {};
          if (result.feed_title) patch.title = result.feed_title;
          feedPatches.set(result.feed_id, patch);
          fetched.push(...result.articles);
        }
        const patchedFeeds = prev.feeds.map((f) => {
          const patch = feedPatches.get(f.id);
          return patch ? { ...f, ...patch } : f;
        });
        // 与单源刷新同一套去重口径（稳定标识 + id）：多个源一起刷新也不会插重
        const articles = appendArticles(prev.articles, fetched);
        const next: AppState = {
          feeds: patchedFeeds,
          articles,
          groups: prev.groups,
        };
        rssService.saveStateDebounced(next);
        return next;
      });
    }

    if (errors.length > 0) {
      addMessage("error", `${errors.length} 个订阅源刷新失败`);
      errors.slice(0, 5).forEach((e) => addMessage("error", `${e.feed}: ${e.err}`));
    } else if (successes.length > 0) {
      addMessage("success", "刷新完成");
    }

    refreshingRef.current = false;
    setRefreshing(false);
  }, [prefs, addMessage]);

  /** 刷新全部订阅源（标题栏按钮调用；无参数，避免把点击事件当成订阅源列表） */
  const handleRefresh = useCallback((): void => {
    void runRefresh();
  }, [runRefresh]);

  // 自动抓取定时器：按偏好频率周期刷新
  refreshRef.current = runRefresh;
  useEffect(() => {
    const intervalMs = REFRESH_INTERVALS_MS[prefs.refreshFrequency];
    if (intervalMs == null) return;
    const timer = window.setInterval(() => {
      // 窗口最小化 / 隐藏时跳过：省电、省流量
      if (document.visibilityState === "hidden") return;
      void refreshRef.current();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [prefs.refreshFrequency]);

  /** 打开原文链接 */
  const handleOpenArticle = useCallback(async (url: string) => {
    try {
      await rssService.openExternal(url);
    } catch (err) {
      setError(`打开链接失败: ${String(err)}`);
    }
  }, []);

  /** 右键菜单：在系统浏览器中打开文章原文 */
  const handleOpenArticleExternal = useCallback(
    async (articleId: string) => {
      const article = state.articles.find((a) => a.id === articleId);
      if (!article?.link) return;
      try {
        await rssService.openExternal(article.link);
      } catch (err) {
        setError(`打开链接失败: ${String(err)}`);
      }
    },
    [state.articles],
  );

  /** 打开分享面板（阅读视图工具栏 / 文章列表右键菜单共用入口） */
  const handleShareArticle = useCallback((articleId: string, anchor: ShareAnchor) => {
    setShareTarget({ articleId, anchor });
  }, []);

  /**
   * 清理本地缓存：清内存里的解析缓存（全文提取结果 + 列表预览文本 + 搜索索引），
   * 并清空 WebView 的磁盘缓存（文章图片缓存，实测可达数百 MB）。**不删除任何文章**。
   *
   * 注意顺序：`clear_all_browsing_data` 会连带清掉 WebView 的 localStorage，而界面偏好就存在
   * 那里——所以先取出偏好快照，清完再写回，避免主题 / 字号 / 代理等设置被重置。
   * 磁盘缓存清理是异步的，失败也不影响内存缓存清理的结果。
   */
  const handleClearLocalCache = useCallback((): number => {
    const cleared = clearFullContentCache() + clearPreviewCache();
    searchTextCacheRef.current.clear();
    const prefsSnapshot = window.localStorage.getItem(PREFERENCES_STORAGE_KEY);
    void rssService
      .clearWebviewCache()
      .catch(() => {})
      .finally(() => {
        if (prefsSnapshot !== null) {
          window.localStorage.setItem(PREFERENCES_STORAGE_KEY, prefsSnapshot);
        }
      });
    return cleared;
  }, []);

  /** 分组操作 */
  const handleAddGroup = useCallback((name: string) => {
    const newGroup: Group = { id: uid(), name };
    setState((prev) => {
      const next = { ...prev, groups: [newGroup, ...prev.groups] };
      rssService.saveStateDebounced(next);
      return next;
    });
  }, []);

  const handleRenameGroup = useCallback((id: string, name: string) => {
    setState((prev) => {
      const next = { ...prev, groups: prev.groups.map((g) => (g.id === id ? { ...g, name } : g)) };
      rssService.saveStateDebounced(next);
      return next;
    });
  }, []);

  const handleRemoveGroup = useCallback((id: string) => {
    setState((prev) => {
      const next = {
        ...prev,
        groups: prev.groups.filter((g) => g.id !== id),
        feeds: prev.feeds.map((f) => (f.group_id === id ? { ...f, group_id: null } : f)),
      };
      rssService.saveStateDebounced(next);
      return next;
    });
  }, []);

  /**
   * 同组内移动订阅源。
   * `beforeId` 为「拖拽到某个源之前」，优先级最高；否则按 `position` 处理。
   * 具体重排规则在纯函数 `reorderFeedsInGroup` 里（已单独验证）。
   */
  const handleMoveFeed = useCallback((
    feedId: string,
    position: FeedMovePosition,
    beforeId?: string | null,
  ) => {
    setState((prev) => {
      const feed = prev.feeds.find((f) => f.id === feedId);
      if (!feed) return prev;

      const groupFeeds = prev.feeds
        .filter((f) => f.group_id === feed.group_id)
        .sort((a, b) => a.sort_order - b.sort_order);

      const reindexed = reorderFeedsInGroup(groupFeeds, feedId, position, beforeId);
      if (reindexed === null) return prev;

      const others = prev.feeds.filter((f) => f.group_id !== feed.group_id);
      const next = { ...prev, feeds: [...others, ...reindexed] };
      rssService.saveStateDebounced(next);
      return next;
    });
  }, []);

  /** 移动订阅源到指定分组末尾 */
  const handleMoveToGroup = useCallback((feedId: string, groupId: string | null) => {
    setState((prev) => {
      const feed = prev.feeds.find((f) => f.id === feedId);
      if (!feed || feed.group_id === groupId) return prev;

      // 旧组重新索引（移除该 feed 后）
      const oldGroupFeeds = prev.feeds
        .filter((f) => f.group_id === feed.group_id && f.id !== feedId)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((f, i) => ({ ...f, sort_order: i }));

      // 新组末尾追加
      const newGroupFeeds = prev.feeds
        .filter((f) => f.group_id === groupId && f.id !== feedId)
        .sort((a, b) => a.sort_order - b.sort_order);
      newGroupFeeds.push({ ...feed, group_id: groupId });
      const reindexedNew = newGroupFeeds.map((f, i) => ({ ...f, sort_order: i }));

      // 不涉及的组保持原样
      const others = prev.feeds.filter(
        (f) => f.group_id !== feed.group_id && f.group_id !== groupId && f.id !== feedId,
      );

      const next = { ...prev, feeds: [...others, ...oldGroupFeeds, ...reindexedNew] };
      rssService.saveStateDebounced(next);
      return next;
    });
  }, []);

  /** 拖动排序分组：移到 beforeGroupId 之前（null = 末尾）。分组顺序就是 groups 数组顺序 */
  const handleReorderGroup = useCallback((groupId: string, beforeGroupId: string | null) => {
    setState((prev) => {
      const groups = reorderGroups(prev.groups, groupId, beforeGroupId);
      if (!groups) return prev;
      const next = { ...prev, groups };
      rssService.saveStateDebounced(next);
      return next;
    });
  }, []);

  /** 备份当前数据到文件 */
  const handleBackup = useCallback(async () => {
    try {
      const filePath = await showSaveDialog({
        defaultPath: `rss-reader-backup-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!filePath) return;
      await rssService.backupState(filePath, stateRef.current);
      setError(null);
    } catch (err) {
      setError(`备份失败: ${String(err)}`);
    }
  }, []);

  /** 从文件还原数据 */
  const handleRestore = useCallback(async () => {
    try {
      const filePath = await showOpenDialog({
        filters: [{ name: "JSON", extensions: ["json"] }],
        multiple: false,
      });
      if (!filePath) return;
      const restored = await rssService.restoreState(filePath);
      // 备份文件可能来自旧版本：同样先合并重复 id 再入库
      const articles = dedupeArticlesById(restored.articles);
      const next: AppState = articles === null ? restored : { ...restored, articles };
      setState(next);
      void rssService.saveState(next);
      setSelectedFeedId(null);
      setSelectedArticleId(null);
      setError(null);
    } catch (err) {
      setError(`还原失败: ${String(err)}`);
    }
  }, []);

  // 切换订阅源 / 视图过滤 / 排序 / 搜索时，重置分批渲染上限
  useEffect(() => {
    setRenderLimit(300);
  }, [selectedFeedId, prefs.viewFilter, prefs.viewSort, searchQuery]);

  // 过滤当前显示的文章列表（按订阅源 + 筛选 + 搜索 + 视图设置过滤，再排序）
  // 注意：必须在 if (loading) 早退之前调用（Rules of Hooks），
  // 否则首次渲染与重渲染的 hook 数量不一致会导致 React 崩溃白屏。
  // starredView 取自 ref（见上方说明），用局部常量绑定，保证放进依赖数组时能被正确比较。
  const starredView = starredViewRef.current;
  const visibleArticles = useMemo(() => {
    const filtered = filterArticles(state.articles, {
      selectedFeedId,
      starredView,
      prefs,
      searchQuery,
      searchIndex,
    });

    // 预解析发布时间戳：排序比较器里反复 new Date() 解析在大列表下开销显著
    const decorated = filtered.map((a) => ({
      a,
      ts: a.published_at ? Date.parse(a.published_at) : 0,
    }));

    if (prefs.viewSort === "oldest") {
      decorated.sort((x, y) => x.ts - y.ts);
    } else if (prefs.viewSort === "feed") {
      decorated.sort((x, y) => {
        const fa = feedTitleById.get(x.a.feed_id) ?? "";
        const fb = feedTitleById.get(y.a.feed_id) ?? "";
        if (fa !== fb) return fa.localeCompare(fb);
        // 同名源内按发布时间倒序，保持稳定可读
        return y.ts - x.ts;
      });
    } else {
      // 默认：最新优先
      decorated.sort((x, y) => y.ts - x.ts);
    }
    return decorated.map((d) => d.a);
  }, [state.articles, selectedFeedId, prefs.viewFilter, prefs.viewSort, feedTitleById, searchQuery, searchIndex, starredView]);

  // 仅渲染前 renderLimit 条；滚动到底部由 ArticleList 触发加载更多
  const shownArticles = useMemo(
    () => visibleArticles.slice(0, renderLimit),
    [visibleArticles, renderLimit],
  );
  const handleLoadMore = useCallback(() => {
    setRenderLimit((l) => l + 300);
  }, []);

  if (loading) {
    return <div className="app-loading">加载中…</div>;
  }

  const selectedArticle = selectedArticleId
    ? state.articles.find((a) => a.id === selectedArticleId) ?? null
    : null;

  // 选中订阅源对象：用于列表标题与「收藏」视图判断
  const selectedFeed = selectedFeedId
    ? state.feeds.find((f) => f.id === selectedFeedId) ?? null
    : null;
  const currentFeedName = selectedFeed?.title ?? null;

  // 阅读视图的来源：按文章自身所属订阅源查找。
  // 「全部文章」下 selectedFeed 为 null，若直接用它就会显示「未知来源」。
  const articleFeed = selectedArticle
    ? state.feeds.find((f) => f.id === selectedArticle.feed_id) ?? null
    : null;
  const hasMoreArticles = visibleArticles.length > renderLimit;

  // 分享面板的目标文章与来源（文章可能已被刷新移除，取不到时面板不渲染）
  const shareArticle = shareTarget
    ? state.articles.find((a) => a.id === shareTarget.articleId) ?? null
    : null;
  const shareFeed = shareArticle
    ? state.feeds.find((f) => f.id === shareArticle.feed_id) ?? null
    : null;

  return (
    <div className="app">
      <TitleBar
        title="RSS Reader"
        onRefresh={handleRefresh}
        onMarkAllRead={handleMarkAllRead}
        onOpenSettings={() => setShowSettings(true)}
        refreshing={refreshing}
        onToggleDrawer={() => setDrawerOpen((v) => !v)}
        viewFilter={prefs.viewFilter}
        onViewFilterChange={(filter) => updatePrefs({ viewFilter: filter })}
        viewSort={prefs.viewSort}
        onViewSortChange={(sort) => updatePrefs({ viewSort: sort })}
        viewMode={prefs.viewMode}
        onViewModeChange={(mode) => updatePrefs({ viewMode: mode })}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        messages={messages}
        onClearMessages={clearMessages}
        stats={{
          feeds: state.feeds.length,
          articles: state.articles.length,
          unread: stats.unreadTotal,
        }}
      />

      <div className="app-body">
        {/* 中间 — 文章列表（宽度可拖拽） */}
        <main className="app-content" style={{ width: `${articleListWidth}px` }}>
          <ArticleList
            articles={shownArticles}
            selectedArticleId={selectedArticleId}
            onSelect={handleSelectArticle}
            currentFeedName={currentFeedName}
            title={
              !selectedFeed && (starredView || prefs.viewFilter === "starred") ? "收藏" : undefined
            }
            total={visibleArticles.length}
            hasMore={hasMoreArticles}
            onLoadMore={handleLoadMore}
            viewMode={prefs.viewMode}
            resetKey={`${selectedFeedId ?? "all"}|${starredView ? "starred-drawer" : prefs.viewFilter}|${prefs.viewSort}|${prefs.viewMode}|${searchQuery.trim()}`}
            feedTitles={feedTitleById}
            emptyHint={
              searchQuery.trim()
                ? "没有匹配的文章，换个关键字试试"
                : starredView || prefs.viewFilter === "starred"
                  ? "还没有收藏的文章，打开文章后点「收藏」即可加入"
                  : undefined
            }
            emptyIcon={starredView || prefs.viewFilter === "starred" ? "star" : undefined}
            onOpenExternal={handleOpenArticleExternal}
            onToggleRead={handleSetRead}
            onToggleStar={handleToggleStarred}
            onShare={handleShareArticle}
          />
        </main>

        <div className="resizer" onMouseDown={handleResizeStart} />

        {/* 右侧 — 阅读视图（滚动容器本身：切换文章时滚动位置重置到顶部） */}
        <section className="app-reader" ref={readerRef}>
          {selectedArticle ? (
            <ArticleView
              article={selectedArticle}
              feed={articleFeed}
              onToggleStarred={() => void handleToggleStarred(selectedArticle.id)}
              onOpenLink={() =>
                selectedArticle.link && void handleOpenArticle(selectedArticle.link)
              }
              onOpenExternal={(url) => void handleOpenArticle(url)}
              onShare={(anchor) => handleShareArticle(selectedArticle.id, anchor)}
              fontSize={prefs.fontSize}
              proxyArg={buildProxyArg(prefs)}
            />
          ) : (
            <div className="reader-empty">
              <span className="material-symbols-rounded">newspaper</span>
              <p>选择一篇文章开始阅读</p>
            </div>
          )}
        </section>
      </div>

      {drawerOpen && (
        <>
          <div className="nav-drawer-scrim" onClick={() => setDrawerOpen(false)} />
          <div className="nav-drawer">
            <FeedList
              feeds={state.feeds}
              groups={state.groups}
              selectedFeedId={selectedFeedId}
              unreadCounts={stats.unreadCounts}
              starredCount={stats.starredTotal}
              starredActive={starredView}
              onSelectAll={handleSelectAllFeeds}
              onSelectStarred={handleSelectStarred}
              onSelect={handleSelectFeed}
              onMarkFeedRead={handleMarkFeedRead}
              onRefreshFeed={handleRefreshFeed}
              onManageFeeds={() => {
                setShowSettings(true);
                setDrawerOpen(false);
              }}
              collapsedKeys={prefs.sidebarCollapsedGroups}
              onToggleGroupCollapsed={(key) => toggleCollapsedKey("sidebarCollapsedGroups", key)}
            />
          </div>
        </>
      )}

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          feeds={state.feeds}
          groups={state.groups}
          fontSize={prefs.fontSize}
          onFontSizeChange={handleFontSizeChange}
          theme={prefs.theme}
          onThemeChange={(theme) => updatePrefs({ theme })}
          refreshFrequency={prefs.refreshFrequency}
          onRefreshFrequencyChange={(freq) => updatePrefs({ refreshFrequency: freq })}
          proxy={prefs.proxy}
          onProxyChange={(proxy) => updatePrefs({ proxy })}
          onAddFeedUrl={handleAddFeed}
          onBatchImport={handleBatchImportFeeds}
          onRemoveFeed={handleRemoveFeed}
          onRemoveFeeds={handleRemoveFeeds}
          onUpdateFeed={handleUpdateFeed}
          onMoveFeed={handleMoveFeed}
          onMoveToGroup={handleMoveToGroup}
          onReorderGroup={handleReorderGroup}
          collapsedGroups={prefs.organizeCollapsedGroups}
          onToggleGroupCollapsed={(key) => toggleCollapsedKey("organizeCollapsedGroups", key)}
          onAddGroup={handleAddGroup}
          onRenameGroup={handleRenameGroup}
          onRemoveGroup={handleRemoveGroup}
          onClearLocalCache={handleClearLocalCache}
          onBackup={handleBackup}
          onRestore={handleRestore}
        />
      )}

      {pendingFeedUrl !== null && (
        <AddFeedModal
          initialUrl={pendingFeedUrl}
          onClose={() => setPendingFeedUrl(null)}
          onAdd={async (url) => {
            await handleAddFeed(url);
            setPendingFeedUrl(null);
            addMessage("success", `已添加订阅：${url}`);
          }}
        />
      )}

      {shareTarget && shareArticle && (
        <ShareMenu
          article={shareArticle}
          feed={shareFeed}
          anchor={shareTarget.anchor}
          onClose={() => setShareTarget(null)}
          onMessage={addMessage}
        />
      )}

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)}>关闭</button>
        </div>
      )}
    </div>
  );
}

export default App;
