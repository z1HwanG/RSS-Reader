/*
 * 文件名: SelectionTranslate.tsx
 * 描述: 划词翻译 — 在阅读视图正文里选中一段文本后，选区下方出现悬浮「翻译」按钮，
 *       点击弹出浮窗对照显示「原文 + 译文」。复用 translateService 的 Provider 网关与语言配置。
 *
 * 交互：
 *   1. mouseup 时检查正文选区（.article-view-content 内、文本非空）；
 *   2. 在选区**最后一行的右端之后**显示悬浮「翻译」按钮（与此行垂直居中；右侧放不下就翻到选区左侧）；
 *   3. 点按钮 → 调 translateSelection 翻译 → 浮窗展示（正在翻译 / 译文 / 失败三态）；
 *   4. 点击页面其它处 / 按 Esc / 滚动正文时收起。
 *
 * 锚点必须是「选区最后一行的盒子」而不是整个选区的包围盒：
 *   多行选区时包围盒的右端落在**最宽的那一行**上，拿它当锚点按钮会跑到别的行去
 *   （早期版本正是这么写的，加上 translateY(-100%) 还压住了选区那一行的文字）。
 *   定位算法抽在 lib/selectionChipPosition.ts（纯函数），这里只负责量真实尺寸后调用它。
 *   注意：正因为位置靠内联 left/top，按钮/浮窗的 CSS 里不能再带 transform ——
 *   入场动画的 transform 关键帧会把它覆盖掉。
 *
 * 为什么不放选区内（.article-view-content 的 React 合成事件）：
 *   正文是 dangerouslySetInnerHTML 注入的，内部节点上的 React 合成事件实测走不到，
 *   与右键菜单/链接守卫同一套路，用 document 上的原生监听器 + 判断 target 是否在容器内。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { translateSelection } from "../services/translateService";
import {
  placeSelectionChip,
  placeSelectionPopup,
  type ChipSide,
  type Rect,
  type SelectionBoxes,
} from "../../../lib/selectionChipPosition";

interface SelectionTranslateProps {
  /** 正文容器（选区必须落在它内部才触发） */
  containerRef: React.RefObject<HTMLElement | null>;
  /** 附加给翻译请求的上下文（例如当前文章标题），帮助模型理解这是文中的一段 */
  context?: string;
}

type PopupState =
  | { status: "loading" }
  | { status: "done"; text: string }
  | { status: "error"; message: string };

/** 划词上限：整篇长文被误选中（Ctrl/Cmd+A 之类）不该弹翻译 */
const MAX_SELECTION_CHARS = 2000;

