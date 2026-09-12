/*
 * 文件名: FeedsSettings.tsx
 * 描述: 设置面板「订阅源」分区：内联添加 URL + OPML 导入导出 + 全量列表（搜索 / 排序 /
 *   批量选中 / 批量清理 / 单选编辑）。删除动作只上报父级（onRequestDelete）弹确认框，
 *   自身不直接删 —— 删源会连带删掉全部文章且不可撤销。
 */
import { useEffect, useMemo, useState } from "react";
import { save as showSaveDialog, open as showOpenDialog } from "@tauri-apps/plugin-dialog";
import type { Article, Feed, Group } from "../../types";
import {
  filterFeedsByName,
  sortFeeds,
  type FeedSortDirection,
  type FeedSortMode,
} from "../../../../lib/feedOrder";
import * as rssService from "../../services/rssService";
import {
  DEFAULT_STALE_DAYS,
  STALE_DAY_OPTIONS,
  failLabel,
  failedFeeds,
  staleFeeds,
} from "../../../../lib/feedHygiene";

/** 「全部订阅源」排序方式 / 方向的本地偏好键（只影响设置面板展示顺序） */
const FEED_SORT_STORAGE_KEY = "rss-reader-feed-sort-mode";
const FEED_SORT_DIRECTION_KEY = "rss-reader-feed-sort-direction";

interface FeedsSettingsProps {
  feeds: Feed[];
  /** 全部文章：只用于「批量清理」判断某个源多久没更新（取每个源最新一篇的时间） */
  articles: Article[];
  groups: Group[];
  /** 内联添加订阅源 URL */
  onAddFeedUrl: (url: string) => Promise<void>;
  /** 批量导入订阅源（仅写入 URL+标题，后台刷新） */
  onBatchImport: (items: { url: string; title?: string }[]) => Promise<void>;
  /** 更新订阅源属性（名称/URL/打开方式） */
  onUpdateFeed: (feedId: string, patch: Partial<Pick<Feed, "title" | "url" | "open_method">>) => Promise<void>;
  /** 请求删除订阅源：父级弹确认框后执行（批量删除同样走这里） */
  onRequestDelete: (feedIds: string[]) => void;
}

// ---- OPML 辅助函数 ----

/**
 * 把 XMLSerializer 的单行输出按层级缩进。
 * 属性值里的尖括号已被序列化器转义，因此 > < 只会作为标签分隔符出现，按此分词是安全的。
 */
