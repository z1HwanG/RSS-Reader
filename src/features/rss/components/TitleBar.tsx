/*
 * 文件名: TitleBar.tsx
 * 描述: Fluent 2 顶部标题栏 — 消息 / 视图下拉菜单 + 窗口控制
 */
import { useEffect, useRef, useState } from "react";
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
import type { ViewFilter, ViewMode, ViewSort } from "../../../lib/preferences";

/** 应用通知消息 */
export interface AppMessage {
  id: string;
  type: "info" | "error" | "success";
  text: string;
  time: number;
}

interface TitleBarProps {
  title: string;
  onRefresh: () => void;
  onMarkAllRead: () => void;
  onOpenSettings: () => void;
  refreshing: boolean;
  onToggleDrawer: () => void;
  // 视图
  viewFilter: ViewFilter;
  onViewFilterChange: (filter: ViewFilter) => void;
  viewSort: ViewSort;
  onViewSortChange: (sort: ViewSort) => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  // 搜索
  searchQuery: string;
  onSearchChange: (query: string) => void;
  // 消息
  messages: AppMessage[];
  onClearMessages: () => void;
  stats: { feeds: number; articles: number; unread: number };
}

type MenuKind = "none" | "messages" | "view";

/** 视图模式选项（下拉菜单用） */
const VIEW_MODE_OPTIONS: { value: ViewMode; label: string; icon: string }[] = [
  { value: "card", label: "卡片视图", icon: "grid_view" },
  { value: "list", label: "列表视图", icon: "view_list" },
  { value: "compact", label: "紧凑视图", icon: "reorder" },
];

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return new Date(ts).toLocaleDateString();
}

