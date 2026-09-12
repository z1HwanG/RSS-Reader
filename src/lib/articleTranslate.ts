/*
 * 文件名: articleTranslate.ts
 * 描述: 逐段对照翻译的两半逻辑（纯函数，输入输出都是 HTML 字符串）：
 *   1) extractTranslatableBlocks —— 从渲染后的正文 HTML 里按文档顺序取出「可翻译的块」；
 *   2) interleaveTranslations —— 把译文按同样顺序插回每块之后，得到「原文 + 译文」交替的 HTML。
 *
 * 为什么要按块而不是整篇翻：整篇翻完只能把译文堆在文末，读者得来回对照；
 * 按块插回才能做到「一段原文、一段译文」紧挨着看（参考双语对照阅读）。
 *
 * 两个函数必须用**同一套遍历顺序与同一套跳过规则**，否则译文会错位到别的段落上。
 */

/** 可翻译的块级元素：标题 / 段落 / 列表项 / 引用 / 图注 */
const TRANSLATABLE_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,dd,dt";

/** 插进去的译文元素统一带这个类（绿色、贴近上一段） */
export const TRANSLATION_LINE_CLASS = "article-translation-line";

/** 某段翻译失败时留下的占位元素类名（让用户看得出是哪段没翻出来，而不是凭空少一行） */
export const TRANSLATION_FAILED_CLASS = "article-translation-failed";

/**
 * 这一块是否值得翻译。
 * 纯数字、纯符号、空白都没有翻译价值；要求至少含一个字母或汉字。
 */
export function shouldTranslateBlock(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 2) return false;
  return /\p{L}/u.test(t);
}

/** 块的纯文本（压缩空白，作为送翻的内容） */
function blockText(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** 代码块里的内容不翻译（原样保留更安全） */
function insideCode(el: Element): boolean {
  return el.closest("pre, code") !== null;
}

/** 按文档顺序收集可翻译块（与 interleaveTranslations 的遍历完全一致） */
function collectTranslatable(html: string): Element[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: Element[] = [];
  doc.body.querySelectorAll(TRANSLATABLE_SELECTOR).forEach((el) => {
    // 嵌套块（li 里的 p、引用里的 p）只翻最外层，避免同一段文字被翻两次
    if (el.querySelector(TRANSLATABLE_SELECTOR) !== null) return;
    if (insideCode(el)) return;
    if (!shouldTranslateBlock(blockText(el))) return;
    out.push(el);
  });
  return out;
}

/** 取出待翻译的块文本（顺序与 interleaveTranslations 的插入顺序一致） */
export function extractTranslatableBlocks(html: string): string[] {
  return collectTranslatable(html).map(blockText);
}

/** 造一个承载译文的元素：标题沿用同级标签（保住字号），其余用段落 */
function makeTranslationEl(doc: Document, source: Element, text: string): Element {
  const tag = source.tagName.toUpperCase();
  const el = /^H[1-6]$/.test(tag) ? doc.createElement(tag.toLowerCase()) : doc.createElement("p");
  el.className = TRANSLATION_LINE_CLASS;
  // 用 textContent 赋值：译文里的尖括号等不会被当成标记
  el.textContent = text;
  return el;
}

/**
 * 把译文插回每块之后，返回合并后的 HTML。
 * @param translations 与 extractTranslatableBlocks 一一对应；null / 空串表示这一段还没有译文
 * @param failedIndexes 已判定翻译失败的块（会在原位插一条灰色占位说明）。
 *        与「还没翻到」区分开：后者只是不插，避免翻译途中满屏占位。
 */
export function interleaveTranslations(
  html: string,
  translations: readonly (string | null)[],
  failedIndexes?: ReadonlySet<number>,
): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const blocks: Element[] = [];
  doc.body.querySelectorAll(TRANSLATABLE_SELECTOR).forEach((el) => {
    if (el.querySelector(TRANSLATABLE_SELECTOR) !== null) return;
    if (insideCode(el)) return;
    if (!shouldTranslateBlock(blockText(el))) return;
    blocks.push(el);
  });
  blocks.forEach((el, index) => {
    const text = (translations[index] ?? "").trim();
    const failed = !text && (failedIndexes?.has(index) ?? false);
    if (!text && !failed) return;
    const line = makeTranslationEl(doc, el, text || "（本段未能翻译）");
    if (failed) line.className = TRANSLATION_FAILED_CLASS;
    if (el.tagName.toUpperCase() === "LI") {
      // 列表项：译文放进同一个 li 里，作为该项的第二行（不新增一个子弹点）
      el.appendChild(line);
    } else {
      el.after(line);
    }
  });
  return doc.body.innerHTML;
}
