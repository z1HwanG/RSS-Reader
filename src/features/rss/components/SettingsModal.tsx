/*
 * 文件名: SettingsModal.tsx
 * 描述: Fluent 2 ContentDialog — 标签式设置面板的外壳：tab 切换、Esc 关闭、删除确认框。
 *   各分区组件在 settings/ 目录下：
 *   - FeedsSettings     订阅源（添加 / OPML 导入导出 / 全量列表）
 *   - OrganizeSettings  分组与排序（分组管理 + 拖拽排序）
 *   - NetworkSettings   网络（HTTP 代理）
 *   - AboutSettings     关于（版本 / 检查更新）
 *   外观与通用分区很薄（无独立状态），保留在本文件内联。
 *   所有设置即时生效（含阅读字号）；点击遮罩或按 Esc 关闭
 */
import { useEffect, useState } from "react";
import type { Article, Feed, Group } from "../types";
import {
  type RefreshFrequency,
  type ThemePreference,
  type ProxyPrefs,
} from "../../../lib/preferences";
import type { FeedMovePosition } from "../../../lib/feedOrder";
import { TranslateSettings } from "./TranslateSettings";
import { FeedsSettings } from "./settings/FeedsSettings";
import { OrganizeSettings } from "./settings/OrganizeSettings";
import { NetworkSettings } from "./settings/NetworkSettings";
import { AboutSettings } from "./settings/AboutSettings";

type SettingsTab = "feeds" | "organize" | "appearance" | "network" | "translate" | "general" | "about";

interface SettingsModalProps {
  onClose: () => void;
  feeds: Feed[];
  /** 全部文章：只用于「批量清理」判断某个源多久没更新（取每个源最新一篇的时间） */
  articles: Article[];
  groups: Group[];
  fontSize: number;
  onFontSizeChange: (size: number) => void;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  refreshFrequency: RefreshFrequency;
  onRefreshFrequencyChange: (freq: RefreshFrequency) => void;
  proxy: ProxyPrefs;
  onProxyChange: (proxy: ProxyPrefs) => void;
  /** 内联添加订阅源 URL */
  onAddFeedUrl: (url: string) => Promise<void>;
  /** 批量导入订阅源（仅写入 URL+标题，后台刷新） */
  onBatchImport: (items: { url: string; title?: string }[]) => Promise<void>;
  onRemoveFeed: (feedId: string) => void;
  /** 批量删除订阅源 */
  onRemoveFeeds: (feedIds: string[]) => void;
  /** 更新订阅源属性（名称/URL/打开方式） */
  onUpdateFeed: (feedId: string, patch: Partial<Pick<Feed, "title" | "url" | "open_method">>) => Promise<void>;
  /**
   * 移动订阅源：按档位上移/下移/置顶/置底，或（拖拽时）插到 `beforeId` 之前。
   * 只在同组内生效，`sort_order` 为组内序号。
   */
  onMoveFeed: (feedId: string, position: FeedMovePosition, beforeId?: string | null) => void;
  onMoveToGroup: (feedId: string, groupId: string | null) => void;
  /**
   * 拖动排序分组：把 `groupId` 移到 `beforeGroupId` 之前（null = 移到末尾）。
   * 分组先后由 state.groups 的数组顺序决定，没有 sort_order。
   */
  onReorderGroup: (groupId: string, beforeGroupId: string | null) => void;
  /** 「分组与排序」里被折叠的分组（分组 id；未分组用 `__ungrouped__`），持久化在偏好里 */
  collapsedGroups: string[];
  onToggleGroupCollapsed: (key: string) => void;
  onAddGroup: (name: string) => void;
  onRenameGroup: (id: string, name: string) => void;
  onRemoveGroup: (id: string) => void;
  /** 清理本地缓存（内存里的全文提取结果 / 列表预览 / 搜索索引），返回清掉的条数；不删除文章 */
  onClearLocalCache: () => number;
  onBackup: () => void;
  onRestore: () => void;
}

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "feeds", label: "订阅源" },
  { id: "organize", label: "分组与排序" },
  { id: "appearance", label: "外观" },
  { id: "network", label: "网络" },
  { id: "translate", label: "翻译" },
  { id: "general", label: "通用" },
  { id: "about", label: "关于" },
];

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

const FREQUENCY_OPTIONS: { value: RefreshFrequency; label: string }[] = [
  { value: "never", label: "从不" },
  { value: "10m", label: "10 分钟" },
  { value: "15m", label: "15 分钟" },
  { value: "20m", label: "20 分钟" },
  { value: "30m", label: "30 分钟" },
  { value: "45m", label: "45 分钟" },
  { value: "1h", label: "1 小时" },
];

