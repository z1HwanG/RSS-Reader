/*
 * 文件名: contextMenuGuard.ts
 * 描述: 屏蔽 WebView 默认右键菜单。
 *       WebView2 / WebKit 会弹出浏览器菜单（Back / Refresh / Save as / Print 等），
 *       这些操作对桌面应用没有意义，还会遮住界面。
 *       应用自身的右键菜单（订阅源 / 文章列表）是 React 渲染的 DOM，由各自组件的
 *       onContextMenu 自行 preventDefault 后弹出，不受本守卫影响。
 */

/** 安装全局右键菜单守卫（应用启动时调用一次） */
export function installContextMenuGuard(): void {
  // 捕获阶段处理：先于组件逻辑阻止浏览器默认菜单；只 preventDefault 不 stopPropagation，
  // 组件自绘的右键菜单仍会正常弹出。
  document.addEventListener(
    "contextmenu",
    (event: MouseEvent) => {
      event.preventDefault();
    },
    true,
  );
}
