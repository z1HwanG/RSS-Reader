/*
 * 文件名: FeedList.tsx
 * 描述: Fluent 2 NavigationView 抽屉 — 订阅源列表
 *       顶部为「全部文章 / 收藏」两个跨源入口，其余按分组折叠浏览
 *       （组头显示源数与未读数），无分组时平铺；订阅源行支持右键上下文菜单
 */
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import type { Feed, Group } from "../types";

interface FeedListProps {
  feeds: Feed[];
  /** 分组列表（按用户排序）。为空时退化为平铺列表 */
  groups: Group[];
  selectedFeedId: string | null;
  unreadCounts: Record<string, number>;
  /** 收藏文章总数（跨订阅源） */
  starredCount: number;
  /** 当前是否处于「收藏」视图 */
  starredActive: boolean;
  /** 选中「全部文章」（同时重置筛选条件） */
  onSelectAll: () => void;
  /** 选中「收藏」视图（跨订阅源查看星标文章） */
  onSelectStarred: () => void;
  onSelect: (feedId: string | null) => void;
  /** 右键菜单：标记该源所有文章已读 */
  onMarkFeedRead: (feedId: string) => void;
  /** 右键菜单：刷新该源 */
  onRefreshFeed: (feedId: string) => void;
  /** 右键菜单：管理订阅源（打开设置） */
  onManageFeeds: () => void;
}

interface ContextMenuState {
  feedId: string;
  x: number;
  y: number;
}

/** 一个可折叠的订阅源区块（某个分组或未分组） */
interface FeedSection {
  /** 折叠状态键：分组 id，未分组用固定哨兵值 */
  key: string;
  name: string;
  feeds: Feed[];
  unread: number;
}

const UNGROUPED_KEY = "@ungrouped";

