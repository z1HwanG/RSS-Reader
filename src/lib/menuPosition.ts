/*
 * 文件名: menuPosition.ts
 * 描述: 右键菜单 / 浮层的视口收边（纯函数，便于单独验证）
 *
 * 为什么要单独做：菜单是 `position: fixed` 且尺寸由内容决定，右键点在窗口底部附近时，
 * 直接用光标坐标会把菜单下半部分顶到视口外——表现为「左下角被挡住 / 菜单被切掉」。
 * 以前的写法是拿一个写死的估算高度去减，估算偏小就会漏（订阅源抽屉的右键菜单就没有收边）。
 * 这里改成：菜单渲染出来后量它的真实尺寸，再把它夹在视口内。
 */

/** 菜单与视口边缘之间保留的间距 */
export const MENU_VIEWPORT_MARGIN = 8;

export interface MenuSize {
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
  /** 顶部占位（应用的无边框标题栏覆盖在内容之上，菜单不要钻到它下面） */
  topInset?: number;
}

/**
 * 把菜单夹进视口。
 * @param cursor 右键点击位置（视口坐标）
 * @param menu 菜单实际尺寸
 * @param viewport 视口尺寸（+ 可选顶部占位）
 * @returns 收敛后的 left / top
 */
export function clampMenuPosition(
  cursor: { x: number; y: number },
  menu: MenuSize,
  viewport: ViewportSize,
): { x: number; y: number } {
  const margin = MENU_VIEWPORT_MARGIN;
  const minY = (viewport.topInset ?? 0) + margin;

  // 可放置区域不足时（菜单比视口还高），贴住上边界即可，剩余部分由菜单自身滚动
  const maxX = Math.max(margin, viewport.width - menu.width - margin);
  const maxY = Math.max(minY, viewport.height - menu.height - margin);

  return {
    x: Math.min(Math.max(cursor.x, margin), maxX),
    y: Math.min(Math.max(cursor.y, minY), maxY),
  };
}