export function SettingsModal({
  onClose,
  feeds,
  articles,
  groups,
  fontSize,
  onFontSizeChange,
  theme,
  onThemeChange,
  refreshFrequency,
  onRefreshFrequencyChange,
  proxy,
  onProxyChange,
  onAddFeedUrl,
  onBatchImport,
  onRemoveFeed,
  onRemoveFeeds,
  onUpdateFeed,
  onMoveFeed,
  onMoveToGroup,
  onReorderGroup,
  collapsedGroups,
  onToggleGroupCollapsed,
  onAddGroup,
  onRenameGroup,
  onRemoveGroup,
  onClearLocalCache,
  onBackup,
  onRestore,
}: SettingsModalProps): JSX.Element {
  const [tab, setTab] = useState<SettingsTab>("feeds");

  // 删除确认框：订阅源 / 分组与排序两个分区都通过 onRequestDelete 弹到这里
  const [confirmDeleteIds, setConfirmDeleteIds] = useState<string[] | null>(null);

  // 清理缓存：完成提示（通用分区）
  const [cleanupNotice, setCleanupNotice] = useState<string | null>(null);

  const handleConfirmDelete = (): void => {
    if (!confirmDeleteIds) return;
    if (confirmDeleteIds.length === 1) {
      onRemoveFeed(confirmDeleteIds[0]);
    } else {
      onRemoveFeeds(confirmDeleteIds);
    }
    setConfirmDeleteIds(null);
  };

  // Esc 关闭设置面板；确认框打开时优先关闭它
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (confirmDeleteIds) {
        setConfirmDeleteIds(null);
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirmDeleteIds, onClose]);

  /** 清理缓存：内存解析缓存 + WebView 磁盘缓存（图片缓存），不动文章数据 */
  const handleClearLocalCache = (): void => {
    const cleared = onClearLocalCache();
    setCleanupNotice(cleared > 0 ? `已清理 ${cleared} 条解析缓存` : "解析缓存已经是空的");
    window.setTimeout(() => setCleanupNotice(null), 4000);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <h2>设置</h2>

        <div className="settings-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`settings-tab ${tab === t.id ? "active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="settings-tab-body">
          {/* ===== 订阅源 ===== */}
          {tab === "feeds" && (
            <FeedsSettings
              feeds={feeds}
              articles={articles}
              groups={groups}
              onAddFeedUrl={onAddFeedUrl}
              onBatchImport={onBatchImport}
              onUpdateFeed={onUpdateFeed}
              onRequestDelete={setConfirmDeleteIds}
            />
          )}

          {/* ===== 分组与排序 ===== */}
          {tab === "organize" && (
            <OrganizeSettings
              feeds={feeds}
              groups={groups}
              collapsedGroups={collapsedGroups}
              onAddGroup={onAddGroup}
              onRenameGroup={onRenameGroup}
              onRemoveGroup={onRemoveGroup}
              onMoveFeed={onMoveFeed}
              onMoveToGroup={onMoveToGroup}
              onReorderGroup={onReorderGroup}
              onToggleGroupCollapsed={onToggleGroupCollapsed}
              onRequestDelete={setConfirmDeleteIds}
            />
          )}

          {/* ===== 外观 ===== */}
          {tab === "appearance" && (
            <div className="appearance-tab">
              <div className="settings-card settings-card--rows">
                <div className="settings-card-header">主题与字号</div>
                <div className="settings-field">
                  <label>界面主题</label>
                  <div className="settings-options">
                    {THEME_OPTIONS.map((opt) => (
                      <label key={opt.value} className="settings-option">
                        <input
                          type="radio"
                          name="theme"
                          value={opt.value}
                          checked={theme === opt.value}
                          onChange={() => onThemeChange(opt.value)}
                        />
                        {opt.label}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="settings-field">
                  <label htmlFor="font-size">阅读字号</label>
                  <input
                    id="font-size"
                    type="range"
                    min="12"
                    max="24"
                    value={fontSize}
                    onChange={(e) => onFontSizeChange(Number(e.target.value))}
                  />
                  <span className="settings-value">{fontSize}px</span>
                </div>
              </div>
            </div>
          )}

          {/* ===== 网络 ===== */}
          {tab === "network" && <NetworkSettings proxy={proxy} onProxyChange={onProxyChange} />}

          {/* ===== 翻译 ===== */}
          {tab === "translate" && <TranslateSettings />}

          {/* ===== 通用 ===== */}
          {tab === "general" && (
            <div className="general-tab">
              <div className="settings-card settings-card--rows">
                <div className="settings-card-header">抓取与缓存</div>
                <div className="settings-field">
                  <label htmlFor="refresh-frequency">自动抓取频率</label>
                  <select
                    id="refresh-frequency"
                    className="settings-select"
                    value={refreshFrequency}
                    onChange={(e) =>
                      onRefreshFrequencyChange(e.target.value as RefreshFrequency)
                    }
                  >
                    {FREQUENCY_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="settings-field">
                  <label>缓存</label>
                  <div className="settings-inline">
                    <button className="f2-btn-soft" onClick={handleClearLocalCache}>
                      清理缓存
                    </button>
                  </div>
                </div>
              </div>
              {cleanupNotice && <div className="import-success">{cleanupNotice}</div>}
              <div className="settings-card">
                <div className="settings-card-header">应用数据</div>
                <div className="settings-actions">
                  <button className="f2-btn-outline" onClick={onBackup}>
                    备份
                  </button>
                  <button className="f2-btn-outline" onClick={onRestore}>
                    还原
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ===== 关于 ===== */}
          {tab === "about" && <AboutSettings proxy={proxy} />}
        </div>

      </div>

      {/* 删除确认对话框 */}
      {confirmDeleteIds && (
        <div className="modal-overlay confirm-overlay" onClick={() => setConfirmDeleteIds(null)}>
          <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <span
              className="material-symbols-rounded confirm-icon"
            >
              delete_forever
            </span>
            <h3>确认删除</h3>
            <p className="confirm-text">
              确定要删除 {confirmDeleteIds.length} 个订阅源吗？相关文章也将一并删除，此操作不可撤销。
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="f2-btn-standard"
                onClick={() => setConfirmDeleteIds(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="f2-btn-accent confirm-delete-btn"
                onClick={handleConfirmDelete}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
