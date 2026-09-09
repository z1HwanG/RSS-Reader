import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 开发需要固定端口，避免随机端口
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],

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