/*
 * 文件名: selectionChipPosition.ts
 * 描述: 划词翻译的悬浮按钮 / 浮窗定位（纯函数，便于单独验证 —— 与 lib/menuPosition.ts 同一套路）
 *
 * 为什么要单独做：按钮与浮窗都是 `position: fixed` 且尺寸由内容决定，只能先渲染再量。
 * 之前把这段逻辑写在组件里并直接用 window 尺寸，出过一次真实的排版事故：
 * 用整个选区的包围盒右端（rect.right）当锚点，多行选区时那个点在**较宽的那一行**上，
 * 再用 transform: translateY(-100%) 把按钮顶上去，结果压住了选区那一行的文字
 * （选中 "Hello!" 后压住同行的 "I've been"）。抽成纯函数后可以直接喂坐标验算。
 *
 * 定位约定（按钮跟在选区末尾右侧）：
 *   - 竖直：与**最后一行**对齐（在该行内垂直居中）；
 *   - 水平：贴在最后一行的右端之后（不是整个包围盒的右端 —— 多行选区时后者会跑到别的行去）；
 *   - 右侧放不下 → 翻到选区左端之前；两侧都放不下 → 夹进视口（保证控件可见优先）。
 *   锚点必须用「最后一行的盒子」，这也是这个模块最难用错的地方，所以由调用方显式传入。
 */
import { MENU_VIEWPORT_MARGIN } from "./menuPosition";

/** 视口里的矩形（选区 / 按钮的真实包围盒） */
export interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/**
 * 选区的两个盒子。
 * 只传包围盒是不够的：多行选区的 bounding.right 是所有行里最靠右的边缘，
 * 而按钮要跟的是「选区结束的那一行」的右端。
 */
export interface SelectionBoxes {
  /** 整个选区的包围盒（用于兜底：翻到选区左端之前） */
  bounding: Rect;
  /** 选区最后一行的盒子（按钮贴它右侧、并在它内部垂直居中） */
  lastLine: Rect;
}

/** 按钮与选区之间、浮窗与按钮之间的间距 */
export const CHIP_GAP = 6;

/** 按钮最终落在选区的哪一侧（浮窗据此决定往哪边对齐，避免又跑出视口） */
export type ChipSide = "right" | "left";

/** 把一段区间夹进视口（尺寸比视口还大时贴住起点，剩余部分由元素自身处理） */
function clampAxis(value: number, size: number, extent: number): number {
  const min = MENU_VIEWPORT_MARGIN;
  const max = Math.max(min, extent - size - MENU_VIEWPORT_MARGIN);
  return Math.min(Math.max(value, min), max);
}

/**
 * 算悬浮按钮的位置：跟在选区最后一行的右端之后，与该行垂直居中。
 * @param sel 选区的包围盒 + 最后一行的盒子（视口坐标）
 * @param chip 按钮真实尺寸
 * @param viewport 视口尺寸
 */
export function placeSelectionChip(
  sel: SelectionBoxes,
  chip: Size,
  viewport: Viewport,
): { left: number; top: number; side: ChipSide } {
  // 竖直：在最后一行内居中（按钮略高于行高时上下均匀溢出，看着仍像贴在这一行上）。
  // 行高由 top/bottom 算 —— Rect 里没有 height 字段，别去取 lastLine.height（那是 undefined，会得到 NaN）
  const lineHeight = sel.lastLine.bottom - sel.lastLine.top;
  const top = sel.lastLine.top + (lineHeight - chip.height) / 2;

  // 水平：优先贴最后一行右端
  const rightSide = sel.lastLine.right + CHIP_GAP;
  const leftSide = sel.bounding.left - chip.width - CHIP_GAP;
  const fitsRight = rightSide + chip.width + MENU_VIEWPORT_MARGIN <= viewport.width;
  const fitsLeft = leftSide >= MENU_VIEWPORT_MARGIN;
  const side: ChipSide = fitsRight || !fitsLeft ? "right" : "left";

  return {
    left: clampAxis(side === "right" ? rightSide : leftSide, chip.width, viewport.width),
    top: clampAxis(top, chip.height, viewport.height),
    side,
  };
}

/**
 * 算浮窗的位置：贴在按钮下方；下方装不下就翻到按钮上方。
 * 水平方向与按钮同侧对齐（按钮在选区右侧时右对齐，避免浮窗又伸出屏幕右边被夹走一大截）。
 * @param button 按钮包围盒（视口坐标）
 * @param panel 浮窗真实尺寸
 * @param viewport 视口尺寸
 */
export function placeSelectionPopup(
  button: Rect,
  panel: Size,
  viewport: Viewport,
  side: ChipSide = "right",
): { left: number; top: number } {
  const below = button.bottom + CHIP_GAP;
  const above = button.top - panel.height - CHIP_GAP;
  const roomBelow = below + panel.height + MENU_VIEWPORT_MARGIN <= viewport.height;
  const top = roomBelow || above < MENU_VIEWPORT_MARGIN ? below : above;
  const aligned = side === "right" ? button.right - panel.width : button.left;
  return {
    left: clampAxis(aligned, panel.width, viewport.width),
    top: clampAxis(top, panel.height, viewport.height),
  };
}
