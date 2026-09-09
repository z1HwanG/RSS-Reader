/*
 * 文件名: contextMenuGuard.ts
 * 描述: 屏蔽 WebView 默认右键菜单，但保留文本输入框的系统菜单。
 *       WebView2 / WebKit 会弹出浏览器菜单（Back / Refresh / Save as / Print 等），
 *       这些操作对桌面应用没有意义，还会遮住界面；而输入框里的右键菜单
 *       （粘贴 / 复制 / 全选）是常用操作，应当保留。
 *       应用自身的右键菜单（订阅源 / 文章列表）是 React 渲染的 DOM，由各自组件的
 *       onContextMenu 自行 preventDefault 后弹出，不受本守卫影响。
 */

/**
 * 保留系统右键菜单的元素：文本输入框（含搜索框、订阅源 URL、代理设置等）。
 * 排除 checkbox / radio / range / button / submit —— 这些不是可编辑文本，
 * 右键菜单没有意义，统一走应用内屏蔽。
 */
const EDITABLE_SELECTOR = [
  'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"])',
  "textarea",
  '[contenteditable="true"]',
].join(", ");

/** 安装全局右键菜单守卫（应用启动时调用一次） */
export function installContextMenuGuard(): void {
  // 捕获阶段处理：先于组件逻辑阻止浏览器默认菜单；只 preventDefault 不 stopPropagation，
  // 组件自绘的右键菜单仍会正常弹出。
  document.addEventListener(
    "contextmenu",
    (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      // 文本输入框放行：保留粘贴 / 复制 / 全选菜单
      if (target?.closest?.(EDITABLE_SELECTOR)) return;
      event.preventDefault();
    },
    true,
  );
}
