/*
 * 文件名: AboutSettings.tsx
 * 描述: 设置面板「关于」分区：版本信息、检查更新 / 下载安装、反馈链接。
 */
import { useCallback, useState } from "react";
import { buildProxyUrl, type ProxyPrefs } from "../../../../lib/preferences";
import * as updateService from "../../services/updateService";
import pkg from "../../../../../package.json";

/** 字节数格式化（更新下载进度展示用） */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

interface AboutSettingsProps {
  /** 检查更新走应用内代理（未启用时交给系统代理） */
  proxy: ProxyPrefs;
}

export function AboutSettings({ proxy }: AboutSettingsProps): JSX.Element {
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

  return (
    <div className="about-tab">
      <span
        className="material-symbols-rounded"
        style={{ fontSize: "48px", color: "var(--f2-accent-fg)", margin: "0 0 8px" }}
      >
        newspaper
      </span>
      <div className="about-app">RSS Reader</div>
      <div className="about-version-block">
        <div className="about-version-row">
          <span className="about-version">版本 {pkg.version}</span>
          <button
            type="button"
            className="about-check-btn"
            disabled={updatePhase === "checking" || updatePhase === "installing"}
            onClick={() => void handleCheckUpdate()}
          >
            <span className="material-symbols-rounded">refresh</span>
            {updatePhase === "checking" ? "检查中…" : "检查更新"}
          </button>
        </div>
        {updatePhase === "latest" && (
          <div className="about-update-hint">
            <span className="material-symbols-rounded update-icon-accent">check_circle</span>
            已是最新版本
          </div>
        )}
        {updatePhase === "error" && (
          <div className="about-update-hint about-update-hint-error">
            <span className="material-symbols-rounded">error</span>
            <span>检查更新失败：{updateError}</span>
          </div>
        )}
      </div>
      <div className="about-version" style={{ marginTop: "8px" }}>
        Tauri 2 + React + Fluent 2
      </div>

      {/* 反馈入口：点击由全局链接守卫接管，改用系统浏览器打开 */}
      <div className="about-links">
        <a
          className="about-link"
          href="https://github.com/z1HwanG/RSS-Reader/issues"
          rel="noreferrer"
        >
          <span className="material-symbols-rounded">open_in_new</span>
          报告问题（GitHub）
        </a>
        <a
          className="about-link"
          href="https://git.z1hwang.cn/Zeehow/RSS-Reader/issues"
          rel="noreferrer"
        >
          <span className="material-symbols-rounded">open_in_new</span>
          报告问题（Forgejo）
        </a>
      </div>

      {/* 有可用更新或正在下载时才显示卡片 */}
      {(updatePhase === "available" || updatePhase === "installing") && (
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
          ) : (
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
          )}
        </div>
      )}
    </div>
  );
}