function prettyPrintXml(xml: string): string {
  const lines = xml.replace(/(>)(<)(\/*)/g, "$1\n$2$3").split("\n");
  let depth = 0;
  const out = lines.map((line) => {
    const isDeclaration = /^<[?!]/.test(line);
    const isClosing = /^<\//.test(line);
    const isSelfClosing = /\/>$/.test(line);
    // 同一行内完成开闭的元素（如 <title>x</title>）不改变层级
    const isInline = /^<[^>]+>.*<\/[^>]+>$/.test(line);
    if (isClosing) depth = Math.max(0, depth - 1);
    const indented = "  ".repeat(depth) + line;
    if (!isClosing && !isSelfClosing && !isDeclaration && !isInline) depth += 1;
    return indented;
  });
  return out.join("\n") + "\n";
}

/** 解析 OPML XML，提取所有订阅源 URL */
function parseOpml(xml: string): { url: string; title: string }[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const result: { url: string; title: string }[] = [];
  const outlines = doc.querySelectorAll("outline[xmlUrl]");
  outlines.forEach((el) => {
    const url = el.getAttribute("xmlUrl") || "";
    const title = el.getAttribute("text") || el.getAttribute("title") || url;
    if (url) result.push({ url, title });
  });
  return result;
}

/** 从订阅源列表生成 OPML XML */
function generateOpml(feeds: Feed[], groups: Group[]): string {
  const doc = document.implementation.createDocument(null, "opml", null);
  doc.documentElement.setAttribute("version", "2.0");
  const head = doc.createElement("head");
  const title = doc.createElement("title");
  title.textContent = "RSS Reader Subscriptions";
  head.appendChild(title);
  doc.documentElement.appendChild(head);
  const body = doc.createElement("body");

  const makeOutline = (feed: Feed): Element => {
    const el = doc.createElement("outline");
    el.setAttribute("type", "rss");
    el.setAttribute("text", feed.title || feed.url);
    el.setAttribute("title", feed.title || feed.url);
    el.setAttribute("xmlUrl", feed.url);
    if (feed.site_url) el.setAttribute("htmlUrl", feed.site_url);
    return el;
  };

  // 未分组
  for (const f of feeds.filter((f) => !f.group_id)) {
    body.appendChild(makeOutline(f));
  }
  // 分组
  for (const g of groups) {
    const groupFeeds = feeds.filter((f) => f.group_id === g.id);
    if (groupFeeds.length === 0) continue;
    const gEl = doc.createElement("outline");
    gEl.setAttribute("text", g.name);
    gEl.setAttribute("title", g.name);
    for (const f of groupFeeds) gEl.appendChild(makeOutline(f));
    body.appendChild(gEl);
  }

  doc.documentElement.appendChild(body);
  // XMLSerializer 输出为单行，这里缩进排版，便于阅读与版本对比
  return prettyPrintXml(
    `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(doc)}`,
  );
}

export function FeedsSettings({
  feeds,
  articles,
  groups,
  onAddFeedUrl,
  onBatchImport,
  onUpdateFeed,
  onRequestDelete,
}: FeedsSettingsProps): JSX.Element {
  const [urlInput, setUrlInput] = useState("");
  const [addingFeed, setAddingFeed] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [importDone, setImportDone] = useState<string | null>(null);
  // 选框 + 编辑面板
  const [checkedFeedIds, setCheckedFeedIds] = useState<Set<string>>(new Set());
  const [editTitle, setEditTitle] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editOpenMethod, setEditOpenMethod] = useState<string>("internal");
  /** 「长期不更新」的天数档位（只影响批量清理的判定，不落盘） */
  const [staleDays, setStaleDays] = useState<number>(DEFAULT_STALE_DAYS);
  /** 批量清理用：连续失败的源 / 长期不更新的源（按条件一键选中，再走删除确认） */
  const failedList = useMemo(() => failedFeeds(feeds), [feeds]);
  const staleList = useMemo(
    () => staleFeeds(feeds, articles, staleDays),
    [feeds, articles, staleDays],
  );

  /**
   * 「全部订阅源」列表的排序方式：按添加时间 / 按分组。
   * 只影响设置面板的展示顺序，不改动订阅源本身（真正的顺序由分组 + 组内 sort_order 决定）。
   * 「按添加时间」还有一个方向：最新在前（默认）/ 最早在前，点箭头切换。
   */
  const [feedSortMode, setFeedSortMode] = useState<FeedSortMode>(
    () => (window.localStorage.getItem(FEED_SORT_STORAGE_KEY) as FeedSortMode | null) ?? "added",
  );
  const [feedSortDirection, setFeedSortDirection] = useState<FeedSortDirection>(() =>
    window.localStorage.getItem(FEED_SORT_DIRECTION_KEY) === "asc" ? "asc" : "desc",
  );
  const changeFeedSortMode = (mode: FeedSortMode): void => {
    setFeedSortMode(mode);
    window.localStorage.setItem(FEED_SORT_STORAGE_KEY, mode);
  };
  const toggleFeedSortDirection = (): void => {
    setFeedSortDirection((prev) => {
      const next: FeedSortDirection = prev === "desc" ? "asc" : "desc";
      window.localStorage.setItem(FEED_SORT_DIRECTION_KEY, next);
      return next;
    });
  };
  // 直接计算（不用 useMemo）：订阅源只有几十个，排序开销可忽略；
  // 避免任何缓存让「列表顺序」在排序操作后仍是旧值。
  const sortedFeeds = sortFeeds(feeds, groups, feedSortMode, feedSortDirection);
  /** 「全部订阅源」的名称搜索（会话内状态，不持久化） */
  const [feedQuery, setFeedQuery] = useState("");
  const visibleFeeds = filterFeedsByName(sortedFeeds, feedQuery);
  const searchingFeeds = feedQuery.trim().length > 0;

  // 选框切换
  const toggleFeedCheck = (feedId: string): void => {
    setCheckedFeedIds((prev) => {
      const next = new Set(prev);
      if (next.has(feedId)) next.delete(feedId);
      else next.add(feedId);
      return next;
    });
  };

  // 全选/取消全选
  // 注意：以「当前可见（可能被搜索过滤）的订阅源」为准，避免搜索时全选到看不见的源。
  const allFeedIds = new Set(visibleFeeds.map((f) => f.id));
  const allFeedsChecked = checkedFeedIds.size > 0 && checkedFeedIds.size === allFeedIds.size;
  const someFeedsChecked = checkedFeedIds.size > 0 && !allFeedsChecked;

  const toggleAllFeeds = (): void => {
    if (allFeedsChecked) {
      setCheckedFeedIds(new Set());
    } else {
      setCheckedFeedIds(new Set(allFeedIds));
    }
  };

  const handleDeleteChecked = (): void => {
    onRequestDelete([...checkedFeedIds]);
  };

  // 选中单个订阅源时，同步编辑面板字段
  useEffect(() => {
    if (checkedFeedIds.size === 1) {
      const feed = feeds.find((f) => checkedFeedIds.has(f.id));
      if (feed) {
        setEditTitle(feed.title);
        setEditUrl(feed.url);
        setEditOpenMethod(feed.open_method ?? "internal");
      }
    }
  }, [checkedFeedIds, feeds]);

  // ---- 操作 ----

  const handleAddUrl = async (): Promise<void> => {
    const url = urlInput.trim();
    if (!url) return;
    if (!rssService.isValidHttpUrl(url)) {
      setAddError("请输入合法的 http:// 或 https:// URL");
      return;
    }
    setAddingFeed(true);
    setAddError(null);
    try {
      await onAddFeedUrl(url);
      setUrlInput("");
    } catch (err) {
      setAddError(String(err));
    } finally {
      setAddingFeed(false);
    }
  };

  const handleImportOpml = async (): Promise<void> => {
    try {
      const filePath = await showOpenDialog({
        filters: [{ name: "OPML / XML", extensions: ["opml", "xml"] }],
        multiple: false,
      });
      if (!filePath) return;

      const content = await rssService.readFileText(filePath);
      const items = parseOpml(content);
      if (items.length === 0) {
        setAddError("未在 OPML 文件中找到订阅源");
        return;
      }

      setImportProgress({ done: 0, total: items.length });
      await onBatchImport(items);
      setImportProgress(null);
      setImportDone(`已导入 ${items.length} 条订阅源，正在后台刷新…`);
      setTimeout(() => setImportDone(null), 5000);
    } catch (err) {
      setAddError(`OPML 导入失败: ${String(err)}`);
      setImportProgress(null);
    }
  };

  const handleExportOpml = async (): Promise<void> => {
    try {
      const filePath = await showSaveDialog({
        defaultPath: `rss-reader-${new Date().toISOString().slice(0, 10)}.opml`,
        filters: [{ name: "OPML", extensions: ["opml"] }],
      });
      if (!filePath) return;
      const content = generateOpml(feeds, groups);
      await rssService.writeFileText(filePath, content);
    } catch (err) {
      setAddError(`OPML 导出失败: ${String(err)}`);
    }
  };

  return (
    <div className="feeds-tab">
      {/* 添加 / 导入 */}
      <div className="settings-card">
        <div className="settings-card-header">添加与导入</div>
        <div className="feed-add-row">
          <input
            className="f2-text-field feed-url-input"
            type="url"
            placeholder="https://example.com/feed.xml"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAddUrl();
            }}
            disabled={addingFeed}
          />
          <button
            className="f2-btn-accent"
            onClick={() => void handleAddUrl()}
            disabled={addingFeed || !urlInput.trim()}
          >
            {addingFeed ? "添加中…" : "添加"}
          </button>
        </div>

        {addError && <div className="modal-error" role="alert">{addError}</div>}

        {importProgress && (
          <div className="import-progress">
            正在解析 OPML（{importProgress.total} 条）…
          </div>
        )}

        {importDone && (
          <div className="import-success">{importDone}</div>
        )}

        {/* OPML 导入导出 */}
        <div className="opml-actions">
          <button className="f2-btn-soft" onClick={() => void handleImportOpml()}>
            <span className="material-symbols-rounded">file_upload</span>
            导入 OPML
          </button>
          <button className="f2-btn-outline" onClick={() => void handleExportOpml()}>
            <span className="material-symbols-rounded">file_download</span>
            导出 OPML
          </button>
        </div>
      </div>

      {/* 全量订阅源列表 */}
      <div className="settings-card settings-card--list">
        <div className="settings-card-header feed-flat-header">
          <div className="feed-flat-header-left">
            {feeds.length > 0 && (
              <label className="feed-checkbox select-all" title="全选订阅源">
                <input
                  type="checkbox"
                  ref={(el) => {
                    if (el) el.indeterminate = someFeedsChecked;
                  }}
                  checked={allFeedsChecked}
                  onChange={toggleAllFeeds}
                />
              </label>
            )}
            <span className="feed-flat-title">全部订阅源 ({feeds.length})</span>
          </div>
          {/* 按名称搜索订阅源 */}
          <div className="feed-search">
            <span className="material-symbols-rounded feed-search-icon">search</span>
            <input
              className="feed-search-input"
              type="search"
              value={feedQuery}
              onChange={(e) => setFeedQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setFeedQuery("");
              }}
              placeholder="搜索名称"
              aria-label="搜索订阅源名称"
            />
            {searchingFeeds && (
              <button
                type="button"
                className="feed-search-clear"
                onClick={() => setFeedQuery("")}
                title="清空搜索"
                aria-label="清空搜索"
              >
                <span className="material-symbols-rounded">close</span>
              </button>
            )}
          </div>
          {/* 排序方式：按添加时间（点它切换正序/倒序）/ 按分组 */}
          <div className="feed-sort-toggle" role="group" aria-label="排序方式">
            <button
              type="button"
              className={`feed-sort-btn ${feedSortMode === "added" ? "active" : ""}`}
              onClick={() => {
                // 不在「按添加时间」时先切过来；已经在时切换方向
                if (feedSortMode !== "added") changeFeedSortMode("added");
                else toggleFeedSortDirection();
              }}
              aria-label={
                feedSortMode !== "added"
                  ? "按添加时间排序，最新添加在前"
                  : feedSortDirection === "desc"
                    ? "按添加时间排序，当前最新在前，点击切换为最早在前"
                    : "按添加时间排序，当前最早在前，点击切换为最新在前"
              }
              title={
                feedSortMode !== "added"
                  ? "按添加时间排序（最新添加在前）"
                  : feedSortDirection === "desc"
                    ? "最新添加在前 · 点击切换为最早在前"
                    : "最早添加在前 · 点击切换为最新在前"
              }
            >
              按添加时间
              <span className="material-symbols-rounded feed-sort-arrow">
                {feedSortDirection === "desc" ? "arrow_downward" : "arrow_upward"}
              </span>
            </button>
            <button
              type="button"
              className={`feed-sort-btn ${feedSortMode === "group" ? "active" : ""}`}
              onClick={() => changeFeedSortMode("group")}
              title="按分组排序（分组先后 + 组内顺序）"
            >
              按分组
            </button>
          </div>
          {checkedFeedIds.size > 0 && (
            <div className="feed-check-toolbar">
              <span className="feed-check-count">已选 {checkedFeedIds.size} 项</span>
              <button
                className="f2-btn-outline feed-delete-selected"
                onClick={handleDeleteChecked}
              >
                <span className="material-symbols-rounded">delete</span>
                删除选中
              </button>
            </div>
          )}
        </div>
        {/* 批量清理：按条件一键选中，再走上面的「删除选中」确认流程。
            不直接删 —— 删源会连带删掉该源的全部文章且不可撤销，中间留一道确认。 */}
        {feeds.length > 0 && (
          <div className="feed-hygiene">
            <button
              type="button"
              className="f2-btn-soft feed-hygiene-btn"
              disabled={failedList.length === 0}
              onClick={() => setCheckedFeedIds(new Set(failedList.map((f) => f.id)))}
              title="最近一次刷新失败的订阅源。单次失败也可能是网络抖动——列表里会标出连续失败次数，请按提示复核后再删"
            >
              更新失败{failedList.length > 0 ? ` ${failedList.length}` : ""}
            </button>
            <button
              type="button"
              className="f2-btn-soft feed-hygiene-btn"
              disabled={staleList.length === 0}
              onClick={() => setCheckedFeedIds(new Set(staleList.map((f) => f.id)))}
              title="以该源最新一篇文章的时间为准；还没抓到过文章的源按订阅时间算"
            >
              未更新{staleList.length > 0 ? ` ${staleList.length}` : ""}
            </button>
            <select
              className="settings-select feed-hygiene-days"
              value={staleDays}
              onChange={(e) => setStaleDays(Number(e.target.value))}
              title="「未更新」的天数门槛"
            >
              {STALE_DAY_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d} 天
                </option>
              ))}
            </select>
          </div>
        )}
        {feeds.length === 0 ? (
          <div className="feeds-group-empty">还没有订阅源</div>
        ) : visibleFeeds.length === 0 ? (
          <div className="feeds-group-empty">没有匹配「{feedQuery.trim()}」的订阅源</div>
        ) : (
          <>
            <ul className="feeds-manage-list">
              {visibleFeeds.map((feed) => (
                <li key={feed.id} className={`feeds-manage-item ${checkedFeedIds.has(feed.id) ? "checked" : ""}`}>
                  <label className="feed-checkbox">
                    <input
                      type="checkbox"
                      checked={checkedFeedIds.has(feed.id)}
                      onChange={() => toggleFeedCheck(feed.id)}
                    />
                  </label>
                  <span className="feeds-manage-name" title={feed.url}>
                    {feed.title || feed.url}
                  </span>
                  {/* 刷新失败标记：悬停看具体原因。批量选中用「当前是否失败」判定，
                      连续失败次数放在这里展示，让用户自己判断是抖动还是真下线 */}
                  {feed.last_error && (
                    <span className="feed-error-tag" title={feed.last_error}>
                      {failLabel(feed)}
                    </span>
                  )}
                  <div className="feeds-manage-controls">
                    <span className="feed-group-tag">
                      {groups.find((g) => g.id === feed.group_id)?.name ?? "未分组"}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            {searchingFeeds && (
              <div className="feeds-search-hint">
                匹配 {visibleFeeds.length} / {feeds.length} 个订阅源
              </div>
            )}

            {/* 单选编辑面板 */}
            {checkedFeedIds.size === 1 && (() => {
              const feed = feeds.find((f) => checkedFeedIds.has(f.id));
              if (!feed) return null;
              return (
                <div className="feed-edit-panel">
                  <div className="feed-edit-title">编辑订阅源</div>
                  <div className="feed-edit-field">
                    <label>名称</label>
                    <input
                      className="settings-text-input"
                      type="text"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onBlur={() => {
                        if (editTitle.trim() && editTitle !== feed.title) {
                          void onUpdateFeed(feed.id, { title: editTitle.trim() });
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      }}
                    />
                  </div>
                  <div className="feed-edit-field">
                    <label>URL</label>
                    <input
                      className="settings-text-input"
                      type="url"
                      value={editUrl}
                      onChange={(e) => setEditUrl(e.target.value)}
                      onBlur={() => {
                        if (editUrl.trim() && editUrl !== feed.url && rssService.isValidHttpUrl(editUrl)) {
                          void onUpdateFeed(feed.id, { url: editUrl.trim() });
                        } else {
                          setEditUrl(feed.url);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      }}
                    />
                  </div>
                  <div className="feed-edit-field">
                    <label>文章打开方式</label>
                    <select
                      className="settings-select"
                      value={editOpenMethod}
                      onChange={(e) => {
                        const val = e.target.value;
                        setEditOpenMethod(val);
                        void onUpdateFeed(feed.id, {
                          open_method: val === "external" ? "external" : null,
                        });
                      }}
                    >
                      <option value="internal">内部阅读</option>
                      <option value="external">外部浏览器</option>
                    </select>
                  </div>
                </div>
              );
            })()}
          </>
        )}
      </div>
    </div>
  );
}
