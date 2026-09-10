/*
 * 文件名: useMenuPosition.ts
 * 描述: 右键菜单定位 hook —— 菜单挂载后按真实尺寸夹进视口（纯计算见 lib/menuPosition.ts）
 *
 * 为什么用 hook 而不是在 onContextMenu 里直接减：
 * 菜单尺寸由内容决定（订阅源菜单 4 项、文章菜单 5 项，还带分隔线），
 * 光标坐标处的菜单在挂载前量不到尺寸；写死估算值遇到新条目就会漏。
 * 用 useLayoutEffect 在绘制前收敛，用户看不到跳动。
 */
import { useLayoutEffect, useRef, useState } from "react";
import { clampMenuPosition, type ViewportSize } from "./menuPosition";

export interface MenuAnchor {
  /** 右键点击位置（视口坐标） */
  x: number;
  y: number;
}

export function useMenuPosition<T extends HTMLElement>(
  anchor: MenuAnchor | null,
  topInset = 0,
): { ref: React.RefObject<T>; position: { left: number; top: number } } {
  const ref = useRef<T | null>(null) as React.RefObject<T>;
  const [position, setPosition] = useState({ left: anchor?.x ?? 0, top: anchor?.y ?? 0 });

  useLayoutEffect(() => {
    if (!anchor) return;
    const element = ref.current;
    if (!element) {
      setPosition({ left: anchor.x, top: anchor.y });
      return;
    }
    const rect = element.getBoundingClientRect();
    const viewport: ViewportSize = {
      width: window.innerWidth,
      height: window.innerHeight,
      topInset,
    };
    const clamped = clampMenuPosition(
      anchor,
      { width: rect.width || 0, height: rect.height || 0 },
      viewport,
    );
    setPosition({ left: clamped.x, top: clamped.y });
  }, [anchor, topInset]);

  return { ref, position };
}
