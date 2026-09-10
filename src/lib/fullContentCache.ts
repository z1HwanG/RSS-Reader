/*
 * 文件名: fullContentCache.ts
 * 描述: 「获取全文」结果的内存缓存（同一篇文章切走再切回不重复抓取与提取）
 *
 * 为什么单独成模块：它需要在两个地方被操作——
 * 1) 阅读视图按文章读写；
 * 2) 设置里的「清理本地缓存」要能清空它（缓存都在内存里，文章数据本身不动）。
 * 上限 20 篇，超出后按插入顺序淘汰最早的。
 */
import type { ExtractedContent } from "./articleExtract";

const limit = 20;
const cache = new Map<string, ExtractedContent>();

/** 读取某篇文章的全文缓存（没有则返回 null） */
export function getFullContent(articleId: string): ExtractedContent | null {
  return cache.get(articleId) ?? null;
}

/** 写入全文缓存（超过上限时淘汰最早插入的一条） */
export function setFullContent(articleId: string, content: ExtractedContent): void {
  if (cache.size >= limit) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(articleId, content);
}

/** 清空全文缓存，返回被清掉的条数（设置面板反馈用） */
export function clearFullContentCache(): number {
  const size = cache.size;
  cache.clear();
  return size;
}
