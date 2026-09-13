/*
 * 文件名: useAnchoredDropdown.ts
 * 描述: 工具栏下拉菜单的视口定位 hook（fixed 定位 + 收边）
 *
 * 为什么不用 absolute：下拉的祖先（阅读区）是滚动容器且 overflow 裁剪，
 * 菜单开在容器边缘时会被切掉。fixed 相对视口定位不受祖先裁剪影响；
 * 渲染后量菜单真实尺寸，先右对齐到触发按钮、越界时向左收，
 * 底部放不下时向上翻 —— 与右键菜单的 clampMenuPosition 同一思路。
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";

const MARGIN = 8;

export function useAnchoredDropdown<TMenu extends HTMLElement>(
  open: boolean,
  rootRef: RefObject<HTMLElement>,
): { menuRef: RefObject<TMenu>; menuStyle: CSSProperties } {
  const menuRef = useRef<TMenu | null>(null) as RefObject<TMenu>;
  // open 后先隐藏渲染一帧，量完尺寸再摆到定位点上（useLayoutEffect 保证绘制前完成，无跳动）
  const [style, setStyle] = useState<CSSProperties>({
    position: "fixed",
    visibility: "hidden",
  });

  useLayoutEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    const menu = menuRef.current;
    if (!root || !menu) return;
    const rect = root.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;

    // 优先右对齐到触发按钮（与原 absolute 行为一致），超出视口左缘时再向右收
    let left = rect.right - width;
    if (left < MARGIN) left = MARGIN;
    if (left + width > window.innerWidth - MARGIN) left = window.innerWidth - width - MARGIN;

    // 默认挂在按钮下方，底部放不下就翻到按钮上方
    let top = rect.bottom + 4;
    if (top + height > window.innerHeight - MARGIN) {
      top = Math.max(MARGIN, rect.top - height - 4);
    }

    setStyle({ position: "fixed", left, top, right: "auto", visibility: "visible" });
  }, [open, rootRef]);

  return { menuRef, menuStyle: style };
}