/** 当前视口尺寸（定位函数是纯函数，视口由调用方传入） */
function viewport(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

export function SelectionTranslate({ containerRef, context }: SelectionTranslateProps): JSX.Element {
  const [selBoxes, setSelBoxes] = useState<SelectionBoxes | null>(null);
  const [chipSide, setChipSide] = useState<ChipSide>("right");
  const [sourceText, setSourceText] = useState("");
  const [popup, setPopup] = useState<PopupState | null>(null);
  const [popupAnchor, setPopupAnchor] = useState<Rect | null>(null);
  const [btnPos, setBtnPos] = useState({ left: 0, top: 0 });
  const [popupPos, setPopupPos] = useState({ left: 0, top: 0 });
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);

  const closeAll = (): void => {
    setSelBoxes(null);
    setPopup(null);
    setPopupAnchor(null);
    setSourceText("");
  };

  /** 取当前正文内的选区；不在正文内 / 空选区 / 超长都返回 null */
  const readSelection = (): { text: string; boxes: SelectionBoxes } | null => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const text = sel.toString().replace(/\s+/g, " ").trim();
    if (!text) return null;
    const container = containerRef.current;
    if (!container) return null;
    const range = sel.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return null;
    if (text.length > MAX_SELECTION_CHARS) return null;
    const toRect = (r: DOMRect): Rect => ({
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
    });
    const bounding = toRect(range.getBoundingClientRect());
    // 按钮要跟的是「选区结束的那一行」：getClientRects 按行返回，
    // 取最后一个**有宽度**的（选区末尾带换行时会多出一个零宽矩形，别拿它当锚点）
    const lines = Array.from(range.getClientRects()).filter((r) => r.width > 0);
    const lastLine = lines.length > 0 ? toRect(lines[lines.length - 1]) : bounding;
    return { text, boxes: { bounding, lastLine } };
  };

  // 在正文里松开鼠标 → 记下选区，按钮位置由下面的 layout effect 量出来
  useEffect(() => {
    const onMouseUp = (event: MouseEvent): void => {
      const container = containerRef.current;
      if (!container || !container.contains(event.target as Node)) return;
      // 点到按钮 / 浮窗自己：不重新计算（否则刚点开就把选区状态冲掉）
      if (btnRef.current?.contains(event.target as Node)) return;
      if (popupRef.current?.contains(event.target as Node)) return;
      const found = readSelection();
      if (!found) {
        closeAll();
        return;
      }
      setSourceText(found.text);
      setPopup(null);
      setPopupAnchor(null);
      setSelBoxes(found.boxes);
    };
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 按钮渲染出来后量真实尺寸再定位（绘制前收敛，用户看不到跳动 —— 与 useMenuPosition 同一套路）
  useLayoutEffect(() => {
    const el = btnRef.current;
    if (!selBoxes || !el) return;
    const placed = placeSelectionChip(
      selBoxes,
      { width: el.offsetWidth, height: el.offsetHeight },
      viewport(),
    );
    setBtnPos({ left: placed.left, top: placed.top });
    setChipSide(placed.side);
  }, [selBoxes]);

  // 浮窗同理：内容变成译文后尺寸会变，每次状态变化都重新收边
  useLayoutEffect(() => {
    const el = popupRef.current;
    if (!popup || !popupAnchor || !el) return;
    setPopupPos(
      placeSelectionPopup(
        popupAnchor,
        { width: el.offsetWidth, height: el.offsetHeight },
        viewport(),
        chipSide,
      ),
    );
  }, [popup, popupAnchor, chipSide]);

  const handleButtonClick = async (): Promise<void> => {
    const r = btnRef.current?.getBoundingClientRect();
    setPopupAnchor(
      r
        ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
        : { left: btnPos.left, right: btnPos.left, top: btnPos.top, bottom: btnPos.top },
    );
    setPopup({ status: "loading" });
    setSelBoxes(null); // 收起点选按钮，浮窗留在原处展示
    try {
      // 流式：译文边生成边显示在浮窗里（partial），完成后再落成最终结果
      const translated = await translateSelection(sourceText, context, (partial) => {
        setPopup({ status: "done", text: partial });
      });
      setPopup({ status: "done", text: translated });
    } catch (err) {
      setPopup({ status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  // 浮窗打开期间：点击页面其它处 / 按 Esc 收起
  useEffect(() => {
    if (!popup) return;
    const onDocDown = (event: MouseEvent): void => {
      if (popupRef.current?.contains(event.target as Node)) return;
      closeAll();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeAll();
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popup]);

  // 正文滚动 / 改窗口大小时位置会失真：直接收起（浮窗自身的滚动不算）
  useEffect(() => {
    if (!selBoxes && !popup) return;
    const onScroll = (event: Event): void => {
      if (popupRef.current?.contains(event.target as Node)) return;
      closeAll();
    };
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selBoxes, popup]);

  return (
    <>
      {selBoxes && (
        <button
          ref={btnRef}
          type="button"
          className="sel-translate-btn"
          style={{ left: btnPos.left, top: btnPos.top }}
          onClick={() => void handleButtonClick()}
          title="翻译选中的文本"
        >
          <span className="material-symbols-rounded">translate</span>
          翻译
        </button>
      )}
      {popup && (
        <div
          ref={popupRef}
          className="sel-translate-popup"
          style={{ left: popupPos.left, top: popupPos.top }}
        >
          <div className="sel-translate-source">{sourceText}</div>
          {popup.status === "loading" && (
            <div className="sel-translate-state sel-translate-loading">
              <span className="material-symbols-rounded">progress_activity</span>
              正在翻译…
            </div>
          )}
          {popup.status === "done" && <div className="sel-translate-result">{popup.text}</div>}
          {popup.status === "error" && (
            <div className="sel-translate-state sel-translate-error">
              <span className="material-symbols-rounded">error</span>
              {popup.message}
            </div>
          )}
        </div>
      )}
    </>
  );
}
