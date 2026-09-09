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
}

const STORAGE_KEY = "rss-reader-preferences";

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  fontSize: 14,
  refreshFrequency: "never",
  proxy: { enabled: false, host: "", port: 8080, kind: "http" },
  viewFilter: "all",
  viewSort: "newest",
  viewMode: "compact",
};

/** 清理缓存可选的天数档位 */
export const CLEANUP_DAY_OPTIONS: readonly number[] = [7, 30, 60, 90, 180, 365];

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