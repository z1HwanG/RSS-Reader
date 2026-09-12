/*
 * 文件名: translationCache.ts
 * 描述: 翻译结果本地缓存（纯核心 + 存储后端注入，便于单独验证 —— 与 lib/menuPosition.ts 同套路）
 *
 * 为什么要有缓存：主流划词/沉浸式翻译插件都这么做 —— NAVI 的 "smart caching"、
 * FluentRead 的 "Caching System"、百度官方参考实现，全都用 localStorage 按
 * (text, 源语言, 目标语言) 作键缓存结果，避免同一句话反复翻译、反复烧 API 预算。
 * 我们以前翻过的文章/句子每次重翻都会重新请求，命中了直接返回可省掉整次网络往返。
 *
 * 键不包含 provider：同一句短语用不同翻译源结果大体稳定，按 (text, 源, 目标) 键
 * 命中率最高，和参考实现一致。用户切换目标语言即换键，不会串味。
 *
 * 容量有上限：无限缓存会让 localStorage 撑爆。存满时按时间戳逐出最旧的（LRU 近似）。
 */
/** 一条缓存：text 是译文，t 是存入时间戳（用于逐出最旧） */
export interface CacheEntry {
  text: string;
  t: number;
}

/** 存储后端：读写整份映射（浏览器里接 localStorage，测试里接内存 Map） */
export interface TranslationCacheBackend {
  load(): Map<string, CacheEntry>;
  save(map: Map<string, CacheEntry>): void;
}

/** 缓存容量上限：超过逐出最旧的（近似 LRU） */
export const TRANSLATION_CACHE_MAX = 2000;

/** 键：文本 + 源语言 + 目标语言。文本压空白并转小写，避免「HELLO」与「hello」算两条 */
export function translationCacheKey(
  text: string,
  source: string,
  target: string,
): string {
  return JSON.stringify([text.replace(/\s+/g, " ").trim().toLowerCase(), source, target]);
}

/** 查缓存：命中返回译文文本，未命中返回 null */
export function lookupTranslation(
  backend: TranslationCacheBackend,
  key: string,
): string | null {
  const entry = backend.load().get(key);
  return entry?.text ?? null;
}

/** 存一条；超限时按时间戳逐出最旧。写失败（如存储被禁）静默忽略，不影响翻译本身 */
export function saveTranslation(
  backend: TranslationCacheBackend,
  key: string,
  text: string,
): void {
  const map = backend.load();
  map.set(key, { text, t: Date.now() });
  if (map.size > TRANSLATION_CACHE_MAX) {
    // 删掉最旧的一条，逐出到容量内（不必精确排到容量线，删一条已够平抑增长）
    let oldestKey: string | null = null;
    let oldestT = Infinity;
    for (const [k, v] of map) {
      if (v.t < oldestT) {
        oldestT = v.t;
        oldestKey = k;
      }
    }
    if (oldestKey !== null) map.delete(oldestKey);
  }
  try {
    backend.save(map);
  } catch {
    // 存储失败（配额满 / 隐私模式）不该让翻译报错
  }
}

/** 构造一个接 localStorage 的后端（键名独立，避免和其它偏好混在一起） */
export function localStorageBackend(
  storageKey: string,
  storage: Storage = window.localStorage,
): TranslationCacheBackend {
  return {
    load: () => {
      try {
        const raw = storage.getItem(storageKey);
        if (!raw) return new Map();
        return new Map(JSON.parse(raw) as [string, CacheEntry][]);
      } catch {
        return new Map();
      }
    },
    save: (map) => {
      storage.setItem(storageKey, JSON.stringify([...map]));
    },
  };
}