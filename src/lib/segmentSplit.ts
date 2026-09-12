/*
 * 文件名: segmentSplit.ts
 * 描述: 多段合并送翻时的**分隔标记**处理（纯函数，便于单独验证 —— 与 lib/menuPosition.ts 同套路）
 *
 * 背景：大模型协议一次翻多段，是把各段用标记拼成一段发出去，再把译文按标记切回各段
 * （机器翻译协议不需要这套，接口本身保证顺序）。这套切分是全链路里最容易出错的地方：
 * 切错位就等于把 A 段的译文贴到 B 段下面，而界面上看不出「错位」、只看到一句不通顺的话。
 *
 * 两种用途，规则不同，所以分成两个函数：
 * - splitSegments：**完成时**用，要求段数完全一致，对不上就返回 null 让调用方回退逐段翻译；
 * - splitPartialSegments：**流式过程中**用，只做「尽力切分」，因为最后一段往往还没写完。
 */

/** 分隔标记的字面量：显眼、不易与正文内容撞车 */
export const SEGMENT_MARK = "@@@RSS-SEG@@@";

/**
 * 认出分隔标记的两种写法：模型可能给它加空格、或写成更少的花括号
 * （提示词里要求原样保留，但模型偶尔会「顺手规整」一下）。
 */
export const SEGMENT_PATTERNS = [/\s*@{2,}\s*RSS-SEG\s*@{2,}\s*/, /\s*RSS-SEG\s*/];

/**
 * 把一次批量请求的译文按标记切回各段（**完成时**用）。
 * 切不出期望段数就返回 null，由调用方回退逐段翻译。
 */
export function splitSegments(output: string, expected: number): string[] | null {
  for (const re of SEGMENT_PATTERNS) {
    const parts = output
      .split(re)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (parts.length === expected) return parts;
  }
  return null;
}

/**
 * 流式过程中的「尽力切分」：不要求段数匹配（最后一段往往还没写完），返回已切出的各段。
 * 未出现任何标记时返回单元素数组（整段属于第一块）。
 */
export function splitPartialSegments(text: string): string[] {
  for (const re of SEGMENT_PATTERNS) {
    const parts = text.split(re);
    if (parts.length > 1) return parts;
  }
  return [text];
}

/**
 * 末尾可能是刚写了一半的分隔标记（如 `@@@RSS-S`），先切掉 ——
 * 否则流式过程中会在段落末尾闪出一截乱码，等标记写全了又消失。
 */
export function trimPartialMarker(part: string): string {
  for (let n = Math.min(part.length, SEGMENT_MARK.length - 1); n > 0; n -= 1) {
    if (part.endsWith(SEGMENT_MARK.slice(0, n))) return part.slice(0, -n);
  }
  return part;
}
