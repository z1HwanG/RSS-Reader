/*
 * 文件名: SettingsModal.tsx
 * 描述: Fluent 2 ContentDialog — 标签式设置面板
 *   订阅源: 内联添加 URL + OPML 导入导出 + 全量列表
 *   分组与排序: 分组管理 + 上下移动排序 + 分组下拉
 *   网络: HTTP 代理（格式校验 + 连通性测试）；通用: 清理缓存 / 备份还原
 *   所有设置即时生效（含阅读字号）；点击遮罩或按 Esc 关闭
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { save as showSaveDialog, open as showOpenDialog } from "@tauri-apps/plugin-dialog";
import {
  buildProxyUrl,
  type RefreshFrequency,
  type ThemePreference,
  type ProxyPrefs,
} from "../../../lib/preferences";
import type { Feed, Group } from "../types";
import {
  filterFeedsByName,
  sortFeeds,
  sortFeedsByGroupOrder,
  type FeedMovePosition,
  type FeedSortDirection,
  type FeedSortMode,
} from "../../../lib/feedOrder";
import * as rssService from "../services/rssService";
import * as updateService from "../services/updateService";
import pkg from "../../../../package.json";

type SettingsTab = "feeds" | "organize" | "appearance" | "network" | "general" | "about";

/** 「全部订阅源」排序方式 / 方向的本地偏好键（只影响设置面板展示顺序） */
const FEED_SORT_STORAGE_KEY = "rss-reader-feed-sort-mode";
const FEED_SORT_DIRECTION_KEY = "rss-reader-feed-sort-direction";

interface SettingsModalProps {
  onClose: () => void;
  feeds: Feed[];
  groups: Group[];
  fontSize: number;
  onFontSizeChange: (size: number) => void;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  refreshFrequency: RefreshFrequency;
  onRefreshFrequencyChange: (freq: RefreshFrequency) => void;
  proxy: ProxyPrefs;
  onProxyChange: (proxy: ProxyPrefs) => void;
  /** 内联添加订阅源 URL */
  onAddFeedUrl: (url: string) => Promise<void>;
  /** 批量导入订阅源（仅写入 URL+标题，后台刷新） */
  onBatchImport: (items: { url: string; title?: string }[]) => Promise<void>;
  onRemoveFeed: (feedId: string) => void;
  /** 批量删除订阅源 */
  onRemoveFeeds: (feedIds: string[]) => void;
  /** 更新订阅源属性（名称/URL/打开方式） */
  onUpdateFeed: (feedId: string, patch: Partial<Pick<Feed, "title" | "url" | "open_method">>) => Promise<void>;
  /**
   * 移动订阅源：按档位上移/下移/置顶/置底，或（拖拽时）插到 `beforeId` 之前。
   * 只在同组内生效，`sort_order` 为组内序号。
   */
  onMoveFeed: (feedId: string, position: FeedMovePosition, beforeId?: string | null) => void;
  onMoveToGroup: (feedId: string, groupId: string | null) => void;
  /**
   * 拖动排序分组：把 `groupId` 移到 `beforeGroupId` 之前（null = 移到末尾）。
   * 分组先后由 state.groups 的数组顺序决定，没有 sort_order。
   */
  onReorderGroup: (groupId: string, beforeGroupId: string | null) => void;
  /** 「分组与排序」里被折叠的分组（分组 id；未分组用 `__ungrouped__`），持久化在偏好里 */
  collapsedGroups: string[];
  onToggleGroupCollapsed: (key: string) => void;
  onAddGroup: (name: string) => void;
  onRenameGroup: (id: string, name: string) => void;
  onRemoveGroup: (id: string) => void;
  /** 清理本地缓存（内存里的全文提取结果 / 列表预览 / 搜索索引），返回清掉的条数；不删除文章 */
  onClearLocalCache: () => number;
  onBackup: () => void;
  onRestore: () => void;
}

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "feeds", label: "订阅源" },
  { id: "organize", label: "分组与排序" },
  { id: "appearance", label: "外观" },
  { id: "network", label: "网络" },
  { id: "general", label: "通用" },
  { id: "about", label: "关于" },
];

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

const FREQUENCY_OPTIONS: { value: RefreshFrequency; label: string }[] = [
  { value: "never", label: "从不" },
  { value: "10m", label: "10 分钟" },
  { value: "15m", label: "15 分钟" },
  { value: "20m", label: "20 分钟" },
  { value: "30m", label: "30 分钟" },
  { value: "45m", label: "45 分钟" },
  { value: "1h", label: "1 小时" },
];

/** 规范化代理主机：剥离误填的 scheme 前缀与结尾斜杠（与 Rust 侧 normalize_proxy_host 对齐） */
function normalizeProxyHost(host: string): string {
  return host.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

/** 校验代理主机：非空，且能与端口拼出合法 URL（镜像 Rust 侧 http/socks5://{host}:{port} 的拼装方式） */
function proxyHostError(host: string): string | null {
  const trimmed = normalizeProxyHost(host);
  if (!trimmed) return "请输入代理主机";
  try {
    const parsed = new URL(`http://${trimmed}:1`);
    return parsed.hostname ? null : "代理主机格式不正确";
  } catch {
    return "代理主机格式不正确";
  }
}

/** 校验代理端口：1-65535 的整数 */
function proxyPortError(port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "端口需为 1-65535 的整数";
  }
  return null;
}

// ---- OPML 辅助函数 ----

/**
 * 把 XMLSerializer 的单行输出按层级缩进。
 * 属性值里的尖括号已被序列化器转义，因此 > < 只会作为标签分隔符出现，按此分词是安全的。
 */
