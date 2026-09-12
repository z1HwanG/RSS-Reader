/*
 * 文件名: shareService.ts
 * 描述: 分享服务 — 把一篇文章转成各种可分享的形态（纯链接 / Markdown / 纯文本 / 文件），
 *       并执行分享动作（剪贴板、系统邮件客户端、社交平台、保存 Markdown 文件）。
 *
 * 构造与副作用分开：构造部分是纯函数（输出可以直接核对），副作用统一走 rssService
 * （外链交给 opener 插件，文件写入复用 OPML 导出那条 write_file_text 通道，不新增后端命令）。
 */
import { save as showSaveDialog } from "@tauri-apps/plugin-dialog";
import { looksLikeHtml } from "../../../lib/contentRender";
import type { Article, Feed } from "../types";
import * as rssService from "./rssService";

/** 分享面板里的动作标识 */
export type ShareActionId =
  | "link"
  | "markdown"
  | "text"
  | "mail"
  | "x"
  | "weibo"
  | "file";

/** 纯文本摘要的默认长度：粘到聊天窗口不该变成刷屏长文 */
const SUMMARY_LIMIT = 180;
/** 邮件正文的长度上限：mailto 链接过长会被客户端截断 */
const MAIL_BODY_LIMIT = 800;
/** 保存成文件时可以多留一点上下文 */
const FILE_SUMMARY_LIMIT = 400;

/** 去掉标签取正文文本：分享出去的正文不该夹带 HTML */
function htmlToPlainText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style").forEach((el) => el.remove());
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** 正文的纯文本形态（摘要字段为空时的兜底来源；分离存储后用落盘时生成的预览） */
function bodyPlainText(article: Article): string {
  const raw = (article.content ?? "").trim();
  if (raw) {
    const text = looksLikeHtml(raw) ? htmlToPlainText(raw) : raw;
    return text.replace(/\s+/g, " ").trim();
  }
  return (article.preview ?? "").replace(/\s+/g, " ").trim();
}

/** 折叠空白并截断（截断处补省略号） */
function truncate(text: string, limit: number, ellipsis = "…"): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit).trimEnd()}${ellipsis}`;
}

/** 分享用标题：无标题文章给占位，避免分享出空文本 */
export function shareTitle(article: Article): string {
  return (article.title ?? "").trim() || "（无标题）";
}

/** 分享用摘要：优先订阅源给的 summary，其次正文开头 */
export function shareSummary(article: Article, limit = SUMMARY_LIMIT): string {
  const summary = (article.summary ?? "").trim();
  return truncate(summary || bodyPlainText(article), limit);
}

/** 分享用时间：本地时区，精确到分钟 */
export function shareTime(article: Article): string {
  if (!article.published_at) return "";
  const ts = Date.parse(article.published_at);
  if (Number.isNaN(ts)) return "";
  return new Date(ts).toLocaleString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 纯链接（没有链接时返回空串，调用方据此禁用相关动作） */
export function buildLink(article: Article): string {
  return article.link ?? "";
}

/** Markdown 行内链接：[标题](链接) —— 粘进笔记 / issue / 论坛直接可用 */
export function buildMarkdownLink(article: Article): string {
  const title = shareTitle(article).replace(/[[\]]/g, "");
  return article.link ? `[${title}](${article.link})` : title;
}

/** 纯文本分享块：标题 + 摘要 + 来源 + 链接，粘到聊天窗口就能读 */
export function buildTextShare(article: Article, feed: Feed | null): string {
  const lines: string[] = [shareTitle(article)];
  const summary = shareSummary(article);
  if (summary) lines.push("", summary);
  const meta = [feed?.title, shareTime(article)].filter(Boolean).join(" · ");
  if (meta) lines.push("", meta);
  if (article.link) lines.push(article.link);
  return lines.join("\n");
}

/** Markdown 文件内容：元信息走引用块，正文给摘要（不搬整篇正文，避免把订阅源 HTML 原样倒进文件） */
export function buildMarkdownDoc(article: Article, feed: Feed | null): string {
  const meta: string[] = [];
  if (feed?.title) meta.push(`> 来源：${feed.title}`);
  if (article.author) meta.push(`> 作者：${article.author}`);
  const time = shareTime(article);
  if (time) meta.push(`> 发布时间：${time}`);
  if (article.link) meta.push(`> 原文：<${article.link}>`);
  const tags = (article.categories ?? []).slice(0, 12);
  if (tags.length > 0) meta.push(`> 标签：${tags.join("、")}`);

  const parts: string[] = [`# ${shareTitle(article)}`, ""];
  if (meta.length > 0) parts.push(...meta, "");
  const summary = shareSummary(article, FILE_SUMMARY_LIMIT);
  if (summary) parts.push(summary, "");
  return `${parts.join("\n").trimEnd()}\n`;
}

/** Windows 文件名安全化：去掉非法字符、压掉空白、限长 */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "article").slice(0, 60);
}

/** 复制到剪贴板（走 WebView 原生 API，不需要额外的剪贴板插件权限） */
export async function copyText(text: string): Promise<void> {
  if (!text) throw new Error("没有可复制的内容");
  await navigator.clipboard.writeText(text);
}

/**
 * 保存为 Markdown 文件。
 * @returns 保存路径；用户在对话框里取消时返回 null。
 */
export async function saveAsMarkdownFile(
  article: Article,
  feed: Feed | null,
): Promise<string | null> {
  const target = await showSaveDialog({
    defaultPath: `${safeFileName(shareTitle(article))}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (!target) return null;
  await rssService.writeFileText(target, buildMarkdownDoc(article, feed));
  return target;
}

/** 用系统默认邮件客户端分享（主题=文章标题，正文=纯文本分享块） */
export function shareByEmail(article: Article, feed: Feed | null): Promise<void> {
  const subject = shareTitle(article);
  // mailto 的换行要写成 CRLF，部分邮件客户端只认这一种
  const body = truncate(buildTextShare(article, feed), MAIL_BODY_LIMIT, "").replace(/\n/g, "\r\n");
  return rssService.openExternal(
    `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
  );
}

/** 分享到 X：打开网页版推文编辑框（桌面端没有系统级分享面板可用） */
export function shareToX(article: Article): Promise<void> {
  const text = encodeURIComponent(shareTitle(article));
  const url = encodeURIComponent(article.link ?? "");
  return rssService.openExternal(`https://twitter.com/intent/tweet?text=${text}&url=${url}`);
}

/** 分享到微博：打开微博官方分享页 */
export function shareToWeibo(article: Article): Promise<void> {
  const url = encodeURIComponent(article.link ?? "");
  const title = encodeURIComponent(shareTitle(article));
  return rssService.openExternal(
    `https://service.weibo.com/share/share.php?url=${url}&title=${title}`,
  );
}
