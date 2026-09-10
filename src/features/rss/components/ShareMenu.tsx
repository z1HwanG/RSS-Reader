/*
 * 文件名: ShareMenu.tsx
 * 描述: 分享面板 — 阅读视图工具栏与文章列表右键菜单共用的分享入口。
 *       分组提供「复制」（链接 / Markdown / 标题摘要）、「发送」（邮件 / X / 微博）
 *       与「保存为 Markdown 文件」，复制类动作在面板内即时反馈，不弹全局消息。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { clampMenuPosition } from "../../../lib/menuPosition";
import type { Article, Feed } from "../types";
import * as share from "../services/shareService";
import type { AppMessage } from "./TitleBar";

/** 面板锚点：align 说明 left 是面板左边缘（右键菜单）还是右边缘（工具栏按钮） */
export interface ShareAnchor {
  left: number;
  top: number;
  align?: "left" | "right";
}

interface ShareMenuProps {
  article: Article;
  feed: Feed | null;
  anchor: ShareAnchor;
  onClose: () => void;
  onMessage: (type: AppMessage["type"], text: string) => void;
}

interface ShareItem {
  id: share.ShareActionId;
  icon: string;
  title: string;
  desc: string;
  /** 没有原文链接时该项不可用 */
  needsLink?: boolean;
}

const COPY_ITEMS: ShareItem[] = [
  // 图标名避开 subset-icons.mjs 的 NON_ICON_TOKENS（"link" 在里面，会被当成 CSS/HTML 标识符排除）
  { id: "link", icon: "insert_link", title: "复制链接", desc: "纯网址，粘到哪都能打开", needsLink: true },
  { id: "markdown", icon: "data_object", title: "复制为 Markdown", desc: "[标题](链接)，笔记里直接用", needsLink: true },
  { id: "text", icon: "notes", title: "复制标题与摘要", desc: "一段纯文本，直接发聊天窗口" },
];

const SEND_ITEMS: ShareItem[] = [
  { id: "mail", icon: "mail", title: "通过邮件发送", desc: "调用系统默认邮件客户端", needsLink: true },
  { id: "x", icon: "alternate_email", title: "分享到 X", desc: "在浏览器里打开推文编辑框", needsLink: true },
  { id: "weibo", icon: "public", title: "分享到微博", desc: "在浏览器里打开微博分享页", needsLink: true },
];

const FILE_ITEMS: ShareItem[] = [
  { id: "file", icon: "description", title: "保存为 Markdown 文件", desc: "含来源、作者、时间与摘要" },
];

export function ShareMenu({
  article,
  feed,
  anchor,
  onClose,
  onMessage,
}: ShareMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement | null>(null);
  // 面板高度随内容变化（有无摘要、有无链接），先量真实尺寸再收边进视口
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [doneId, setDoneId] = useState<share.ShareActionId | null>(null);
  const hasLink = Boolean(article.link);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    /** 量当前真实尺寸再夹进视口（面板尺寸由内容决定，写死估算值会漏） */
    const place = (): void => {
      // 用 offsetWidth/offsetHeight 而不是 getBoundingClientRect()：
      // 后者把展开动画的 scale 也算进去（实测量到 0.98 倍的尺寸），会让定位偏下、底部顶出视口。
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const cursor =
        anchor.align === "right"
          ? { x: anchor.left - width, y: anchor.top }
          : { x: anchor.left, y: anchor.top };
      const { x, y } = clampMenuPosition(
        cursor,
        { width, height },
        { width: window.innerWidth, height: window.innerHeight },
      );
      setPosition({ left: x, top: y });
    };
    place();
    // 尺寸变化要重新收边：面板首次渲染时图标字体可能还没到位，
    // 「先量到小高度、随后长高」会把底部顶出视口（实测差 10px 出头）。
    const observer = new ResizeObserver(place);
    observer.observe(el);
    // 图标字体就绪同样会改变行高，而字体加载不一定伴随元素尺寸的中间态
    void document.fonts?.ready.then(place).catch(() => {});
    return () => observer.disconnect();
  }, [anchor]);

  // 点击面板外 / 按 Esc 关闭
  useEffect(() => {
    const onPointerDown = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  /** 复制类动作：反馈留在面板内（图标变勾），面板不自动关，方便连续复制几种格式 */
  const copyAndMark = async (id: share.ShareActionId, text: string): Promise<void> => {
    try {
      await share.copyText(text);
      setDoneId(id);
      window.setTimeout(() => setDoneId((cur) => (cur === id ? null : cur)), 1600);
    } catch (err) {
      onMessage("error", `复制失败：${String(err)}`);
    }
  };

  const openExternal = async (promise: Promise<void>, what: string): Promise<void> => {
    onClose();
    try {
      await promise;
    } catch (err) {
      onMessage("error", `${what}失败：${String(err)}`);
    }
  };

  const handleAction = async (id: share.ShareActionId): Promise<void> => {
    switch (id) {
      case "link":
        return copyAndMark(id, share.buildLink(article));
      case "markdown":
        return copyAndMark(id, share.buildMarkdownLink(article));
      case "text":
        return copyAndMark(id, share.buildTextShare(article, feed));
      case "mail":
        return openExternal(share.shareByEmail(article, feed), "打开邮件客户端");
      case "x":
        return openExternal(share.shareToX(article), "打开 X");
      case "weibo":
        return openExternal(share.shareToWeibo(article), "打开微博");
      case "file": {
        onClose();
        try {
          const path = await share.saveAsMarkdownFile(article, feed);
          if (path) onMessage("success", `已保存到 ${path}`);
        } catch (err) {
          onMessage("error", `保存失败：${String(err)}`);
        }
        return;
      }
    }
  };

  const renderItem = (item: ShareItem): JSX.Element => {
    const disabled = Boolean(item.needsLink) && !hasLink;
    const done = doneId === item.id;
    return (
      <button
        key={item.id}
        type="button"
        className="share-item"
        role="menuitem"
        disabled={disabled}
        title={disabled ? "这篇文章没有原文链接" : undefined}
        onClick={() => void handleAction(item.id)}
      >
        <span className="material-symbols-rounded share-item-icon">{item.icon}</span>
        <span className="share-item-text">
          <span className="share-item-title">{item.title}</span>
          <span className="share-item-desc">{item.desc}</span>
        </span>
        {done && (
          <span className="material-symbols-rounded share-item-done">check</span>
        )}
      </button>
    );
  };

  return (
    <div
      ref={menuRef}
      className="share-menu"
      role="menu"
      aria-label="分享文章"
      style={
        position
          ? { left: position.left, top: position.top }
          : { left: 0, top: 0, visibility: "hidden" }
      }
    >
      <div className="share-menu-head">
        <span className="material-symbols-rounded">share</span>
        <span className="share-menu-head-text">{share.shareTitle(article)}</span>
      </div>
      <div className="dropdown-section-title">复制</div>
      {COPY_ITEMS.map(renderItem)}
      <div className="dropdown-divider" />
      <div className="dropdown-section-title">发送</div>
      {SEND_ITEMS.map(renderItem)}
      <div className="dropdown-divider" />
      {FILE_ITEMS.map(renderItem)}
    </div>
  );
}
