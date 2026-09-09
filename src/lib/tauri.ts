/**
 * 类型化 IPC 封装：业务代码只调用 call<T>()，命令名与类型收敛在各 services 中。
 */
import { invoke } from "@tauri-apps/api/core";

/** 类型化 invoke：命令名 + 参数 + 返回类型 */
export function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args);
}