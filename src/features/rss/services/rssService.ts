/**
 * RSS 阅读器服务层：封装所有 Tauri invoke 调用。
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { call } from "../../../lib/tauri";
import type { AppState, FetchResult, ProxyConfig } from "../types";

/** 加载本地持久化状态 */
export function loadState(): Promise<AppState> {
  return call<AppState>("load_state");
}

/** 最近一次已提交写盘的状态引用：用于跳过没有实际变更的重复写入 */
let lastSavedState: AppState | null = null;

/** 保存本地持久化状态 */
export function saveState(state: AppState): Promise<void> {
  lastSavedState = state;
  return call<void>("save_state", { state }).catch((err: unknown) => {
    // 写盘失败：清空标记，允许下次重试
    lastSavedState = null;
    throw err;
  });
}

// ===== 防抖批量落盘 =====
// 高频操作（标记已读 / 收藏 / 排序等）若每次都全量序列化整个 AppState（含全部文章 HTML）
// 并写盘，订阅源一多就会明显卡顿。这里把短时间内的多次变更合并为一次写盘。

let saveTimer: number | null = null;
let pendingSave: AppState | null = null;

/** 防抖保存：delayMs 内的多次调用只触发一次真实写盘（取最新状态） */
export function saveStateDebounced(state: AppState, delayMs = 800): void {
  pendingSave = state;
  if (saveTimer != null) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    const pending = pendingSave;
    pendingSave = null;
    // 引用未变说明没有实际变更（App 侧只在修改时创建新对象），跳过写盘
    if (pending && pending !== lastSavedState) void saveState(pending).catch(() => {});
  }, delayMs);
}

/** 立即落盘挂起的变更（页面隐藏 / 关闭前调用，避免尾部变更丢失） */
export function flushPendingSave(): void {
  if (saveTimer != null) {
    window.clearTimeout(saveTimer);
    saveTimer = null;
  }
  const pending = pendingSave;
  pendingSave = null;
  if (pending && pending !== lastSavedState) void saveState(pending).catch(() => {});
}

/** 抓取一个订阅源并解析；带上 ETag / Last-Modified 走条件请求，304 时直接跳过下载解析 */
export function fetchFeed(
  url: string,
  proxy?: ProxyConfig,
  etag?: string | null,
  lastModified?: string | null,
): Promise<FetchResult> {
  return call<FetchResult>("fetch_feed", { url, proxy, etag, lastModified });
}

/** 抓取文章原文 HTML（用于获取完整正文） */
export function fetchArticleHtml(url: string, proxy?: ProxyConfig): Promise<string> {
  return call<string>("fetch_article_html", { url, proxy });
}

/** 备份：把当前状态写入指定文件（状态由前端传入，后端无需再读一遍磁盘） */
export function backupState(targetPath: string, state: AppState): Promise<void> {
  return call<void>("backup_state", { targetPath, state });
}

/** 还原：从指定文件读取状态并返回 */
export function restoreState(sourcePath: string): Promise<AppState> {
  return call<AppState>("restore_state", { sourcePath });
}

/** 读取文本文件（用于 OPML 导入） */
export function readFileText(sourcePath: string): Promise<string> {
  return call<string>("read_file_text", { sourcePath });
}

/** 写入文本到文件（用于 OPML 导出） */
export function writeFileText(targetPath: string, content: string): Promise<void> {
  return call<void>("write_file_text", { targetPath, content });
}

/** 在系统默认浏览器中打开链接 */
export function openExternal(url: string): Promise<void> {
  return openUrl(url);
}

/** 校验输入是否为合法 URL */
export function isValidHttpUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** 代理连通性测试结果（与 Rust ProxyTestResult 对齐） */
export interface ProxyTestResult {
  /** 往返耗时（毫秒） */
  latency_ms: number;
  /** 成功命中的探测目标 URL */
  target: string;
}

/** 通过指定代理请求探测地址，验证代理可用性（host / port 需已通过前端校验） */
export function testProxy(
  host: string,
  port: number,
  kind: "http" | "socks5",
): Promise<ProxyTestResult> {
  return call<ProxyTestResult>("test_proxy", { host, port, kind });
}

/** 同步代理配置到 Rust 侧（null = 不启用），供本地图片代理协议抓取图片时使用 */
export function updateProxySetting(proxy?: ProxyConfig | null): Promise<void> {
  return call<void>("update_proxy_setting", { proxy: proxy ?? null });
}