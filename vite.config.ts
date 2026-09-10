import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 开发需要固定端口，避免随机端口
const host = process.env.TAURI_DEV_HOST;

/**
 * 文件监听错误守卫（仅 dev）。
 *
 * 背景：编辑器 / 工具在保存文件时会「先写临时文件再改名」（例如
 * `src/.App.tsx.<pid>.<uuid>.tmpdir/App.tsx.tmp`）。chokidar 可能刚好在临时文件
 * 被删除的瞬间去 watch 它，Windows 下抛 `EBUSY: resource busy or locked`。
 * chokidar 的 `isFatalError` 只把 EACCES / EPERM 当致命错误，EBUSY 不是致命错误，
 * 但 Node 的 FSWatcher 在无人处理 `error` 事件时会把异常抛到进程顶层，于是
 * vite 直接退出，`tauri dev` 报 "beforeDevCommand terminated"，
 * 窗口里的页面就冻在崩溃前的内容上（看起来像「改了代码却没生效」）。
 *
 * 这里做两层防护：
 * 1. 订阅 `server.watcher` 的 `error` 事件，让 Node 认为该事件已被处理；
 * 2. 进程级 `uncaughtException` 兜底，只忽略这类资源占用错误，其余照旧抛错。
 */
/**
 * 判定「可忽略的文件监听错误」。
 * 只放行资源占用类错误（EBUSY / ENOENT / ENOTDIR —— 临时文件在扫描过程中被删除时会出现），
 * 且必须带上临时文件的特征（`.tmpdir` / `.tmp`）或位于删除流程里；
 * 像 EACCES「没权限读某个真实文件」这种属于真问题，必须照旧暴露出来。
 */
const RESOURCE_CODES = /(EBUSY|ENOENT|ENOTDIR)/;
const isFileWatchError = (text: string): boolean =>
  RESOURCE_CODES.test(text) && /(\.tmpdir|\.tmp\b|tmpdir|unlink|deleted)/i.test(text);

let watchErrorGuardInstalled = false;
function installProcessLevelGuard(): void {
  if (watchErrorGuardInstalled) return;
  watchErrorGuardInstalled = true;
  process.on("uncaughtException", (error) => {
    const text = String((error as Error)?.stack ?? error);
    if (!isFileWatchError(text)) {
      // 不是这类错误：保持 Node 原有行为，照旧打印并退出
      console.error(error);
      process.exit(1);
    }
    console.warn(
      `[watch] 忽略文件监听错误，dev server 继续运行：${String(error).split("\n")[0]}`,
    );
  });
}

function fileWatchGuard(): Plugin {
  return {
    name: "rss-reader:file-watch-guard",
    apply: "serve",
    configureServer(server) {
      installProcessLevelGuard();
      // 只在「已确认可忽略」时登记监听器：Node 一旦发现 error 事件有监听者就不再抛到顶层。
      // 其余监听错误不注册监听器，保持 vite/Node 的默认行为（照旧暴露、照旧退出），
      // 避免守卫把真实问题一起吞掉。
      server.watcher.on("error", (error: NodeJS.ErrnoException) => {
        const text = `${error?.code ?? ""} ${error?.message ?? ""} ${error?.path ?? ""}`;
        if (!isFileWatchError(text)) {
          // 重新抛到顶层，恢复默认行为
          throw error;
        }
        console.warn(`[watch] 忽略文件监听错误：${error?.message ?? String(error)}`);
      });
    },
  };
}

export default defineConfig(async () => ({
  plugins: [react(), fileWatchGuard()],

  // Vite 选项
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Rust 文件变更不需要前端 HMR
      ignored: ["**/src-tauri/**"],
    },
  },

  // 依赖预打包
  optimizeDeps: {
    exclude: ["@tauri-apps/api"],
  },
}));
