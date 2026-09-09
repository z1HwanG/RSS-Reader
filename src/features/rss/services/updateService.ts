/*
 * 文件名: updateService.ts
 * 描述: 应用自动更新 —— 封装 Tauri updater / process 插件。
 *       检查地址与签名公钥在 src-tauri/tauri.conf.json 的 plugins.updater 中配置
 *       （GitHub Releases 为主、Forgejo 备用），安装包签名由插件用公钥强制校验，
 *       校验不通过则拒绝安装。
 */
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent } from "@tauri-apps/plugin-updater";

/** 可用更新的摘要信息 */
export interface UpdateInfo {
  /** 新版本号 */
  version: string;
  /** 当前运行版本号 */
  currentVersion: string;
  /** 更新说明（latest.json 的 notes） */
  notes: string | null;
  /** 发布时间（ISO 字符串，可能为空） */
  date: string | null;
}

/** 下载进度 */
export interface DownloadProgress {
  /** 已下载字节数 */
  downloaded: number;
  /** 总字节数；服务端未返回 Content-Length 时为 null */
  total: number | null;
}

/** 一次检查的结果：除摘要外还带可执行的安装方法 */
export interface AvailableUpdate extends UpdateInfo {
  /** 下载并安装更新；Windows 上安装器接管后应用自动退出并重启 */
  install: (onProgress?: (progress: DownloadProgress) => void) => Promise<void>;
}

/** Windows 上安装器会自动重启应用，其他平台需要手动 relaunch */
const IS_WINDOWS = navigator.userAgent.includes("Windows");

/**
 * 检查是否有新版本。无更新返回 null。
 * proxyUrl 为应用内配置的代理（如 http://127.0.0.1:7897）；不传则使用系统代理。
 */
export async function checkForUpdate(proxyUrl?: string): Promise<AvailableUpdate | null> {
  const update = await check({
    proxy: proxyUrl,
    // 网络异常时不要一直转圈
    timeout: 30_000,
  });
  if (!update) return null;

  return {
    version: update.version,
    currentVersion: update.currentVersion,
    notes: update.body ?? null,
    date: update.date ?? null,
    install: async (onProgress) => {
      let downloaded = 0;
      let total: number | null = null;
      await update.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? null;
          onProgress?.({ downloaded: 0, total });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          onProgress?.({ downloaded, total });
        } else {
          onProgress?.({ downloaded: total ?? downloaded, total });
        }
      });
      // Windows：安装器已接管并默认重启应用；其他平台需要手动重启
      if (!IS_WINDOWS) await relaunch();
    },
  };
}

/** 重启应用（供安装完成后手动调用） */
export function relaunchApp(): Promise<void> {
  return relaunch();
}
