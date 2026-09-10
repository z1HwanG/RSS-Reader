/*
 * 文件名: linkGuard.ts
 * 描述: 全局链接守卫 — 拦截应用内所有 <a> 点击，改用系统默认浏览器打开。
 *       WebView 内整页跳转会让应用 UI（含自定义标题栏）被外部页面覆盖且无法返回，
 *       因此统一 preventDefault：仅放行页内锚点，http(s) 一律外部打开。
 */
import { openUrl } from "@tauri-apps/plugin-opener";

/** 相对链接的基准地址来源：正文容器上的 data-link-base（文章原始链接） */
const BASE_ATTR = "data-link-base";

/** 解析链接目标：相对地址用最近祖先容器上的 data-link-base 作为基准 */
export function resolveAnchorUrl(anchor: HTMLAnchorElement): URL | null {
  const raw = anchor.getAttribute("href") ?? "";
  if (!raw || raw.startsWith("#")) return null;
  const base =
    anchor.closest(`[${BASE_ATTR}]`)?.getAttribute(BASE_ATTR) || window.location.href;
  try {
    return new URL(raw, base);
  } catch {
    return null;
  }
}

/** 安装全局链接守卫（应用启动时调用一次） */
export function installLinkGuard(): void {
  document.addEventListener(
    "click",
    (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as
        | HTMLAnchorElement
        | null;
      if (!anchor) return;

      const raw = anchor.getAttribute("href") ?? "";
      // 页内锚点保持默认行为（滚动到目标元素）
      if (!raw || raw.startsWith("#")) return;

      const url = resolveAnchorUrl(anchor);
      // 无法解析或非 http(s)（mailto: / tel: 等）交给系统默认处理
      if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return;

      // 无论如何都阻止 WebView 整页跳转，避免应用 UI 被覆盖
      event.preventDefault();

      // 应用自身页面不做外部打开（正常情况下不会出现）
      if (url.origin === window.location.origin) return;

      void openUrl(url.toString()).catch(() => {});
    },
    true,
  );

  // 中键点击：阻止 WebView 新开窗口（应用没有多窗口 UI）
  document.addEventListener(
    "auxclick",
    (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 1) return;
      if ((event.target as Element | null)?.closest?.("a[href]")) {
        event.preventDefault();
      }
    },
    true,
  );
}
