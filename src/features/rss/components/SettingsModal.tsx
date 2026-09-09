/*
 * 文件名: SettingsModal.tsx
 * 描述: Fluent 2 ContentDialog — 标签式设置面板
 *   订阅源: 内联添加 URL + OPML 导入导出 + 全量列表
 *   分组与排序: 分组管理 + 上下移动排序 + 分组下拉
 *   网络: HTTP 代理（格式校验 + 连通性测试）；通用: 清理缓存 / 备份还原
 *   所有设置即时生效（含阅读字号）；点击遮罩或按 Esc 关闭
 */
import { useCallback, useEffect, useState } from "react";
import { save as showSaveDialog, open as showOpenDialog } from "@tauri-apps/plugin-dialog";
import {
  buildProxyUrl,
  CLEANUP_DAY_OPTIONS,
  type RefreshFrequency,
  type ThemePreference,
  type ProxyPrefs,
} from "../../../lib/preferences";
import type { Feed, Group } from "../types";
import * as rssService from "../services/rssService";
import * as updateService from "../services/updateService";
import pkg from "../../../../package.json";

type SettingsTab = "feeds" | "organize" | "appearance" | "network" | "general" | "about";

interface SettingsModalProps {
  onClose: () => void;
  feeds: Feed[];
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
  onMoveFeed: (feedId: string, direction: "up" | "down") => void;
  onMoveToGroup: (feedId: string, groupId: string | null) => void;
  onMoveGroup: (groupId: string, direction: "up" | "down") => void;
  onAddGroup: (name: string) => void;
  onRenameGroup: (id: string, name: string) => void;
  onRemoveGroup: (id: string) => void;
  /** 清理 N 天前的缓存文章，返回实际清理条数 */
  onCleanupOldArticles: (days: number) => number;
  /** 各档位下将清理的文章数（实时显示） */
  cleanupCounts: Record<number, number>;
  onBackup: () => void;
  onRestore: () => void;
}

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "feeds", label: "订阅源" },
  { id: "organize", label: "分组与排序" },
  { id: "appearance", label: "外观" },
  { id: "network", label: "网络" },
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

