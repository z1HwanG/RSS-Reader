/*
 * 文件名: scrollReset.ts
 * 描述: 滚动位置重置 hook —— 切换订阅源 / 文章 / 筛选条件后，让滚动容器回到顶部
 *
 * 为什么需要：同一个滚动容器在 React 里是复用同一个 DOM 节点的（列表项换了一批，
 * 容器本身没换），浏览器会原样保留 scrollTop。于是切换订阅源后仍停在上一批文章的
 * 偏移处、切换文章后正文仍停在上一篇的阅读位置，看起来像「滑动条没跟着切换」。
 */
import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * 滚动容器 ref：`scope` 变化时把容器滚回顶部。
 *
 * - 用 `useLayoutEffect` 而不是 `useEffect`：在浏览器绘制前归零，
 *   避免先闪一帧旧滚动位置的新内容。
 * - 重新挂载（如空状态 ↔ 列表互切）时 effect 重跑，ref 已指向新节点，同样归零。
 * - `scope` 只放「标识当前内容集合」的值（订阅源 / 文章 / 筛选 / 排序 / 搜索词），
 *   不要放文章数组本身：后台刷新追加文章时也归零会打断正在阅读的位置。
 */
export function useResetScrollOnChange<T extends HTMLElement>(
  scope: unknown,
): RefObject<T> {
  const ref = useRef<T | null>(null) as RefObject<T>;

  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
  }, [scope]);

  return ref;
}