function prettyPrintXml(xml: string): string {
  const lines = xml.replace(/(>)(<)(\/*)/g, "$1\n$2$3").split("\n");
  let depth = 0;
  const out = lines.map((line) => {
    const isDeclaration = /^<[?!]/.test(line);
    const isClosing = /^<\//.test(line);
    const isSelfClosing = /\/>$/.test(line);
    // 同一行内完成开闭的元素（如 <title>x</title>）不改变层级
    const isInline = /^<[^>]+>.*<\/[^>]+>$/.test(line);
    if (isClosing) depth = Math.max(0, depth - 1);
    const indented = "  ".repeat(depth) + line;
    if (!isClosing && !isSelfClosing && !isDeclaration && !isInline) depth += 1;
    return indented;
  });
  return out.join("\n") + "\n";
}

/** 解析 OPML XML，提取所有订阅源 URL */
function parseOpml(xml: string): { url: string; title: string }[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const result: { url: string; title: string }[] = [];
  const outlines = doc.querySelectorAll("outline[xmlUrl]");
  outlines.forEach((el) => {
    const url = el.getAttribute("xmlUrl") || "";
    const title = el.getAttribute("text") || el.getAttribute("title") || url;
    if (url) result.push({ url, title });
  });
  return result;
}

/** 从订阅源列表生成 OPML XML */
function generateOpml(feeds: Feed[], groups: Group[]): string {
  const doc = document.implementation.createDocument(null, "opml", null);
  doc.documentElement.setAttribute("version", "2.0");
  const head = doc.createElement("head");
  const title = doc.createElement("title");
  title.textContent = "RSS Reader Subscriptions";
  head.appendChild(title);
  doc.documentElement.appendChild(head);
  const body = doc.createElement("body");

  const makeOutline = (feed: Feed): Element => {
    const el = doc.createElement("outline");
    el.setAttribute("type", "rss");
    el.setAttribute("text", feed.title || feed.url);
    el.setAttribute("title", feed.title || feed.url);
    el.setAttribute("xmlUrl", feed.url);
    if (feed.site_url) el.setAttribute("htmlUrl", feed.site_url);
    return el;
  };

  // 未分组
  for (const f of feeds.filter((f) => !f.group_id)) {
    body.appendChild(makeOutline(f));
  }
  // 分组
  for (const g of groups) {
    const groupFeeds = feeds.filter((f) => f.group_id === g.id);
    if (groupFeeds.length === 0) continue;
    const gEl = doc.createElement("outline");
    gEl.setAttribute("text", g.name);
    gEl.setAttribute("title", g.name);
    for (const f of groupFeeds) gEl.appendChild(makeOutline(f));
    body.appendChild(gEl);
  }

  doc.documentElement.appendChild(body);
  // XMLSerializer 输出为单行，这里缩进排版，便于阅读与版本对比
  return prettyPrintXml(
    `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(doc)}`,
  );
}

/** 字节数格式化（更新下载进度展示用） */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function SettingsModal({
  onClose,
  feeds,
  groups,
  fontSize,
  onFontSizeChange,
  theme,
  onThemeChange,
  refreshFrequency,
  onRefreshFrequencyChange,
  proxy,
  onProxyChange,
  onAddFeedUrl,
  onBatchImport,
  onRemoveFeed,
  onRemoveFeeds,
  onUpdateFeed,
  onMoveFeed,
  onMoveToGroup,
  onReorderGroup,
  collapsedGroups,
  onToggleGroupCollapsed,
  onAddGroup,
  onRenameGroup,
  onRemoveGroup,
  onClearLocalCache,
  onBackup,
  onRestore,
}: SettingsModalProps): JSX.Element {
  const [tab, setTab] = useState<SettingsTab>("feeds");
  const [newGroupName, setNewGroupName] = useState("");
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editGroupName, setEditGroupName] = useState("");

  // 订阅源 tab 状态
  const [urlInput, setUrlInput] = useState("");
  const [addingFeed, setAddingFeed] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [importDone, setImportDone] = useState<string | null>(null);
  // 订阅源 tab — 选框 + 编辑面板
  const [checkedFeedIds, setCheckedFeedIds] = useState<Set<string>>(new Set());
  const [editTitle, setEditTitle] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editOpenMethod, setEditOpenMethod] = useState<string>("internal");
  const [confirmDeleteIds, setConfirmDeleteIds] = useState<string[] | null>(null);
  // 清理缓存：待确认的档位 + 完成提示
  const [cleanupNotice, setCleanupNotice] = useState<string | null>(null);

  // 网络 tab 状态：端口草稿（允许输入中间态，仅合法值向上同步）+ 连接测试
  const [portDraft, setPortDraft] = useState<string>(String(proxy.port));
  const [testingProxy, setTestingProxy] = useState(false);
  const [proxyTestResult, setProxyTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  // ===== 自动更新 =====
  /** idle 未检查 / checking 检查中 / latest 已是最新 / available 有新版本 / installing 下载安装中 / error 失败 */
  const [updatePhase, setUpdatePhase] = useState<
    "idle" | "checking" | "latest" | "available" | "installing" | "error"
  >("idle");
  const [updateInfo, setUpdateInfo] = useState<updateService.AvailableUpdate | null>(null);
  const [updateProgress, setUpdateProgress] = useState<updateService.DownloadProgress | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  /** 下载进度百分比；服务端未给总大小时为 null（显示不确定进度条） */
  const updatePercent =
    updateProgress?.total && updateProgress.total > 0
      ? Math.min(100, Math.round((updateProgress.downloaded / updateProgress.total) * 100))
      : null;

  /** 检查更新：代理取应用内配置，未启用时交给系统代理 */
  const handleCheckUpdate = useCallback(async (): Promise<void> => {
    setUpdatePhase("checking");
    setUpdateError(null);
    setUpdateInfo(null);
    try {
      const result = await updateService.checkForUpdate(buildProxyUrl(proxy));
      if (result) {
        setUpdateInfo(result);
        setUpdatePhase("available");
      } else {
        setUpdatePhase("latest");
      }
    } catch (err) {
      setUpdateError(String(err));
      setUpdatePhase("error");
    }
  }, [proxy]);

  /** 下载并安装：Windows 上安装器接管后应用自动退出并重启 */
  const handleInstallUpdate = useCallback(async (): Promise<void> => {
    if (!updateInfo) return;
    setUpdatePhase("installing");
    setUpdateError(null);
    setUpdateProgress({ downloaded: 0, total: null });
    try {
      await updateInfo.install(setUpdateProgress);
    } catch (err) {
      setUpdateError(String(err));
      setUpdatePhase("error");
    }
  }, [updateInfo]);

  /**
   * 「全部订阅源」列表的排序方式：按添加时间 / 按分组。
   * 只影响设置面板的展示顺序，不改动订阅源本身（真正的顺序由分组 + 组内 sort_order 决定）。
   * 「按添加时间」还有一个方向：最新在前（默认）/ 最早在前，点箭头切换。
   */
  const [feedSortMode, setFeedSortMode] = useState<FeedSortMode>(
    () => (window.localStorage.getItem(FEED_SORT_STORAGE_KEY) as FeedSortMode | null) ?? "added",
  );
  const [feedSortDirection, setFeedSortDirection] = useState<FeedSortDirection>(() =>
    window.localStorage.getItem(FEED_SORT_DIRECTION_KEY) === "asc" ? "asc" : "desc",
  );
  const changeFeedSortMode = (mode: FeedSortMode): void => {
    setFeedSortMode(mode);
    window.localStorage.setItem(FEED_SORT_STORAGE_KEY, mode);
  };
  const toggleFeedSortDirection = (): void => {
    setFeedSortDirection((prev) => {
      const next: FeedSortDirection = prev === "desc" ? "asc" : "desc";
      window.localStorage.setItem(FEED_SORT_DIRECTION_KEY, next);
      return next;
    });
  };
  // 直接计算（不用 useMemo）：订阅源只有几十个，排序开销可忽略；
  // 避免任何缓存让「列表顺序」在排序操作后仍是旧值。
  const sortedFeeds = sortFeeds(feeds, groups, feedSortMode, feedSortDirection);
  /**
   * 「分组与排序」页签的顺序：始终按「分组 + 组内 sort_order」，不跟随上面的浏览偏好。
   * 反之，在「按添加时间」下点置顶/置底、拖动排序，界面会被时间戳顺序盖住，看着像没生效。
   */
  const organizeFeeds = sortFeedsByGroupOrder(feeds, groups);
  /** 「全部订阅源」的名称搜索（会话内状态，不持久化） */
  const [feedQuery, setFeedQuery] = useState("");
  const visibleFeeds = filterFeedsByName(sortedFeeds, feedQuery);
  const searchingFeeds = feedQuery.trim().length > 0;

  // 订阅源 tab 选框切换
  const toggleFeedCheck = (feedId: string): void => {
    setCheckedFeedIds((prev) => {
      const next = new Set(prev);
      if (next.has(feedId)) next.delete(feedId);
      else next.add(feedId);
      return next;
    });
  };

  // 订阅源 tab — 全选/取消全选
  // 注意：以「当前可见（可能被搜索过滤）的订阅源」为准，避免搜索时全选到看不见的源。
  const allFeedIds = new Set(visibleFeeds.map((f) => f.id));
  const allFeedsChecked = checkedFeedIds.size > 0 && checkedFeedIds.size === allFeedIds.size;
  const someFeedsChecked = checkedFeedIds.size > 0 && !allFeedsChecked;

  const toggleAllFeeds = (): void => {
    if (allFeedsChecked) {
      setCheckedFeedIds(new Set());
    } else {
      setCheckedFeedIds(new Set(allFeedIds));
    }
  };

  const handleDeleteChecked = (): void => {
    setConfirmDeleteIds([...checkedFeedIds]);
  };

  const handleConfirmDelete = (): void => {
    if (!confirmDeleteIds) return;
    if (confirmDeleteIds.length === 1) {
      onRemoveFeed(confirmDeleteIds[0]);
    } else {
      onRemoveFeeds(confirmDeleteIds);
    }
    setCheckedFeedIds(new Set());
    setConfirmDeleteIds(null);
  };

  // 选中单个订阅源时，同步编辑面板字段
  useEffect(() => {
    if (checkedFeedIds.size === 1) {
      const feed = feeds.find((f) => checkedFeedIds.has(f.id));
      if (feed) {
        setEditTitle(feed.title);
        setEditUrl(feed.url);
        setEditOpenMethod(feed.open_method ?? "internal");
      }
    }
  }, [checkedFeedIds, feeds]);

  // 外部端口值变化时同步草稿（如偏好被其他途径更新）
  useEffect(() => {
    setPortDraft(String(proxy.port));
  }, [proxy.port]);

  // Esc 关闭设置面板（底部已无关闭按钮）；确认框打开时优先关闭它
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (confirmDeleteIds) {
        setConfirmDeleteIds(null);
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirmDeleteIds, onClose]);

  function getFeedsByGroup(groupId: string | null): Feed[] {
    return organizeFeeds.filter((f) => f.group_id === groupId);
  }

  // ---- 订阅源 tab 操作 ----

  const handleAddUrl = async (): Promise<void> => {
    const url = urlInput.trim();
    if (!url) return;
    if (!rssService.isValidHttpUrl(url)) {
      setAddError("请输入合法的 http:// 或 https:// URL");
      return;
    }
    setAddingFeed(true);
    setAddError(null);
    try {
      await onAddFeedUrl(url);
      setUrlInput("");
    } catch (err) {
      setAddError(String(err));
    } finally {
      setAddingFeed(false);
    }
  };

  const handleImportOpml = async (): Promise<void> => {
    try {
      const filePath = await showOpenDialog({
        filters: [{ name: "OPML / XML", extensions: ["opml", "xml"] }],
        multiple: false,
      });
      if (!filePath) return;

      const content = await rssService.readFileText(filePath);
      const items = parseOpml(content);
      if (items.length === 0) {
        setAddError("未在 OPML 文件中找到订阅源");
        return;
      }

      setImportProgress({ done: 0, total: items.length });
      await onBatchImport(items);
      setImportProgress(null);
      setImportDone(`已导入 ${items.length} 条订阅源，正在后台刷新…`);
      setTimeout(() => setImportDone(null), 5000);
    } catch (err) {
      setAddError(`OPML 导入失败: ${String(err)}`);
      setImportProgress(null);
    }
  };

  const handleExportOpml = async (): Promise<void> => {
    try {
      const filePath = await showSaveDialog({
        defaultPath: `rss-reader-${new Date().toISOString().slice(0, 10)}.opml`,
        filters: [{ name: "OPML", extensions: ["opml"] }],
      });
      if (!filePath) return;
      const content = generateOpml(feeds, groups);
      await rssService.writeFileText(filePath, content);
    } catch (err) {
      setAddError(`OPML 导出失败: ${String(err)}`);
    }
  };

  // ---- 网络 tab 操作 ----

  /** 端口输入：草稿实时更新，仅合法值同步到偏好（避免输入中间态被强行改写为默认值） */
  const handlePortDraftChange = (value: string): void => {
    setPortDraft(value);
    const parsed = Number(value);
    if (value.trim() !== "" && proxyPortError(parsed) === null) {
      onProxyChange({ ...proxy, port: parsed });
    }
  };

  /** 端口失焦：非法草稿回滚为当前生效值 */
  const handlePortDraftBlur = (): void => {
    if (proxyPortError(Number(portDraft)) !== null) {
      setPortDraft(String(proxy.port));
    }
  };

  /** 主机失焦：剥离 scheme 与结尾斜杠，并拆出误填在主机里的端口（如 127.0.0.1:7890） */
  const handleHostBlur = (): void => {
    let host = normalizeProxyHost(proxy.host);
    let port = portDraft;
    const colon = host.lastIndexOf(":");
    if (colon > -1 && !host.startsWith("[") && /^\d+$/.test(host.slice(colon + 1))) {
      port = host.slice(colon + 1);
      host = host.slice(0, colon);
    }
    const portChanged = port !== portDraft;
    const hostChanged = host !== proxy.host;
    if (!hostChanged && !portChanged) return;
    if (portChanged) setPortDraft(port);
    const parsedPort = Number(port);
    onProxyChange({
      ...proxy,
      host,
      ...(proxyPortError(parsedPort) === null ? { port: parsedPort } : {}),
    });
  };

  /** 代理连通性测试：经 Rust 侧通过代理请求探测地址 */
  const handleTestProxy = async (): Promise<void> => {
    const host = normalizeProxyHost(proxy.host);
    if (proxyHostError(host) !== null || proxyPortError(Number(portDraft)) !== null) return;
    setTestingProxy(true);
    setProxyTestResult(null);
    try {
      const result = await rssService.testProxy(host, Number(portDraft), proxy.kind);
      const probeHost = new URL(result.target).host;
      setProxyTestResult({
        ok: true,
        text: `连接成功（${probeHost}，${result.latency_ms} ms）`,
      });
    } catch (err) {
      setProxyTestResult({ ok: false, text: `连接失败：${String(err)}` });
    } finally {
      setTestingProxy(false);
    }
  };

  // ---- 分组与排序 tab 操作 ----

  const handleAddGroupClick = (): void => {
    const name = newGroupName.trim();
    if (!name) return;
    onAddGroup(name);
    setNewGroupName("");
  };

  const startEditGroup = (g: Group): void => {
    setEditingGroupId(g.id);
    setEditGroupName(g.name);
  };

  const confirmRenameGroup = (): void => {
    if (editingGroupId && editGroupName.trim()) {
      onRenameGroup(editingGroupId, editGroupName.trim());
    }
    setEditingGroupId(null);
  };

  // ---- 分组与排序 tab：拖拽排序 ----
  /**
   * 拖拽排序用**原生事件监听**实现，不走 React 的合成事件：
   * 浏览器在 dragstart 之后会立刻连续派发 dragover，而 React 的 setState 是异步批处理的，
   * 那时读取 state 拿到的仍是「没在拖」，onDragOver 里一旦据此 return 就从不 accept，
   * 浏览器会把整片区域显示成「禁止」光标（实测症状）。原生监听里用一个普通变量记录状态，
   * 同步读写、与 React 的渲染时序完全解耦。
   *
   * 两条通道，同屏只启用一条：
   * - `html5`：`draggable` 行 + dragstart/dragover/drop。要求窗口 `dragDropEnabled: false`
   *   （Tauri 默认 true 会由 WebView2 接管拖放，HTML5 拖拽在 Windows 上完全失效）；
   * - `pointer`：按住拖拽手柄后用 pointer 事件自绘。不依赖任何原生拖放能力，
   *   因此在 `dragDropEnabled: true` 的窗口里也能用。
   *
   * 由 `pointerModeRef` 在运行时选定：手柄上指针一按下就先按 pointer 通道走，
   * 真浏览器随后派发 dragstart 时再让位给 HTML5 通道（见 onPointerDown 里的指针捕获释放）。
   */
  const DRAG_THRESHOLD_PX = 4;
  const organizeListRef = useRef<HTMLDivElement | null>(null);
  const draggingIdRef = useRef<string | null>(null);
  /** 正在拖动的分组 id（拖分组时用它，与 draggingIdRef 互斥） */
  const draggingGroupIdRef = useRef<string | null>(null);
  const pointerModeRef = useRef(false);
  const pointerDragRef = useRef<{ startY: number; active: boolean; row: HTMLElement } | null>(null);
  /** 自动滚动的 rAF 句柄（拖到列表上下边缘时用） */
  const autoScrollRafRef = useRef<number | null>(null);
  /**
   * 拖拽期间要读订阅源列表：走 ref 而不是闭包里的 `feeds`。
   * 落点提交会触发一次重排，闭包里的 `feeds` 就成了旧值（跨分组判断会用到 group_id），
   * 而 ref 读的是最新一次渲染的数据。
   */
  const feedsRef = useRef<Feed[]>(feeds);
  feedsRef.current = feeds;

  /** 找当前滚动容器（列表可能整体不滚动，沿用最近的滚动祖先） */
  const scrollContainerOf = (el: HTMLElement): HTMLElement | null => {
    let node: HTMLElement | null = el.parentElement;
    while (node) {
      if (node.scrollHeight > node.clientHeight + 1) return node;
      node = node.parentElement;
    }
    return null;
  };

  /**
   * 按指针位置找落点：命中哪一行的上半 → 插到它之前；落到该分组末尾 → `beforeId` 为 null。
   * 返回 null 表示指针不在任何分组内（此时不提交，避免误判成「置底」）。
   */
  const findDropSlot = (
    clientY: number,
  ): { beforeId: string | null; groupKey: string | null } | null => {
    const container = organizeListRef.current;
    if (!container) return null;
    for (const group of container.querySelectorAll<HTMLElement>(".feed-group")) {
      const rect = group.getBoundingClientRect();
      if (clientY < rect.top || clientY > rect.bottom) continue;
      const groupKey = group.dataset.groupKey ?? null;
      const rows = [...group.querySelectorAll<HTMLElement>(".organize-row")];
      for (const row of rows) {
        const r = row.getBoundingClientRect();
        if (clientY < r.top + r.height / 2) {
          return { beforeId: row.dataset.feedId ?? null, groupKey };
        }
      }
      return { beforeId: null, groupKey };
    }
    return null;
  };

  /**
   * 提交一次移动：`slot` 为 null（指针不在任何分组内）时不做任何事。
   * 跨分组时先改归属，等状态落地再按落点排序。
   * 依赖只走 ref 与 `onMove*`（都是 useCallback 稳定引用），因此监听器可以只挂一次。
   */
  const commitDrop = (
    feedId: string,
    slot: { beforeId: string | null; groupKey: string | null } | null,
  ): void => {
    if (!slot) return;
    const dragged = feedsRef.current.find((f) => f.id === feedId);
    if (!dragged) return;
    const targetGroupId = slot.groupKey === "__ungrouped__" ? null : slot.groupKey;
    const crossGroup = slot.groupKey !== null && (dragged.group_id ?? null) !== targetGroupId;
    const beforeId = slot.beforeId === feedId ? null : slot.beforeId;
    if (crossGroup) onMoveToGroup(dragged.id, targetGroupId);
    // 有落点行 → 插到它之前；落在分组末尾（没有落点行）→ 置底。
    // 注意不能两种都传 "top"：纯函数把 `beforeId` 为 null 时的 "top" 解释成「移到首位」，
    // 拖到组末尾就会被判成原地不动，看着像没生效。
    const position: FeedMovePosition = beforeId ? "top" : "bottom";
    const run = (): void => onMoveFeed(dragged.id, position, beforeId);
    if (crossGroup) window.setTimeout(run, 0);
    else run();
  };

  /**
   * 拖动**分组**时的落点：命中某个分组的标题行 → 插到该分组之前；
   * 落到「未分组」区块 → 返回 `beforeGroupId: null`（排到所有分组之后）。
   * 指针不在任何标题行上时返回 null，不提交（避免误判成置底）。
   */
  const findGroupDropSlot = (clientY: number): { beforeGroupId: string | null } | null => {
    const container = organizeListRef.current;
    if (!container) return null;
    for (const block of container.querySelectorAll<HTMLElement>(".feed-group")) {
      const header = block.querySelector<HTMLElement>(".feed-group-header");
      if (!header) continue;
      const rect = header.getBoundingClientRect();
      if (clientY < rect.top || clientY > rect.bottom) continue;
      const key = block.dataset.groupKey ?? null;
      return { beforeGroupId: key === "__ungrouped__" ? null : key };
    }
    return null;
  };

  /** 提交一次分组拖动 */
  const commitGroupDrop = (
    groupId: string,
    slot: { beforeGroupId: string | null } | null,
  ): void => {
    if (!slot) return;
    if (slot.beforeGroupId === groupId) return; // 落到自己身上 = 不动
    onReorderGroup(groupId, slot.beforeGroupId);
  };

  /**
   * 拖拽手柄与落点逻辑都放在这里，注册却只发生一次（依赖只含 tab）。
   *
   * 原来把 `feeds` 放进依赖里，导致每次重排都重建监听：
   * 落点提交的那一瞬间正好把「拖拽中」的 DOM 状态和正在处理的监听一起拆掉。
   * 现在顺序由行 key 驱动重排，监听保持稳定，拖拽过程中不断线。
   */
  useEffect(() => {
    if (tab !== "organize") return;
    const container = organizeListRef.current;
    if (!container) return;

    const clearIndicator = (): void => {
      container.classList.remove("organize-dragging");
      container.querySelectorAll(".drop-before").forEach((el) => el.classList.remove("drop-before"));
      container.querySelectorAll(".drop-here").forEach((el) => el.classList.remove("drop-here"));
      container.querySelectorAll(".dragging").forEach((el) => el.classList.remove("dragging"));
    };

    const showIndicator = (slot: { beforeId: string | null; groupKey: string | null } | null): void => {
      const activeId = draggingIdRef.current;
      container.querySelectorAll(".drop-before").forEach((el) => {
        if (el.getAttribute("data-feed-id") !== slot?.beforeId) el.classList.remove("drop-before");
      });
      container.querySelectorAll(".drop-here").forEach((el) => {
        if (el.getAttribute("data-group-key") !== slot?.groupKey) el.classList.remove("drop-here");
      });
      if (!slot) return;
      const row = slot.beforeId
        ? container.querySelector<HTMLElement>(`.organize-row[data-feed-id="${CSS.escape(slot.beforeId)}"]`)
        : null;
      if (row && slot.beforeId !== activeId) row.classList.add("drop-before");
      if (slot.groupKey) {
        container
          .querySelector<HTMLElement>(`.feed-group[data-group-key="${CSS.escape(slot.groupKey)}"]`)
          ?.classList.add("drop-here");
      }
    };

    /** 分组拖动时的落点指示：给目标分组的标题行加同一条插入线 */
    const showGroupIndicator = (slot: { beforeGroupId: string | null } | null): void => {
      container.querySelectorAll(".feed-group-header.drop-before").forEach((el) => {
        el.classList.remove("drop-before");
      });
      if (!slot) return;
      if (slot.beforeGroupId === draggingGroupIdRef.current) return;
      const key = slot.beforeGroupId ?? "__ungrouped__";
      container
        .querySelector<HTMLElement>(`.feed-group[data-group-key="${CSS.escape(key)}"] .feed-group-header`)
        ?.classList.add("drop-before");
    };

    const stopAutoScroll = (): void => {
      if (autoScrollRafRef.current !== null) {
        cancelAnimationFrame(autoScrollRafRef.current);
        autoScrollRafRef.current = null;
      }
    };

    /** 拖到可滚动区域上下边缘时自动滚动，让长列表也能拖到远处的分组 */
    const startAutoScroll = (clientY: number): void => {
      stopAutoScroll();
      const scroller = scrollContainerOf(container);
      if (!scroller) return;
      const rect = scroller.getBoundingClientRect();
      const margin = 28;
      const speed =
        clientY < rect.top + margin
          ? -Math.ceil((rect.top + margin - clientY) / 3)
          : clientY > rect.bottom - margin
            ? Math.ceil((clientY - (rect.bottom - margin)) / 3)
            : 0;
      if (speed === 0) return;
      const step = (): void => {
        scroller.scrollTop += speed;
        autoScrollRafRef.current = requestAnimationFrame(step);
      };
      autoScrollRafRef.current = requestAnimationFrame(step);
    };

    /** 收起所有拖拽视觉状态（两条通道共用） */
    const resetDragState = (): void => {
      draggingIdRef.current = null;
      draggingGroupIdRef.current = null;
      pointerDragRef.current = null;
      pointerModeRef.current = false;
      stopAutoScroll();
      clearIndicator();
    };

    /** 当前拖的是什么（两类互斥） */
    const dragKind = (): "group" | "feed" | null =>
      draggingGroupIdRef.current ? "group" : draggingIdRef.current ? "feed" : null;

    /**
     * 手柄所在的分组区块。「未分组」区块不是一个分组，不能拖（返回 null）。
     */
    const groupBlockOf = (target: HTMLElement | null): { id: string; el: HTMLElement } | null => {
      const block = target?.closest<HTMLElement>(".feed-group") ?? null;
      const key = block?.dataset.groupKey ?? null;
      if (!block || !key || key === "__ungrouped__") return null;
      return { id: key, el: block };
    };

    // ===== 通道一：HTML5 原生拖拽 =====
    const onDragStart = (event: DragEvent): void => {
      if (!pointerModeRef.current) return;
      // 手柄按下的这次拖拽被浏览器接走了：原生拖放可用 → 从此走 HTML5 通道
      pointerModeRef.current = false;
      pointerDragRef.current = null;
      const target = event.target as HTMLElement | null;
      const group = target?.closest(".group-drag-handle") ? groupBlockOf(target) : null;
      if (group) {
        draggingGroupIdRef.current = group.id;
        group.el.classList.add("dragging");
        container.classList.add("organize-dragging");
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", group.id);
        }
        return;
      }
      const row = target?.closest<HTMLElement>(".organize-row");
      const id = row?.dataset.feedId ?? null;
      draggingIdRef.current = id;
      if (row) row.classList.add("dragging");
      container.classList.add("organize-dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", id ?? "");
      }
    };

    const onDragOver = (event: DragEvent): void => {
      if (pointerModeRef.current || !dragKind()) return;
      // 关键：同步 accept，浏览器就不会显示「禁止」光标
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      startAutoScroll(event.clientY);
      if (draggingGroupIdRef.current) showGroupIndicator(findGroupDropSlot(event.clientY));
      else showIndicator(findDropSlot(event.clientY));
    };

    const onDrop = (event: DragEvent): void => {
      if (pointerModeRef.current) return;
      const kind = dragKind();
      if (!kind) return;
      event.preventDefault();
      const groupId = draggingGroupIdRef.current;
      const feedId = draggingIdRef.current;
      const y = event.clientY;
      resetDragState();
      if (kind === "group" && groupId) commitGroupDrop(groupId, findGroupDropSlot(y));
      else if (feedId) commitDrop(feedId, findDropSlot(y));
    };

    const onDragEnd = (): void => resetDragState();

    // ===== 通道二：指针自绘拖拽（不依赖原生拖放） =====
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      // 分组手柄优先：分组的可拖区域只有标题行上的手柄
      if (target?.closest(".group-drag-handle")) {
        const group = groupBlockOf(target);
        if (!group) return;
        draggingGroupIdRef.current = group.id;
        pointerModeRef.current = true;
        pointerDragRef.current = { startY: event.clientY, active: false, row: group.el };
        group.el.draggable = true;
        try {
          group.el.setPointerCapture(event.pointerId);
        } catch {
          /* 拿不到捕获也能拖，只是移出窗口外会断线 */
        }
        return;
      }
      // 只有手柄按下才算「拖」——整行都能拖会和行内按钮抢事件，也让误拖变多
      if (!target?.closest(".feeds-manage-row-handle")) return;
      const row = target.closest<HTMLElement>(".organize-row");
      if (!row?.dataset.feedId) return;
      draggingIdRef.current = row.dataset.feedId;
      pointerModeRef.current = true;
      pointerDragRef.current = { startY: event.clientY, active: false, row };
      // 手柄按下才让这一行获得原生拖拽语义（原生拖放接管时由 HTML5 通道接手）
      row.draggable = true;
      try {
        // 指针捕获：拖出容器甚至窗口外也能继续收到 pointermove / pointerup。
        // 指针不处于活动状态时会抛 NotFoundError —— 必须在 try 里，
        // 否则异常会中断本处理函数，拖拽状态建不起来（拖拽直接失效）。
        row.setPointerCapture(event.pointerId);
      } catch {
        /* 拿不到捕获也能拖，只是移出窗口外会断线 */
      }
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (!pointerModeRef.current || !dragKind()) return;
      const drag = pointerDragRef.current;
      if (!drag) return;
      if (!drag.active) {
        if (Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
        drag.active = true;
        drag.row.classList.add("dragging");
        container.classList.add("organize-dragging");
      }
      event.preventDefault();
      startAutoScroll(event.clientY);
      if (draggingGroupIdRef.current) showGroupIndicator(findGroupDropSlot(event.clientY));
      else showIndicator(findDropSlot(event.clientY));
    };

    const finishPointerDrag = (event: PointerEvent, commit: boolean): void => {
      if (!pointerModeRef.current) return;
      const kind = dragKind();
      const groupId = draggingGroupIdRef.current;
      const feedId = draggingIdRef.current;
      const drag = pointerDragRef.current;
      const y = event.clientY;
      const active = Boolean(commit && drag?.active);
      const row = drag?.row;
      const groupSlot = active && kind === "group" ? findGroupDropSlot(y) : null;
      const feedSlot = active && kind === "feed" ? findDropSlot(y) : null;
      resetDragState();
      if (row?.hasPointerCapture(event.pointerId)) row.releasePointerCapture(event.pointerId);
      if (row) row.draggable = false;
      if (!active) return;
      if (kind === "group" && groupId) commitGroupDrop(groupId, groupSlot);
      else if (kind === "feed" && feedId) commitDrop(feedId, feedSlot);
    };

    const onPointerUp = (event: PointerEvent): void => finishPointerDrag(event, true);
    const onPointerCancel = (event: PointerEvent): void => finishPointerDrag(event, false);
    /** 拖到一半按 Esc：放弃这次拖拽（不改数据） */
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || !pointerModeRef.current) return;
      const row = pointerDragRef.current?.row;
      resetDragState();
      if (row) row.draggable = false;
    };

    container.addEventListener("dragstart", onDragStart);
    container.addEventListener("dragover", onDragOver);
    container.addEventListener("drop", onDrop);
    container.addEventListener("dragend", onDragEnd);
    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerup", onPointerUp);
    container.addEventListener("pointercancel", onPointerCancel);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("dragstart", onDragStart);
      container.removeEventListener("dragover", onDragOver);
      container.removeEventListener("drop", onDrop);
      container.removeEventListener("dragend", onDragEnd);
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("pointercancel", onPointerCancel);
      document.removeEventListener("keydown", onKeyDown);
      stopAutoScroll();
    };
  }, [tab]);

  /** 渲染单个订阅源行（分组与排序 tab） */
  function renderFeedRow(feed: Feed): JSX.Element {
    return (
      <li
        key={feed.id}
        data-feed-id={feed.id}
        className="feeds-manage-item organize-row"
        // 初始不可拖：手柄按下时才切到 draggable（见上面的双通道说明）。
        // 常驻 draggable 会让「按下手柄才拖」的语义失效，也会在拖拽被原生拖放接管时出现禁止光标。
        draggable={false}
      >
        <span className="feeds-manage-row-handle material-symbols-rounded" title="按住并上下拖动排序">
          drag_indicator
        </span>
        <span className="feeds-manage-name" title={feed.url}>
          {feed.title || feed.url}
        </span>
        {/* 置顶 / 置底按钮已移除：拖动本来就能落到任意位置（含跨分组），
            档位式移动只是拖拽的退化形式，留在行里只会让控件变挤 */}
        <div className="feeds-manage-controls">
          <select
            className="feeds-manage-group-select"
            value={feed.group_id ?? ""}
            onChange={(e) => onMoveToGroup(feed.id, e.target.value || null)}
            title="切换分组"
          >
            <option value="">未分组</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
          <button
            className="feeds-manage-remove"
            onClick={() => setConfirmDeleteIds([feed.id])}
            title="删除"
          >
            <span className="material-symbols-rounded">delete</span>
          </button>
        </div>
      </li>
    );
  }

  /** 渲染分组区块（分组与排序 tab） */
  function renderGroupBlock(label: string, groupId: string | null, group?: Group): JSX.Element {
    const groupFeeds = getFeedsByGroup(groupId);
    const groupKey = groupId ?? "__ungrouped__";
    const collapsed = collapsedGroups.includes(groupKey);
    return (
      <div key={group?.id ?? "__ungrouped__"} data-group-key={groupKey} className="feed-group">
        <div className="feed-group-header">
          {group && (
            <span
              className="group-drag-handle feeds-manage-row-handle material-symbols-rounded"
              title="按住并上下拖动，调整分组顺序"
            >
              drag_indicator
            </span>
          )}
          {group && editingGroupId === group.id ? (
            <input
              className="group-name-input"
              value={editGroupName}
              onChange={(e) => setEditGroupName(e.target.value)}
              onBlur={confirmRenameGroup}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmRenameGroup();
                if (e.key === "Escape") setEditingGroupId(null);
              }}
              autoFocus
            />
          ) : (
            <span
              className="group-name"
              onDoubleClick={() => group && startEditGroup(group)}
              title={group ? "双击重命名" : undefined}
            >
              {label}
              <span className="feed-count-badge">{groupFeeds.length}</span>
            </span>
          )}
          <div className="group-controls">
            <button
              className="f2-mini-btn group-collapse-btn"
              onClick={() => onToggleGroupCollapsed(groupKey)}
              title={collapsed ? "展开分组" : "折叠分组"}
              aria-expanded={!collapsed}
            >
              <span className="material-symbols-rounded">
                {collapsed ? "expand_more" : "expand_less"}
              </span>
            </button>
            {group && (
              <button
                className="group-remove-btn"
                onClick={() => onRemoveGroup(group.id)}
                title="删除分组（订阅源移至未分组）"
              >
                <span className="material-symbols-rounded">close</span>
              </button>
            )}
          </div>
        </div>
        {/* 上移 / 下移分组按钮已移除：分组标题行的手柄可以直接拖到任意位置 */}
        {!collapsed && (
          <div className="feed-group-body">
            {groupFeeds.length === 0 ? (
              <div className="feeds-group-empty">无订阅源</div>
            ) : (
              <ul className="feeds-manage-list">
                {groupFeeds.map((feed) => renderFeedRow(feed))}
              </ul>
            )}
          </div>
        )}
      </div>
    );
  }

  /** 清理缓存：内存解析缓存 + WebView 磁盘缓存（图片缓存），不动文章数据 */
  const handleClearLocalCache = (): void => {
    const cleared = onClearLocalCache();
    setCleanupNotice(cleared > 0 ? `已清理 ${cleared} 条解析缓存` : "解析缓存已经是空的");
    window.setTimeout(() => setCleanupNotice(null), 4000);
  };

  // 网络 tab：代理配置校验（启用代理时展示错误并禁用测试按钮）
  const proxyHostErr = proxyHostError(proxy.host);
  const proxyPortErr = portDraft.trim() === "" ? "请输入代理端口" : proxyPortError(Number(portDraft));
  const proxyError = proxyHostErr ?? proxyPortErr;
  const proxyValid = proxyError === null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <h2>设置</h2>

        <div className="settings-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`settings-tab ${tab === t.id ? "active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="settings-tab-body">
          {/* ===== 订阅源 ===== */}
          {tab === "feeds" && (
            <div className="feeds-tab">
              {/* 添加 / 导入 */}
              <div className="settings-card">
                <div className="settings-card-header">添加与导入</div>
                <div className="feed-add-row">
                  <input
                    className="f2-text-field feed-url-input"
                    type="url"
                    placeholder="https://example.com/feed.xml"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleAddUrl();
                    }}
                    disabled={addingFeed}
                  />
                  <button
                    className="f2-btn-accent"
                    onClick={() => void handleAddUrl()}
                    disabled={addingFeed || !urlInput.trim()}
                  >
                    {addingFeed ? "添加中…" : "添加"}
                  </button>
                </div>

                {addError && <div className="modal-error" role="alert">{addError}</div>}

                {importProgress && (
                  <div className="import-progress">
                    正在解析 OPML（{importProgress.total} 条）…
                  </div>
                )}

                {importDone && (
                  <div className="import-success">{importDone}</div>
                )}

                {/* OPML 导入导出 */}
                <div className="opml-actions">
                  <button className="f2-btn-soft" onClick={() => void handleImportOpml()}>
                    <span className="material-symbols-rounded">file_upload</span>
                    导入 OPML
                  </button>
                  <button className="f2-btn-outline" onClick={() => void handleExportOpml()}>
                    <span className="material-symbols-rounded">file_download</span>
                    导出 OPML
                  </button>
                </div>
              </div>

              {/* 全量订阅源列表 */}
              <div className="settings-card settings-card--list">
                <div className="settings-card-header feed-flat-header">
                  <div className="feed-flat-header-left">
                    {feeds.length > 0 && (
                      <label className="feed-checkbox select-all" title="全选订阅源">
                        <input
                          type="checkbox"
                          ref={(el) => {
                            if (el) el.indeterminate = someFeedsChecked;
                          }}
                          checked={allFeedsChecked}
                          onChange={toggleAllFeeds}
                        />
                      </label>
                    )}
                    <span className="feed-flat-title">全部订阅源 ({feeds.length})</span>
                  </div>
                  {/* 按名称搜索订阅源 */}
                  <div className="feed-search">
                    <span className="material-symbols-rounded feed-search-icon">search</span>
                    <input
                      className="feed-search-input"
                      type="search"
                      value={feedQuery}
                      onChange={(e) => setFeedQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setFeedQuery("");
                      }}
                      placeholder="搜索名称"
                      aria-label="搜索订阅源名称"
                    />
                    {searchingFeeds && (
                      <button
                        type="button"
                        className="feed-search-clear"
                        onClick={() => setFeedQuery("")}
                        title="清空搜索"
                        aria-label="清空搜索"
                      >
                        <span className="material-symbols-rounded">close</span>
                      </button>
                    )}
                  </div>
                  {/* 排序方式：按添加时间（点它切换正序/倒序）/ 按分组 */}
                  <div className="feed-sort-toggle" role="group" aria-label="排序方式">
                    <button
                      type="button"
                      className={`feed-sort-btn ${feedSortMode === "added" ? "active" : ""}`}
                      onClick={() => {
                        // 不在「按添加时间」时先切过来；已经在时切换方向
                        if (feedSortMode !== "added") changeFeedSortMode("added");
                        else toggleFeedSortDirection();
                      }}
                      aria-label={
                        feedSortMode !== "added"
                          ? "按添加时间排序，最新添加在前"
                          : feedSortDirection === "desc"
                            ? "按添加时间排序，当前最新在前，点击切换为最早在前"
                            : "按添加时间排序，当前最早在前，点击切换为最新在前"
                      }
                      title={
                        feedSortMode !== "added"
                          ? "按添加时间排序（最新添加在前）"
                          : feedSortDirection === "desc"
                            ? "最新添加在前 · 点击切换为最早在前"
                            : "最早添加在前 · 点击切换为最新在前"
                      }
                    >
                      按添加时间
                      <span className="material-symbols-rounded feed-sort-arrow">
                        {feedSortDirection === "desc" ? "arrow_downward" : "arrow_upward"}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`feed-sort-btn ${feedSortMode === "group" ? "active" : ""}`}
                      onClick={() => changeFeedSortMode("group")}
                      title="按分组排序（分组先后 + 组内顺序）"
                    >
                      按分组
                    </button>
                  </div>
                  {checkedFeedIds.size > 0 && (
                    <div className="feed-check-toolbar">
                      <span className="feed-check-count">已选 {checkedFeedIds.size} 项</span>
                      <button
                        className="f2-btn-outline feed-delete-selected"
                        onClick={handleDeleteChecked}
                      >
                        <span className="material-symbols-rounded">delete</span>
                        删除选中
                      </button>
                    </div>
                  )}
                </div>
                {feeds.length === 0 ? (
                  <div className="feeds-group-empty">还没有订阅源</div>
                ) : visibleFeeds.length === 0 ? (
                  <div className="feeds-group-empty">没有匹配「{feedQuery.trim()}」的订阅源</div>
                ) : (
                  <>
                    <ul className="feeds-manage-list">
                      {visibleFeeds.map((feed) => (
                        <li key={feed.id} className={`feeds-manage-item ${checkedFeedIds.has(feed.id) ? "checked" : ""}`}>
                          <label className="feed-checkbox">
                            <input
                              type="checkbox"
                              checked={checkedFeedIds.has(feed.id)}
                              onChange={() => toggleFeedCheck(feed.id)}
                            />
                          </label>
                          <span className="feeds-manage-name" title={feed.url}>
                            {feed.title || feed.url}
                          </span>
                          <div className="feeds-manage-controls">
                            <span className="feed-group-tag">
                              {groups.find((g) => g.id === feed.group_id)?.name ?? "未分组"}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                    {searchingFeeds && (
                      <div className="feeds-search-hint">
                        匹配 {visibleFeeds.length} / {feeds.length} 个订阅源
                      </div>
                    )}

                    {/* 单选编辑面板 */}
                    {checkedFeedIds.size === 1 && (() => {
                      const feed = feeds.find((f) => checkedFeedIds.has(f.id));
                      if (!feed) return null;
                      return (
                        <div className="feed-edit-panel">
                          <div className="feed-edit-title">编辑订阅源</div>
                          <div className="feed-edit-field">
                            <label>名称</label>
                            <input
                              className="settings-text-input"
                              type="text"
                              value={editTitle}
                              onChange={(e) => setEditTitle(e.target.value)}
                              onBlur={() => {
                                if (editTitle.trim() && editTitle !== feed.title) {
                                  void onUpdateFeed(feed.id, { title: editTitle.trim() });
                                }
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                              }}
                            />
                          </div>
                          <div className="feed-edit-field">
                            <label>URL</label>
                            <input
                              className="settings-text-input"
                              type="url"
                              value={editUrl}
                              onChange={(e) => setEditUrl(e.target.value)}
                              onBlur={() => {
                                if (editUrl.trim() && editUrl !== feed.url && rssService.isValidHttpUrl(editUrl)) {
                                  void onUpdateFeed(feed.id, { url: editUrl.trim() });
                                } else {
                                  setEditUrl(feed.url);
                                }
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                              }}
                            />
                          </div>
                          <div className="feed-edit-field">
                            <label>文章打开方式</label>
                            <select
                              className="settings-select"
                              value={editOpenMethod}
                              onChange={(e) => {
                                const val = e.target.value;
                                setEditOpenMethod(val);
                                void onUpdateFeed(feed.id, {
                                  open_method: val === "external" ? "external" : null,
                                });
                              }}
                            >
                              <option value="internal">内部阅读</option>
                              <option value="external">外部浏览器</option>
                            </select>
                          </div>
                        </div>
                      );
                    })()}
                  </>
                )}
              </div>
            </div>
          )}

          {/* ===== 分组与排序 ===== */}
          {tab === "organize" && (
            <div className="feeds-tab">
              <div className="settings-card">
                <div className="settings-card-header">新建分组</div>
                <div className="feed-add-row">
                  <input
                    className="group-name-input"
                    placeholder="输入分组名称"
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAddGroupClick();
                    }}
                  />
                  <button
                    className="btn-add-group"
                    onClick={handleAddGroupClick}
                    disabled={!newGroupName.trim()}
                  >
                    <span className="material-symbols-rounded">add</span>
                    添加
                  </button>
                </div>
              </div>

              {/* 拖拽排序的监听挂在这个容器上（原生事件，见上方 organizeListRef 说明）。
                  容器本身不参与 keyed 重建：行/分组的顺序由各自的 key 驱动，重建容器会把
                  拖拽过程中的 DOM 状态（拖拽中、落点提示）一起清掉。 */}
              <div ref={organizeListRef}>
                {groups.map((g) => renderGroupBlock(g.name, g.id, g))}

                {/* 未分组放在最后：与「未分组排在所有分组之后」的排序语义一致
                    （src/lib/feedOrder.ts 的 groupRank），也让「把分组拖到未分组区块上 = 排到最后」
                    这个落点规则不会自相矛盾 —— 它就在最下面。 */}
                {renderGroupBlock("未分组", null)}
              </div>
            </div>
          )}

          {/* ===== 外观 ===== */}
          {tab === "appearance" && (
            <div className="appearance-tab">
              <div className="settings-card settings-card--rows">
                <div className="settings-card-header">主题与字号</div>
                <div className="settings-field">
                  <label>界面主题</label>
                  <div className="settings-options">
                    {THEME_OPTIONS.map((opt) => (
                      <label key={opt.value} className="settings-option">
                        <input
                          type="radio"
                          name="theme"
                          value={opt.value}
                          checked={theme === opt.value}
                          onChange={() => onThemeChange(opt.value)}
                        />
                        {opt.label}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="settings-field">
                  <label htmlFor="font-size">阅读字号</label>
                  <input
                    id="font-size"
                    type="range"
                    min="12"
                    max="24"
                    value={fontSize}
                    onChange={(e) => onFontSizeChange(Number(e.target.value))}
                  />
                  <span className="settings-value">{fontSize}px</span>
                </div>
              </div>
            </div>
          )}

          {/* ===== 网络 ===== */}
          {tab === "network" && (
            <div className="network-tab">
              <div className="settings-card settings-card--rows">
                <div className="settings-card-header">代理设置</div>
                <div className="settings-field">
                  <label>HTTP 代理</label>
                  <label className="settings-checkbox">
                    <input
                      type="checkbox"
                      checked={proxy.enabled}
                      onChange={(e) => {
                        onProxyChange({ ...proxy, enabled: e.target.checked });
                        setProxyTestResult(null);
                      }}
                    />
                    启用代理
                  </label>
                </div>
                {proxy.enabled && (
                  <>
                    <div className="settings-field">
                      <label htmlFor="proxy-kind">代理类型</label>
                      <select
                        id="proxy-kind"
                        className="settings-select"
                        value={proxy.kind}
                        onChange={(e) => {
                          onProxyChange({ ...proxy, kind: e.target.value as ProxyPrefs["kind"] });
                          setProxyTestResult(null);
                        }}
                      >
                        <option value="http">HTTP</option>
                        <option value="socks5">SOCKS5</option>
                      </select>
                    </div>
                    <div className="settings-field">
                      <label htmlFor="proxy-host">代理主机</label>
                      <input
                        id="proxy-host"
                        className="settings-text-input"
                        type="text"
                        placeholder="127.0.0.1 或 proxy.example.com"
                        value={proxy.host}
                        onChange={(e) =>
                          onProxyChange({ ...proxy, host: e.target.value })
                        }
                        onBlur={handleHostBlur}
                      />
                    </div>
                    <div className="settings-field">
                      <label htmlFor="proxy-port">代理端口</label>
                      <input
                        id="proxy-port"
                        className="settings-text-input"
                        type="text"
                        inputMode="numeric"
                        placeholder="8080"
                        value={portDraft}
                        onChange={(e) => handlePortDraftChange(e.target.value)}
                        onBlur={handlePortDraftBlur}
                      />
                    </div>
                    <div className="settings-field">
                      <label>连接测试</label>
                      <div className="settings-inline">
                        <button
                          className="f2-btn-standard"
                          onClick={() => void handleTestProxy()}
                          disabled={!proxyValid || testingProxy}
                        >
                          {testingProxy ? "测试中…" : "测试连接"}
                        </button>
                        {proxyTestResult && (
                          <span
                            className={
                              proxyTestResult.ok ? "form-text-success" : "form-text-error"
                            }
                          >
                            {proxyTestResult.text}
                          </span>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
              {proxy.enabled && proxyError && (
                <div className="modal-error" role="alert">{proxyError}</div>
              )}
            </div>
          )}

          {/* ===== 通用 ===== */}
          {tab === "general" && (
            <div className="general-tab">
              <div className="settings-card settings-card--rows">
                <div className="settings-card-header">抓取与缓存</div>
                <div className="settings-field">
                  <label htmlFor="refresh-frequency">自动抓取频率</label>
                  <select
                    id="refresh-frequency"
                    className="settings-select"
                    value={refreshFrequency}
                    onChange={(e) =>
                      onRefreshFrequencyChange(e.target.value as RefreshFrequency)
                    }
                  >
                    {FREQUENCY_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="settings-field">
                  <label>缓存</label>
                  <div className="settings-inline">
                    <button className="f2-btn-soft" onClick={handleClearLocalCache}>
                      清理缓存
                    </button>
                  </div>
                </div>
              </div>
              {cleanupNotice && <div className="import-success">{cleanupNotice}</div>}
              <div className="settings-card">
                <div className="settings-card-header">应用数据</div>
                <div className="settings-actions">
                  <button className="f2-btn-outline" onClick={onBackup}>
                    备份
                  </button>
                  <button className="f2-btn-outline" onClick={onRestore}>
                    还原
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ===== 关于 ===== */}
          {tab === "about" && (
            <div className="about-tab">
              <span
                className="material-symbols-rounded"
                style={{ fontSize: "48px", color: "var(--f2-accent-fg)", margin: "0 0 8px" }}
              >
                newspaper
              </span>
              <div className="about-app">RSS Reader</div>
              <div className="about-version-block">
                <div className="about-version-row">
                  <span className="about-version">版本 {pkg.version}</span>
                  <button
                    type="button"
                    className="about-check-btn"
                    disabled={updatePhase === "checking" || updatePhase === "installing"}
                    onClick={() => void handleCheckUpdate()}
                  >
                    <span className="material-symbols-rounded">refresh</span>
                    {updatePhase === "checking" ? "检查中…" : "检查更新"}
                  </button>
                </div>
                {updatePhase === "latest" && (
                  <div className="about-update-hint">
                    <span className="material-symbols-rounded update-icon-accent">check_circle</span>
                    已是最新版本
                  </div>
                )}
                {updatePhase === "error" && (
                  <div className="about-update-hint about-update-hint-error">
                    <span className="material-symbols-rounded">error</span>
                    <span>检查更新失败：{updateError}</span>
                  </div>
                )}
              </div>
              <div className="about-version" style={{ marginTop: "8px" }}>
                Tauri 2 + React + Fluent 2
              </div>

              {/* 反馈入口：点击由全局链接守卫接管，改用系统浏览器打开 */}
              <div className="about-links">
                <a
                  className="about-link"
                  href="https://github.com/z1HwanG/RSS-Reader/issues"
                  rel="noreferrer"
                >
                  <span className="material-symbols-rounded">open_in_new</span>
                  报告问题（GitHub）
                </a>
                <a
                  className="about-link"
                  href="https://git.z1hwang.cn/Zeehow/RSS-Reader/issues"
                  rel="noreferrer"
                >
                  <span className="material-symbols-rounded">open_in_new</span>
                  报告问题（Forgejo）
                </a>
              </div>

              {/* 有可用更新或正在下载时才显示卡片 */}
              {(updatePhase === "available" || updatePhase === "installing") && (
                <div className="update-card">
                  {updatePhase === "available" && updateInfo ? (
                    <>
                      <div className="update-line">
                        <span className="material-symbols-rounded update-icon-accent">new_releases</span>
                        发现新版本 <strong>v{updateInfo.version}</strong>
                        <span className="update-current">当前 v{updateInfo.currentVersion}</span>
                      </div>
                      {updateInfo.notes && <div className="update-notes">{updateInfo.notes}</div>}
                      <button
                        type="button"
                        className="f2-btn-accent"
                        onClick={() => void handleInstallUpdate()}
                      >
                        <span className="material-symbols-rounded">file_download</span>
                        下载并安装
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="update-line">正在下载更新…</div>
                      <div className="update-progress">
                        <div
                          className={`update-progress-bar${updatePercent === null ? " indeterminate" : ""}`}
                          style={updatePercent !== null ? { width: `${updatePercent}%` } : undefined}
                        />
                      </div>
                      <div className="update-hint">
                        {formatBytes(updateProgress?.downloaded ?? 0)}
                        {updateProgress?.total ? ` / ${formatBytes(updateProgress.total)}` : ""}
                        {updatePercent !== null ? `（${updatePercent}%）` : ""}
                      </div>
                      <div className="update-hint">下载完成后会启动安装程序并重启应用。</div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

      </div>

      {/* 删除确认对话框 */}
      {confirmDeleteIds && (
        <div className="modal-overlay confirm-overlay" onClick={() => setConfirmDeleteIds(null)}>
          <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <span
              className="material-symbols-rounded confirm-icon"
            >
              delete_forever
            </span>
            <h3>确认删除</h3>
            <p className="confirm-text">
              确定要删除 {confirmDeleteIds.length} 个订阅源吗？相关文章也将一并删除，此操作不可撤销。
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="f2-btn-standard"
                onClick={() => setConfirmDeleteIds(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="f2-btn-accent confirm-delete-btn"
                onClick={handleConfirmDelete}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