/** 规范化代理主机：剥离误填的 scheme 前缀与结尾斜杠（与 Rust 侧 normalize_proxy_host 对齐） */
function normalizeProxyHost(host: string): string {
  return host.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

/** 校验代理主机：非空，且能与端口拼出合法 URL（镜像 Rust 侧 http/socks5://{host}:{port} 的拼装方式） */
function proxyHostError(host: string): string | null {
  const trimmed = normalizeProxyHost(host);
  if (!trimmed) return "请输入代理主机";
  try {
    const parsed = new URL(`http://${trimmed}:1`);
    return parsed.hostname ? null : "代理主机格式不正确";
  } catch {
    return "代理主机格式不正确";
  }
}

/** 校验代理端口：1-65535 的整数 */
function proxyPortError(port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "端口需为 1-65535 的整数";
  }
  return null;
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

/** 字节数格式化（更新下载进度展示用） */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function SettingsModal({
  onClose,
  feeds,
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
  onMoveGroup,
  onAddGroup,
  onRenameGroup,
  onRemoveGroup,
  onCleanupOldArticles,
  cleanupCounts,
  onBackup,
  onRestore,
}: SettingsModalProps): JSX.Element {
  const [tab, setTab] = useState<SettingsTab>("feeds");
  const [cleanupDays, setCleanupDays] = useState(30);
  const [newGroupName, setNewGroupName] = useState("");
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editGroupName, setEditGroupName] = useState("");

  // 订阅源 tab 状态
  const [urlInput, setUrlInput] = useState("");
  const [addingFeed, setAddingFeed] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [importDone, setImportDone] = useState<string | null>(null);
  // 订阅源 tab — 选框 + 编辑面板
  const [checkedFeedIds, setCheckedFeedIds] = useState<Set<string>>(new Set());
  const [editTitle, setEditTitle] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editOpenMethod, setEditOpenMethod] = useState<string>("internal");
  const [confirmDeleteIds, setConfirmDeleteIds] = useState<string[] | null>(null);
  // 清理缓存：待确认的档位 + 完成提示
  const [confirmCleanupDays, setConfirmCleanupDays] = useState<number | null>(null);
  const [cleanupNotice, setCleanupNotice] = useState<string | null>(null);

  // 网络 tab 状态：端口草稿（允许输入中间态，仅合法值向上同步）+ 连接测试
  const [portDraft, setPortDraft] = useState<string>(String(proxy.port));
  const [testingProxy, setTestingProxy] = useState(false);
  const [proxyTestResult, setProxyTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  // ===== 自动更新 =====
  /** idle 未检查 / checking 检查中 / latest 已是最新 / available 有新版本 / installing 下载安装中 / error 失败 */
  const [updatePhase, setUpdatePhase] = useState<
    "idle" | "checking" | "latest" | "available" | "installing" | "error"
  >("idle");
  const [updateInfo, setUpdateInfo] = useState<updateService.AvailableUpdate | null>(null);
  const [updateProgress, setUpdateProgress] = useState<updateService.DownloadProgress | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  /** 下载进度百分比；服务端未给总大小时为 null（显示不确定进度条） */
  const updatePercent =
    updateProgress?.total && updateProgress.total > 0
      ? Math.min(100, Math.round((updateProgress.downloaded / updateProgress.total) * 100))
      : null;

  /** 检查更新：代理取应用内配置，未启用时交给系统代理 */
  const handleCheckUpdate = useCallback(async (): Promise<void> => {
    setUpdatePhase("checking");
    setUpdateError(null);
    setUpdateInfo(null);
    try {
      const result = await updateService.checkForUpdate(buildProxyUrl(proxy));
      if (result) {
        setUpdateInfo(result);
        setUpdatePhase("available");
      } else {
        setUpdatePhase("latest");
      }
    } catch (err) {
      setUpdateError(String(err));
      setUpdatePhase("error");
    }
  }, [proxy]);

  /** 下载并安装：Windows 上安装器接管后应用自动退出并重启 */
  const handleInstallUpdate = useCallback(async (): Promise<void> => {
    if (!updateInfo) return;
    setUpdatePhase("installing");
    setUpdateError(null);
    setUpdateProgress({ downloaded: 0, total: null });
    try {
      await updateInfo.install(setUpdateProgress);
    } catch (err) {
      setUpdateError(String(err));
      setUpdatePhase("error");
    }
  }, [updateInfo]);

  const sortedFeeds = [...feeds].sort((a, b) => a.sort_order - b.sort_order);

  // 订阅源 tab 选框切换
  const toggleFeedCheck = (feedId: string): void => {
    setCheckedFeedIds((prev) => {
      const next = new Set(prev);
      if (next.has(feedId)) next.delete(feedId);
      else next.add(feedId);
      return next;
    });
  };

  // 订阅源 tab — 全选/取消全选
  const allFeedIds = new Set(sortedFeeds.map((f) => f.id));
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
    setConfirmDeleteIds([...checkedFeedIds]);
  };

  const handleConfirmDelete = (): void => {
    if (!confirmDeleteIds) return;
    if (confirmDeleteIds.length === 1) {
      onRemoveFeed(confirmDeleteIds[0]);
    } else {
      onRemoveFeeds(confirmDeleteIds);
    }
    setCheckedFeedIds(new Set());
    setConfirmDeleteIds(null);
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

  // 外部端口值变化时同步草稿（如偏好被其他途径更新）
  useEffect(() => {
    setPortDraft(String(proxy.port));
  }, [proxy.port]);

  // Esc 关闭设置面板（底部已无关闭按钮）；确认框打开时优先关闭它
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (confirmCleanupDays !== null) {
        setConfirmCleanupDays(null);
        return;
      }
      if (confirmDeleteIds) {
        setConfirmDeleteIds(null);
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirmCleanupDays, confirmDeleteIds, onClose]);

  function getFeedsByGroup(groupId: string | null): Feed[] {
    return sortedFeeds.filter((f) => f.group_id === groupId);
  }

  // ---- 订阅源 tab 操作 ----

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

  // ---- 网络 tab 操作 ----

  /** 端口输入：草稿实时更新，仅合法值同步到偏好（避免输入中间态被强行改写为默认值） */
  const handlePortDraftChange = (value: string): void => {
    setPortDraft(value);
    const parsed = Number(value);
    if (value.trim() !== "" && proxyPortError(parsed) === null) {
      onProxyChange({ ...proxy, port: parsed });
    }
  };

  /** 端口失焦：非法草稿回滚为当前生效值 */
  const handlePortDraftBlur = (): void => {
    if (proxyPortError(Number(portDraft)) !== null) {
      setPortDraft(String(proxy.port));
    }
  };

  /** 主机失焦：剥离 scheme 与结尾斜杠，并拆出误填在主机里的端口（如 127.0.0.1:7890） */
  const handleHostBlur = (): void => {
    let host = normalizeProxyHost(proxy.host);
    let port = portDraft;
    const colon = host.lastIndexOf(":");
    if (colon > -1 && !host.startsWith("[") && /^\d+$/.test(host.slice(colon + 1))) {
      port = host.slice(colon + 1);
      host = host.slice(0, colon);
    }
    const portChanged = port !== portDraft;
    const hostChanged = host !== proxy.host;
    if (!hostChanged && !portChanged) return;
    if (portChanged) setPortDraft(port);
    const parsedPort = Number(port);
    onProxyChange({
      ...proxy,
      host,
      ...(proxyPortError(parsedPort) === null ? { port: parsedPort } : {}),
    });
  };

  /** 代理连通性测试：经 Rust 侧通过代理请求探测地址 */
  const handleTestProxy = async (): Promise<void> => {
    const host = normalizeProxyHost(proxy.host);
    if (proxyHostError(host) !== null || proxyPortError(Number(portDraft)) !== null) return;
    setTestingProxy(true);
    setProxyTestResult(null);
    try {
      const result = await rssService.testProxy(host, Number(portDraft), proxy.kind);
      const probeHost = new URL(result.target).host;
      setProxyTestResult({
        ok: true,
        text: `连接成功（${probeHost}，${result.latency_ms} ms）`,
      });
    } catch (err) {
      setProxyTestResult({ ok: false, text: `连接失败：${String(err)}` });
    } finally {
      setTestingProxy(false);
    }
  };

  // ---- 分组与排序 tab 操作 ----

  const handleAddGroupClick = (): void => {
    const name = newGroupName.trim();
    if (!name) return;
    onAddGroup(name);
    setNewGroupName("");
  };

  const startEditGroup = (g: Group): void => {
    setEditingGroupId(g.id);
    setEditGroupName(g.name);
  };

  const confirmRenameGroup = (): void => {
    if (editingGroupId && editGroupName.trim()) {
      onRenameGroup(editingGroupId, editGroupName.trim());
    }
    setEditingGroupId(null);
  };

  /** 渲染单个订阅源行（分组与排序 tab） */
  function renderFeedRow(feed: Feed, index: number, total: number): JSX.Element {
    return (
      <li key={feed.id} className="feeds-manage-item">
        <span className="feeds-manage-name" title={feed.url}>
          {feed.title || feed.url}
        </span>
        <div className="feeds-manage-controls">
          <button
            className="f2-mini-btn"
            onClick={() => onMoveFeed(feed.id, "up")}
            disabled={index === 0}
            title="上移"
          >
            <span className="material-symbols-rounded">keyboard_arrow_up</span>
          </button>
          <button
            className="f2-mini-btn"
            onClick={() => onMoveFeed(feed.id, "down")}
            disabled={index === total - 1}
            title="下移"
          >
            <span className="material-symbols-rounded">keyboard_arrow_down</span>
          </button>
          <select
            className="feeds-manage-group-select"
            value={feed.group_id ?? ""}
            onChange={(e) => onMoveToGroup(feed.id, e.target.value || null)}
            title="切换分组"
          >
            <option value="">未分组</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
          <button
            className="feeds-manage-remove"
            onClick={() => setConfirmDeleteIds([feed.id])}
            title="删除"
          >
            <span className="material-symbols-rounded">delete</span>
          </button>
        </div>
      </li>
    );
  }

  /** 渲染分组区块（分组与排序 tab） */
  function renderGroupBlock(
    label: string,
    groupId: string | null,
    groupIndex: number,
    groupTotal: number,
    group?: Group,
  ): JSX.Element {
    const groupFeeds = getFeedsByGroup(groupId);
    return (
      <div key={group?.id ?? "__ungrouped__"} className="feed-group">
        <div className="feed-group-header">
          {group && editingGroupId === group.id ? (
            <input
              className="group-name-input"
              value={editGroupName}
              onChange={(e) => setEditGroupName(e.target.value)}
              onBlur={confirmRenameGroup}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmRenameGroup();
                if (e.key === "Escape") setEditingGroupId(null);
              }}
              autoFocus
            />
          ) : (
            <span
              className="group-name"
              onDoubleClick={() => group && startEditGroup(group)}
              title={group ? "双击重命名" : undefined}
            >
              {label}
              <span className="feed-count-badge">{groupFeeds.length}</span>
            </span>
          )}
          {group && (
            <div className="group-controls">
              <button
                className="f2-mini-btn"
                onClick={() => onMoveGroup(group.id, "up")}
                disabled={groupIndex === 0}
                title="上移分组"
              >
                <span className="material-symbols-rounded">keyboard_arrow_up</span>
              </button>
              <button
                className="f2-mini-btn"
                onClick={() => onMoveGroup(group.id, "down")}
                disabled={groupIndex === groupTotal - 1}
                title="下移分组"
              >
                <span className="material-symbols-rounded">keyboard_arrow_down</span>
              </button>
              <button
                className="group-remove-btn"
                onClick={() => onRemoveGroup(group.id)}
                title="删除分组（订阅源移至未分组）"
              >
                <span className="material-symbols-rounded">close</span>
              </button>
            </div>
          )}
        </div>
        <div className="feed-group-body">
          {groupFeeds.length === 0 ? (
            <div className="feeds-group-empty">无订阅源</div>
          ) : (
            <ul className="feeds-manage-list">
              {groupFeeds.map((feed, i) => renderFeedRow(feed, i, groupFeeds.length))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  /** 确认清理：执行并给出结果反馈 */
  const handleConfirmCleanup = (): void => {
    if (confirmCleanupDays === null) return;
    const removed = onCleanupOldArticles(confirmCleanupDays);
    setConfirmCleanupDays(null);
    setCleanupNotice(removed > 0 ? `已清理 ${removed} 篇缓存文章` : "没有可清理的缓存");
    window.setTimeout(() => setCleanupNotice(null), 4000);
  };

  // 当前档位将清理的文章数（按钮文案与禁用态用）
  const cleanupCount = cleanupCounts[cleanupDays] ?? 0;

  // 网络 tab：代理配置校验（启用代理时展示错误并禁用测试按钮）
  const proxyHostErr = proxyHostError(proxy.host);
  const proxyPortErr = portDraft.trim() === "" ? "请输入代理端口" : proxyPortError(Number(portDraft));
  const proxyError = proxyHostErr ?? proxyPortErr;
  const proxyValid = proxyError === null;

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
                <div className="settings-card-header">
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
                    <span>全部订阅源 ({feeds.length})</span>
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
                {feeds.length === 0 ? (
                  <div className="feeds-group-empty">还没有订阅源</div>
                ) : (
                  <>
                    <ul className="feeds-manage-list">
                      {sortedFeeds.map((feed) => (
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
                          <div className="feeds-manage-controls">
                            <span className="feed-group-tag">
                              {groups.find((g) => g.id === feed.group_id)?.name ?? "未分组"}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>

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
          )}

          {/* ===== 分组与排序 ===== */}
          {tab === "organize" && (
            <div className="feeds-tab">
              <div className="settings-card">
                <div className="settings-card-header">新建分组</div>
                <div className="feed-add-row">
                  <input
                    className="group-name-input"
                    placeholder="输入分组名称"
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAddGroupClick();
                    }}
                  />
                  <button
                    className="btn-add-group"
                    onClick={handleAddGroupClick}
                    disabled={!newGroupName.trim()}
                  >
                    <span className="material-symbols-rounded">add</span>
                    添加
                  </button>
                </div>
              </div>

              {renderGroupBlock("未分组", null, -1, groups.length)}

              {groups.map((g, gi) =>
                renderGroupBlock(g.name, g.id, gi, groups.length, g),
              )}
            </div>
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
          {tab === "network" && (
            <div className="network-tab">
              <div className="settings-card settings-card--rows">
                <div className="settings-card-header">代理设置</div>
                <div className="settings-field">
                  <label>HTTP 代理</label>
                  <label className="settings-checkbox">
                    <input
                      type="checkbox"
                      checked={proxy.enabled}
                      onChange={(e) => {
                        onProxyChange({ ...proxy, enabled: e.target.checked });
                        setProxyTestResult(null);
                      }}
                    />
                    启用代理
                  </label>
                </div>
                {proxy.enabled && (
                  <>
                    <div className="settings-field">
                      <label htmlFor="proxy-kind">代理类型</label>
                      <select
                        id="proxy-kind"
                        className="settings-select"
                        value={proxy.kind}
                        onChange={(e) => {
                          onProxyChange({ ...proxy, kind: e.target.value as ProxyPrefs["kind"] });
                          setProxyTestResult(null);
                        }}
                      >
                        <option value="http">HTTP</option>
                        <option value="socks5">SOCKS5</option>
                      </select>
                    </div>
                    <div className="settings-field">
                      <label htmlFor="proxy-host">代理主机</label>
                      <input
                        id="proxy-host"
                        className="settings-text-input"
                        type="text"
                        placeholder="127.0.0.1 或 proxy.example.com"
                        value={proxy.host}
                        onChange={(e) =>
                          onProxyChange({ ...proxy, host: e.target.value })
                        }
                        onBlur={handleHostBlur}
                      />
                    </div>
                    <div className="settings-field">
                      <label htmlFor="proxy-port">代理端口</label>
                      <input
                        id="proxy-port"
                        className="settings-text-input"
                        type="text"
                        inputMode="numeric"
                        placeholder="8080"
                        value={portDraft}
                        onChange={(e) => handlePortDraftChange(e.target.value)}
                        onBlur={handlePortDraftBlur}
                      />
                    </div>
                    <div className="settings-field">
                      <label>连接测试</label>
                      <div className="settings-inline">
                        <button
                          className="f2-btn-standard"
                          onClick={() => void handleTestProxy()}
                          disabled={!proxyValid || testingProxy}
                        >
                          {testingProxy ? "测试中…" : "测试连接"}
                        </button>
                        {proxyTestResult && (
                          <span
                            className={
                              proxyTestResult.ok ? "form-text-success" : "form-text-error"
                            }
                          >
                            {proxyTestResult.text}
                          </span>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
              {proxy.enabled && proxyError && (
                <div className="modal-error" role="alert">{proxyError}</div>
              )}
            </div>
          )}

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
                  <label htmlFor="cleanup-days">清理缓存</label>
                  <div className="settings-inline">
                    <select
                      id="cleanup-days"
                      className="settings-select"
                      value={cleanupDays}
                      onChange={(e) => setCleanupDays(Number(e.target.value))}
                    >
                      {CLEANUP_DAY_OPTIONS.map((d) => (
                        <option key={d} value={d}>
                          {d} 天前的缓存
                        </option>
                      ))}
                    </select>
                    <button
                      className="f2-btn-soft"
                      onClick={() => setConfirmCleanupDays(cleanupDays)}
                      disabled={cleanupCount === 0}
                    >
                      {cleanupCount > 0 ? `清理 ${cleanupCount} 篇` : "无可清理"}
                    </button>
                  </div>
                </div>
              </div>
              <div className="settings-hint">
                按发布时间清理本地缓存的文章内容，星标文章不会被清理。
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
          {tab === "about" && (
            <div className="about-tab">
              <span
                className="material-symbols-rounded"
                style={{ fontSize: "48px", color: "var(--f2-accent-fg)", margin: "0 0 8px" }}
              >
                newspaper
              </span>
              <div className="about-app">RSS Reader</div>
              <div className="about-version">版本 {pkg.version}</div>
              <div className="about-version" style={{ marginTop: "8px" }}>
                Tauri 2 + React + Fluent 2
              </div>

              {/* 更新检查与安装 */}
              <div className="update-card">
                {updatePhase === "available" && updateInfo ? (
                  <>
                    <div className="update-line">
                      <span className="material-symbols-rounded update-icon-accent">new_releases</span>
                      发现新版本 <strong>v{updateInfo.version}</strong>
                      <span className="update-current">当前 v{updateInfo.currentVersion}</span>
                    </div>
                    {updateInfo.notes && <div className="update-notes">{updateInfo.notes}</div>}
                    <button
                      type="button"
                      className="f2-btn-accent"
                      onClick={() => void handleInstallUpdate()}
                    >
                      <span className="material-symbols-rounded">file_download</span>
                      下载并安装
                    </button>
                  </>
                ) : updatePhase === "installing" ? (
                  <>
                    <div className="update-line">正在下载更新…</div>
                    <div className="update-progress">
                      <div
                        className={`update-progress-bar${updatePercent === null ? " indeterminate" : ""}`}
                        style={updatePercent !== null ? { width: `${updatePercent}%` } : undefined}
                      />
                    </div>
                    <div className="update-hint">
                      {formatBytes(updateProgress?.downloaded ?? 0)}
                      {updateProgress?.total ? ` / ${formatBytes(updateProgress.total)}` : ""}
                      {updatePercent !== null ? `（${updatePercent}%）` : ""}
                    </div>
                    <div className="update-hint">下载完成后会启动安装程序并重启应用。</div>
                  </>
                ) : (
                  <>
                    {updatePhase === "latest" && (
                      <div className="update-line">
                        <span className="material-symbols-rounded update-icon-accent">check_circle</span>
                        已是最新版本
                      </div>
                    )}
                    {updatePhase === "error" && (
                      <div className="update-line update-line-error">
                        <span className="material-symbols-rounded">error</span>
                        <span>检查更新失败：{updateError}</span>
                      </div>
                    )}
                    <button
                      type="button"
                      className="f2-btn-soft"
                      disabled={updatePhase === "checking"}
                      onClick={() => void handleCheckUpdate()}
                    >
                      <span className="material-symbols-rounded">refresh</span>
                      {updatePhase === "checking" ? "正在检查…" : "检查更新"}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

      </div>

      {/* 清理缓存确认对话框 */}
      {confirmCleanupDays !== null && (
        <div className="modal-overlay confirm-overlay" onClick={() => setConfirmCleanupDays(null)}>
          <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <span className="material-symbols-rounded confirm-icon">cleaning_services</span>
            <h3>确认清理</h3>
            <p className="confirm-text">
              将清理 {cleanupCounts[confirmCleanupDays] ?? 0} 篇 {confirmCleanupDays} 天前的缓存文章，
              星标文章会保留。此操作不可撤销。
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="f2-btn-standard"
                onClick={() => setConfirmCleanupDays(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="f2-btn-accent confirm-delete-btn"
                onClick={handleConfirmCleanup}
              >
                清理
              </button>
            </div>
          </div>
        </div>
      )}

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