/** 安全获取窗口句柄：非 Tauri 环境（纯浏览器预览）返回 null，避免渲染期抛错导致白屏 */
function safeGetCurrentWindow(): Window | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export function TitleBar({
  title,
  onRefresh,
  onMarkAllRead,
  onOpenSettings,
  refreshing,
  onToggleDrawer,
  viewFilter,
  onViewFilterChange,
  viewSort,
  onViewSortChange,
  viewMode,
  onViewModeChange,
  searchQuery,
  onSearchChange,
  messages,
  onClearMessages,
  stats,
}: TitleBarProps): JSX.Element {
  const [isMaximized, setIsMaximized] = useState(false);
  const [openMenu, setOpenMenu] = useState<MenuKind>("none");
  // 窗口句柄仅在 Tauri 环境可用；纯浏览器预览（无 __TAURI_INTERNALS__）时为 null，
  // 相关操作退化为 no-op，避免整棵组件树渲染崩溃（白屏）。
  const appWindow = safeGetCurrentWindow();
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // 搜索框本地态：输入即时回显，200ms 后再驱动列表过滤（避免每个字符都全量过滤排序）
  const [searchInput, setSearchInput] = useState(searchQuery);

  // 外部改动（如清空）同步回本地态
  useEffect(() => {
    setSearchInput(searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    if (searchInput === searchQuery) return;
    const timer = window.setTimeout(() => onSearchChange(searchInput), 200);
    return () => window.clearTimeout(timer);
  }, [searchInput, searchQuery, onSearchChange]);

  // Ctrl+F 聚焦搜索框
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!appWindow) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void appWindow.isMaximized().then((v) => {
      if (!cancelled) setIsMaximized(v);
    });

    void appWindow
      .onResized(() => {
        void appWindow?.isMaximized().then((v) => {
          if (!cancelled) setIsMaximized(v);
        });
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [appWindow]);

  // 点击外部关闭下拉
  useEffect(() => {
    if (openMenu === "none") return;
    const handler = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenu("none");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [openMenu]);

  const toggleMenu = (menu: MenuKind): void => {
    setOpenMenu((prev) => (prev === menu ? "none" : menu));
  };

  const handleToggleMaximize = (): void => {
    void appWindow?.toggleMaximize();
  };

  const unreadMessages = messages.length;

  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="topbar-left" data-tauri-drag-region>
        <button
          className="f2-icon-btn"
          onClick={onToggleDrawer}
          title="订阅源"
          aria-label="打开订阅源列表"
        >
          <span className="material-symbols-rounded">menu</span>
        </button>
        <span className="topbar-title" data-tauri-drag-region>
          {title}
        </span>
      </div>

      {/* 搜索 */}
      <div className="topbar-search">
        <span className="material-symbols-rounded">search</span>
        <input
          ref={searchRef}
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setSearchInput("");
              onSearchChange("");
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder="搜索文章标题或内容…"
          aria-label="搜索文章"
        />
        {searchInput && (
          <button
            className="search-clear"
            onClick={() => {
              setSearchInput("");
              onSearchChange("");
              searchRef.current?.focus();
            }}
            title="清空搜索"
            aria-label="清空搜索"
          >
            <span className="material-symbols-rounded">close</span>
          </button>
        )}
      </div>

      <div className="topbar-right" data-tauri-drag-region>
        <div ref={menuRef} className="topbar-toolbar" data-tauri-drag-region>
          {/* 视图 */}
          <div className="toolbar-dropdown">
            <button
              className={`f2-icon-btn ${openMenu === "view" ? "active" : ""}`}
              onClick={() => toggleMenu("view")}
              title="视图"
              aria-label="视图选项"
            >
              <span className="material-symbols-rounded">filter_list</span>
            </button>
            {openMenu === "view" && (
              <div className="dropdown-menu">
                <div className="dropdown-section">
                  <div className="dropdown-section-title">视图</div>
                  {VIEW_MODE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      className={`dropdown-item ${viewMode === opt.value ? "selected" : ""}`}
                      onClick={() => {
                        onViewModeChange(opt.value);
                        setOpenMenu("none");
                      }}
                    >
                      <span className="material-symbols-rounded">
                        {viewMode === opt.value ? "check" : opt.icon}
                      </span>
                      {opt.label}
                    </button>
                  ))}
                </div>
                <div className="dropdown-divider" />
                <div className="dropdown-section">
                  <div className="dropdown-section-title">筛选</div>
                  {([
                    { value: "all", label: "全部文章" },
                    { value: "unread", label: "仅未读文章" },
                    { value: "starred", label: "仅星标文章" },
                  ] as { value: ViewFilter; label: string }[]).map((opt) => (
                    <button
                      key={opt.value}
                      className={`dropdown-item ${viewFilter === opt.value ? "selected" : ""}`}
                      onClick={() => {
                        onViewFilterChange(opt.value);
                        setOpenMenu("none");
                      }}
                    >
                      <span className="material-symbols-rounded">
                        {viewFilter === opt.value ? "radio_button_checked" : "radio_button_unchecked"}
                      </span>
                      {opt.label}
                    </button>
                  ))}
                </div>
                <div className="dropdown-divider" />
                <div className="dropdown-section">
                  <div className="dropdown-section-title">排序</div>
                  {([
                    { value: "newest", label: "最新优先" },
                    { value: "oldest", label: "最旧优先" },
                    { value: "feed", label: "按订阅源" },
                  ] as { value: ViewSort; label: string }[]).map((opt) => (
                    <button
                      key={opt.value}
                      className={`dropdown-item ${viewSort === opt.value ? "selected" : ""}`}
                      onClick={() => {
                        onViewSortChange(opt.value);
                        setOpenMenu("none");
                      }}
                    >
                      <span className="material-symbols-rounded">
                        {viewSort === opt.value ? "radio_button_checked" : "radio_button_unchecked"}
                      </span>
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 消息 */}
          <div className="toolbar-dropdown">
            <button
              className={`f2-icon-btn ${openMenu === "messages" ? "active" : ""}`}
              onClick={() => toggleMenu("messages")}
              title="消息"
              aria-label="消息通知"
            >
              <span className="material-symbols-rounded">notifications</span>
              {unreadMessages > 0 && (
                <span className="topbar-badge">{unreadMessages > 9 ? "9+" : unreadMessages}</span>
              )}
            </button>
            {openMenu === "messages" && (
              <div className="dropdown-menu dropdown-menu-wide">
                {/* 统计 */}
                <div className="dropdown-stats">
                  <div className="dropdown-stat">
                    <span className="stat-value">{stats.feeds}</span>
                    <span className="stat-label">订阅源</span>
                  </div>
                  <div className="dropdown-stat">
                    <span className="stat-value">{stats.articles}</span>
                    <span className="stat-label">文章</span>
                  </div>
                  <div className="dropdown-stat">
                    <span className="stat-value">{stats.unread}</span>
                    <span className="stat-label">未读</span>
                  </div>
                </div>
                <div className="dropdown-divider" />
                {/* 消息列表 */}
                {messages.length === 0 ? (
                  <div className="dropdown-empty">暂无消息</div>
                ) : (
                  <div className="dropdown-msg-list">
                    {messages.map((msg) => (
                      <div key={msg.id} className={`dropdown-msg msg-${msg.type}`}>
                        <span className="material-symbols-rounded msg-icon">
                          {msg.type === "error"
                            ? "error"
                            : msg.type === "success"
                              ? "check_circle"
                              : "info"}
                        </span>
                        <div className="msg-body">
                          <div className="msg-text">{msg.text}</div>
                          <div className="msg-time">{timeAgo(msg.time)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {messages.length > 0 && (
                  <>
                    <div className="dropdown-divider" />
                    <button
                      className="dropdown-item dropdown-clear"
                      onClick={() => {
                        onClearMessages();
                        setOpenMenu("none");
                      }}
                    >
                      <span className="material-symbols-rounded">clear_all</span>
                      清除全部
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {/* 原有按钮 */}
          <button
            className="f2-icon-btn"
            onClick={onMarkAllRead}
            title="全部标为已读"
            aria-label="全部标为已读"
          >
            <span className="material-symbols-rounded">done_all</span>
          </button>
          <button
            className="f2-icon-btn"
            onClick={onRefresh}
            disabled={refreshing}
            title="刷新所有订阅源"
            aria-label="刷新所有订阅源"
          >
            <span
              className="material-symbols-rounded"
              style={{ animation: refreshing ? "spin 1s linear infinite" : "none" }}
            >
              refresh
            </span>
          </button>
          <button
            className="f2-icon-btn"
            onClick={onOpenSettings}
            title="设置"
            aria-label="设置"
          >
            <span className="material-symbols-rounded">settings</span>
          </button>
        </div>

        <div className="topbar-window-controls">
          <button
            className="win-control"
            onClick={() => void appWindow?.minimize()}
            title="最小化"
            aria-label="最小化"
          >
            <span className="material-symbols-rounded">remove</span>
          </button>
          <button
            className="win-control"
            onClick={handleToggleMaximize}
            title={isMaximized ? "还原" : "最大化"}
            aria-label={isMaximized ? "还原" : "最大化"}
          >
            <span className="material-symbols-rounded">
              {isMaximized ? "fullscreen_exit" : "fullscreen"}
            </span>
          </button>
          <button
            className="win-control close"
            onClick={() => void appWindow?.close()}
            title="关闭"
            aria-label="关闭"
          >
            <span className="material-symbols-rounded">close</span>
          </button>
        </div>
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </header>
  );
}
