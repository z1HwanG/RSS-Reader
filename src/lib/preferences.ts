/**
 * 应用偏好管理：主题 / 阅读字号 / 自动抓取频率 / 代理
 * 前端偏好属于纯 UI 状态，用 localStorage 持久化（不触碰系统文件）。
 */
import type { ProxyConfig } from "../features/rss/types";

export type ThemePreference = "system" | "light" | "dark";
export type RefreshFrequency = "never" | "10m" | "15m" | "20m" | "30m" | "45m" | "1h";
export type ViewFilter = "all" | "unread" | "starred";
export type ViewSort = "newest" | "oldest" | "feed";
/** 文章列表视图模式：紧凑 / 列表 / 卡片 */
export type ViewMode = "compact" | "list" | "card";

/** 合法的视图模式（用于校验 localStorage 里的历史数据） */
export const VIEW_MODES: readonly ViewMode[] = ["compact", "list", "card"];

/** 代理类型 */
export type ProxyKind = "http" | "socks5";
/** 代理配置 */
export interface ProxyPrefs {
  enabled: boolean;
  host: string;
  port: number;
  /** 代理类型：HTTP 或 SOCKS5 */
  kind: ProxyKind;
}

export interface Preferences {
  theme: ThemePreference;
  fontSize: number;
  refreshFrequency: RefreshFrequency;
  proxy: ProxyPrefs;
  viewFilter: ViewFilter;
  viewSort: ViewSort;
  viewMode: ViewMode;
  /**
   * 左侧栏（订阅源抽屉）里被折叠的分组键：分组 id，未分组用 FeedList 的哨兵值 `@ungrouped`。
   * 折叠状态跟着偏好一起持久化 —— 否则每次开应用都得重新收起一遍。
   */
  sidebarCollapsedGroups: string[];
  /**
   * 设置 →「分组与排序」里被折叠的分组（分组 id；未分组用 `__ungrouped__`）。
   * 与左侧栏**各自独立**：一个是浏览时收起不想看的组，一个是整理时收起已排好的组。
   */
  organizeCollapsedGroups: string[];
}

const STORAGE_KEY = "rss-reader-preferences";

/** localStorage 键名（清理 WebView 缓存会连带清掉它，调用方需要先快照再写回） */
export const PREFERENCES_STORAGE_KEY = STORAGE_KEY;

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  fontSize: 14,
  refreshFrequency: "never",
  proxy: { enabled: false, host: "", port: 8080, kind: "http" },
  viewFilter: "all",
  viewSort: "newest",
  viewMode: "compact",
  sidebarCollapsedGroups: [],
  organizeCollapsedGroups: [],
};

/** 各档自动抓取频率对应的毫秒数；never 为 null（不自动抓取） */
export const REFRESH_INTERVALS_MS: Record<RefreshFrequency, number | null> = {
  never: null,
  "10m": 10 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "20m": 20 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "45m": 45 * 60 * 1000,
  "1h": 60 * 60 * 1000,
};

/** 读一个字符串数组字段：非数组、混入非字符串都滤掉（这些键只在运行时用来比对） */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** 读取本地偏好，缺失字段用默认值 */
export function loadPreferences(): Preferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      theme: parsed.theme ?? DEFAULT_PREFERENCES.theme,
      fontSize: parsed.fontSize ?? DEFAULT_PREFERENCES.fontSize,
      refreshFrequency: parsed.refreshFrequency ?? DEFAULT_PREFERENCES.refreshFrequency,
      proxy: {
        ...DEFAULT_PREFERENCES.proxy,
        ...parsed.proxy,
        // kind 仅接受白名单值，历史数据缺省为 http
        kind: parsed.proxy?.kind === "socks5" ? "socks5" : "http",
      },
      viewFilter: parsed.viewFilter ?? DEFAULT_PREFERENCES.viewFilter,
      viewSort: parsed.viewSort ?? DEFAULT_PREFERENCES.viewSort,
      viewMode:
        parsed.viewMode && VIEW_MODES.includes(parsed.viewMode)
          ? parsed.viewMode
          : DEFAULT_PREFERENCES.viewMode,
      // 旧数据没有这两个字段；非数组 / 混入非字符串都退回默认（键只在运行时用来比对）
      sidebarCollapsedGroups: stringList(parsed.sidebarCollapsedGroups),
      organizeCollapsedGroups: stringList(parsed.organizeCollapsedGroups),
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/** 保存本地偏好 */
export function savePreferences(prefs: Preferences): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

/** 根据偏好 + 系统偏好解析出实际主题 */
export function resolveTheme(pref: ThemePreference, systemDark: boolean): "light" | "dark" {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}

/** 应用主题到 <html> 的 data-theme 属性 */
export function applyTheme(pref: ThemePreference): void {
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = resolveTheme(pref, systemDark);
  document.documentElement.setAttribute("data-theme", resolved);
}

/** 监听系统主题变化，返回取消监听函数 */
export function listenSystemTheme(handler: () => void): () => void {
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const listener = (): void => handler();
  mql.addEventListener("change", listener);
  return () => mql.removeEventListener("change", listener);
}

/** 将偏好的代理配置转为 Rust ProxyConfig（null = 不启用） */
export function buildProxyArg(prefs: Preferences): ProxyConfig | undefined {
  if (!prefs.proxy.enabled || !prefs.proxy.host) return undefined;
  return { enabled: true, host: prefs.proxy.host, port: prefs.proxy.port, kind: prefs.proxy.kind };
}

/**
 * 将代理配置转为 URL 字符串（供 updater 插件等需要 URL 的场景使用）。
 * 未启用或未填主机时返回 undefined，交给系统代理。
 */
export function buildProxyUrl(proxy: ProxyPrefs): string | undefined {
  if (!proxy.enabled || !proxy.host) return undefined;
  // SOCKS5 走 socks5h：域名交给代理解析，规避本地 DNS 污染
  const scheme = proxy.kind === "socks5" ? "socks5h" : "http";
  return `${scheme}://${proxy.host}:${proxy.port}`;
}