export function FeedList({
  feeds,
  groups,
  selectedFeedId,
  unreadCounts,
  starredCount,
  starredActive,
  onSelectAll,
  onSelectStarred,
  onSelect,
  onMarkFeedRead,
  onRefreshFeed,
  onManageFeeds,
}: FeedListProps): JSX.Element {
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  // 折叠的分组键集合（会话内状态，不持久化）
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());
  const totalUnread = Object.values(unreadCounts).reduce((a, b) => a + b, 0);

  // 按分组组装区块：组内按 sort_order 排序，空分组不显示，未分组排最后
  const sections = useMemo<FeedSection[]>(() => {
    const sorted = [...feeds].sort((a, b) => a.sort_order - b.sort_order);
    const byGroup = new Map<string | null, Feed[]>();
    for (const f of sorted) {
      const arr = byGroup.get(f.group_id);
      if (arr) arr.push(f);
      else byGroup.set(f.group_id, [f]);
    }
    const result: FeedSection[] = [];
    for (const g of groups) {
      const groupFeeds = byGroup.get(g.id);
      if (!groupFeeds || groupFeeds.length === 0) continue;
      result.push({ key: g.id, name: g.name, feeds: groupFeeds, unread: 0 });
    }
    const ungrouped = byGroup.get(null);
    if (ungrouped && ungrouped.length > 0) {
      result.push({ key: UNGROUPED_KEY, name: "未分组", feeds: ungrouped, unread: 0 });
    }
    for (const s of result) {
      s.unread = s.feeds.reduce((acc, f) => acc + (unreadCounts[f.id] ?? 0), 0);
    }
    return result;
  }, [feeds, groups, unreadCounts]);

  const hasGroups = groups.length > 0;

  const toggleGroup = (key: string): void => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // 点击外部关闭右键菜单
  useEffect(() => {
    if (!ctxMenu) return;
    const close = (): void => setCtxMenu(null);
    document.addEventListener("click", close);
    document.addEventListener("contextmenu", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("contextmenu", close);
    };
  }, [ctxMenu]);

  const handleContextMenu = (e: MouseEvent, feedId: string): void => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ feedId, x: e.clientX, y: e.clientY });
  };

  const runAction = (fn: (feedId: string) => void): void => {
    if (ctxMenu) {
      fn(ctxMenu.feedId);
      setCtxMenu(null);
    }
  };

  const renderFeedItem = (feed: Feed, indent: boolean): JSX.Element => (
    <button
      key={feed.id}
      className={`feed-nav-item ${indent ? "indent" : ""} ${
        selectedFeedId === feed.id ? "active" : ""
      }`}
      onClick={() => onSelect(feed.id)}
      onContextMenu={(e) => handleContextMenu(e, feed.id)}
      title={feed.title || feed.url}
    >
      <span className="feed-nav-icon">
        <span className="material-symbols-rounded">rss_feed</span>
      </span>
      <span className="feed-nav-label">{feed.title || feed.url}</span>
      {(unreadCounts[feed.id] ?? 0) > 0 && (
        <span className="f2-badge">{unreadCounts[feed.id]}</span>
      )}
    </button>
  );

  return (
    <aside className="feed-list">
      <div className="feed-drawer-header">
        <h1>订阅源</h1>
      </div>

      <nav className="feed-nav">
        {/* 全部文章 */}
        <button
          className={`feed-nav-item ${selectedFeedId === null && !starredActive ? "active" : ""}`}
          onClick={onSelectAll}
        >
          <span className="feed-nav-icon">
            <span className="material-symbols-rounded">article</span>
          </span>
          <span className="feed-nav-label">全部文章</span>
          {totalUnread > 0 && <span className="f2-badge">{totalUnread}</span>}
        </button>

        {/* 收藏（跨订阅源的星标文章） */}
        <button
          className={`feed-nav-item ${starredActive ? "active" : ""}`}
          onClick={onSelectStarred}
          title="查看所有收藏的文章"
        >
          <span className="feed-nav-icon">
            <span className={`material-symbols-rounded ${starredActive ? "filled" : ""}`}>
              star
            </span>
          </span>
          <span className="feed-nav-label">收藏</span>
          {starredCount > 0 && (
            <span className="f2-badge f2-badge-star">{starredCount}</span>
          )}
        </button>

        {!hasGroups
          ? feeds.map((feed) => renderFeedItem(feed, false))
          : sections.map((section) => {
              const isCollapsed = collapsedKeys.has(section.key);
              return (
                <div key={section.key} className="feed-section">
                  <div
                    className="feed-group-header"
                    onClick={() => toggleGroup(section.key)}
                    title={isCollapsed ? "展开分组" : "收起分组"}
                  >
                    <span
                      className={`material-symbols-rounded feed-group-chevron ${
                        isCollapsed ? "" : "expanded"
                      }`}
                    >
                      chevron_right
                    </span>
                    <span className="feed-group-name">{section.name}</span>
                    <span className="feed-group-count">{section.feeds.length}</span>
                    {section.unread > 0 && <span className="f2-badge">{section.unread}</span>}
                  </div>
                  {!isCollapsed && section.feeds.map((f) => renderFeedItem(f, true))}
                </div>
              );
            })}
      </nav>

      {/* 右键上下文菜单 */}
      {ctxMenu && (
        <div
          className="feed-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="dropdown-item"
            onClick={() => runAction(onMarkFeedRead)}
          >
            <span className="material-symbols-rounded">done_all</span>
            全部标为已读
          </button>
          <button
            className="dropdown-item"
            onClick={() => runAction(onRefreshFeed)}
          >
            <span className="material-symbols-rounded">refresh</span>
            刷新
          </button>
          <div className="dropdown-divider" />
          <button
            className="dropdown-item"
            onClick={() => {
              onManageFeeds();
              setCtxMenu(null);
            }}
          >
            <span className="material-symbols-rounded">settings</span>
            管理订阅源
          </button>
        </div>
      )}
    </aside>
  );
}
