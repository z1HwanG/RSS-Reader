/**
 * RSS Reader 的共享类型定义（与 Rust 侧 DTO 保持一致，字段名与 Rust snake_case 对齐）。
 */

/** 订阅源分组 */
export interface Group {
  /** 分组唯一 ID */
  id: string;
  /** 分组名称 */
  name: string;
}

/** 一条订阅源 */
export interface Feed {
  /** 唯一 ID（URL 的 hash） */
  id: string;
  /** 订阅源 URL */
  url: string;
  /** 源标题 */
  title: string;
  /** 源描述 */
  description: string | null;
  /** 站点链接 */
  site_url: string | null;
  /** 订阅时间（ISO 时间戳） */
  added_at: string;
  /** 所属分组 ID（无分组为 null） */
  group_id: string | null;
  /** 分组内排序序号 */
  sort_order: number;
  /** 文章打开方式：null=内部阅读，"external"=外部浏览器 */
  open_method: string | null;
  /** 上次**成功**刷新时间（ISO 8601）。null = 从未成功刷新过 */
  last_success_at?: string | null;
  /** 最近一次刷新的失败原因。null / 缺省 = 当前没有错误 */
  last_error?: string | null;
  /** 连续失败次数：成功一次清零。用来区分「偶发网络抖动」与「真的是坏源」 */
  fail_count?: number;
}

/** 文章附带的媒体资源（RSS enclosure / MediaRSS / JSON Feed 附件 / Atom 媒体链接） */
export interface MediaItem {
  /** 资源地址 */
  url: string;
  /** MIME 类型（可能缺失，前端按扩展名兜底判断） */
  content_type?: string | null;
  /** 资源标题 */
  title?: string | null;
  /** 字节大小 */
  size?: number | null;
  /** 时长（秒） */
  duration_secs?: number | null;
  /** 宽度（像素） */
  width?: number | null;
  /** 高度（像素） */
  height?: number | null;
  /**
   * 可直接内嵌的播放器地址（正文里的 Bilibili / YouTube 等 iframe 嵌入）。
   * 有值时按嵌入播放器渲染；为空表示只能开浏览器（平台观看页或禁止内嵌）。
   */
  embed_src?: string | null;
  /** 嵌入平台名（Bilibili / YouTube / …） */
  embed_platform?: string | null;
}

/** 一篇文章 */
export interface Article {
  /** 唯一 ID（源 ID + 条目 ID 的组合 hash） */
  id: string;
  /**
   * 生成 id 用的条目标识（Rust 侧 feed-rs 的 entry.id）。
   * 订阅源 URL 变更后需要按新 feed_id 重算 id，靠它还原原始标识；
   * 旧数据（schema_version < 2）缺该字段，退化按 link / title 匹配。
   */
  entry_key?: string | null;
  /** 所属订阅源 ID */
  feed_id: string;
  /** 标题 */
  title: string | null;
  /**
   * 正文内容。HTML / XHTML 是标记文本；text/plain、text/markdown 按原文保存，
   * 由 ArticleView 依据 content_type 决定渲染方式。
   */
  content: string | null;
  /**
   * 正文纯文本预览（前 300 字符，Rust 抓取落盘正文时生成）。
   * 列表预览与搜索兜底用 —— 正文本体分离存储后不再随元数据下发。
   */
  preview?: string | null;
  /** 正文内容类型（MIME，如 text/html、text/plain、text/markdown）；旧数据缺失按 HTML 处理 */
  content_type?: string | null;
  /** 正文之外另存的摘要文本（仅供预览与「正文即摘要」提示） */
  summary?: string | null;
  /** 作者（多人以「、」连接） */
  author?: string | null;
  /** 标签 / 分类 */
  categories?: string[];
  /** 缩略图地址 */
  thumbnail?: string | null;
  /** 媒体附件（图片 / 音频 / 视频 / 文档） */
  media?: MediaItem[];
  /** 原文链接 */
  link: string | null;
  /** 发布日期（ISO 时间戳，可能为空） */
  published_at: string | null;
  /** 是否已读 */
  read: boolean;
  /** 是否收藏 */
  starred: boolean;
}

/**
 * 跨次抓取稳定去重的键：优先用 Rust 侧给的 entry 标识（与文章 id 同源），
 * 旧数据没有 entry_key 时退化为原文链接；两者都缺时用「标题 + 发布时间」兜底。
 * 返回 null 表示无法稳定识别（既无标识也无标题），此时不做去重。
 */
export function articleKey(article: Article): string | null {
  if (article.entry_key) return `k:${article.entry_key}`;
  if (article.link) return `l:${article.link}`;
  if (article.title) return `t:${article.title}|${article.published_at ?? ""}`;
  return null;
}

/** 应用状态（本地持久化） */
export interface AppState {
  /** 状态文件结构版本（由 Rust 侧写入与迁移，前端只透传） */
  schema_version?: number;
  feeds: Feed[];
  articles: Article[];
  groups: Group[];
}

/** 抓取订阅源的中间结果（每次都是全量抓取，没有 304 / 条件请求分支） */
export interface FetchResult {
  feed_id: string;
  feed_title: string;
  feed_description: string | null;
  feed_site_url: string | null;
  articles: Article[];
}

/** 代理配置 */
export interface ProxyConfig {
  enabled: boolean;
  host: string | null;
  port: number | null;
  /** 代理类型：缺省/"http" = HTTP 代理；"socks5" = SOCKS5 代理 */
  kind?: string | null;
}

/**
 * 翻译 Provider 支持的协议类型。
 * - openai-completions：OpenAI 兼容 Chat Completions（DeepSeek / 通义 / 本地 Ollama 等）
 * - openai-responses：OpenAI Responses API
 * - anthropic-messages：Anthropic Messages API
 * - microsoft-translator / google-translate / deepl：机器翻译接口（没有模型、没有提示词，
 *   一次请求可带多段并按顺序返回译文，逐段对应由接口保证）
 */
export type TranslateProtocol =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "microsoft-translator"
  | "google-translate"
  | "deepl"
  | "tencent-tmt";

/** 协议说明：下拉标签 + 两种提示文案 + 是否机器翻译接口（无模型） */
export interface ProtocolInfo {
  /** 协议下拉里的标签 */
  label: string;
  /** API 地址下方的提示（按协议补全的路径 / 推荐填的根地址） */
  apiHint: string;
  /** API 密钥下方的提示（去哪拿密钥） */
  keyHint: string;
  /** 机器翻译接口：没有模型这个概念，模型目录整块不显示 */
  machine: boolean;
}

/**
 * 各协议的说明文案（设置页与文章页共用，避免两处各写一份）。
 *
 * 只写「不写就会配错」的信息，能省则省：
 * - 空串表示这项不用提示（渲染处会跳过空提示）；
 * - 路径补全规则不再重复 —— 协议标签本身已经写着 `/chat/completions` 这类路径；
 * - 密钥提示只在**必填或有格式要求**时给，其余统一「仅保存在本机」。
 */
export const PROTOCOL_INFO: Record<TranslateProtocol, ProtocolInfo> = {
  "openai-completions": {
    label: "Chat Completions (/chat/completions)",
    apiHint: "",
    keyHint: "仅保存在本机",
    machine: false,
  },
  "openai-responses": {
    label: "Responses (/responses)",
    apiHint: "",
    keyHint: "仅保存在本机",
    machine: false,
  },
  "anthropic-messages": {
    label: "Anthropic Messages (/v1/messages)",
    apiHint: "",
    keyHint: "仅保存在本机",
    machine: false,
  },
  "microsoft-translator": {
    label: "微软翻译",
    apiHint: "免密钥通道走固定端点，地址不用填",
    keyHint: "可留空：走免密钥通道",
    machine: true,
  },
  "google-translate": {
    label: "谷歌翻译",
    apiHint: "免密钥通道走固定端点，地址不用填",
    keyHint: "可留空；免密钥通道国内需代理",
    machine: true,
  },
  deepl: {
    label: "DeepL",
    apiHint: "免费版 api-free.deepl.com，专业版 api.deepl.com",
    keyHint: "必填，免费版密钥以 :fx 结尾",
    machine: true,
  },
  "tencent-tmt": {
    label: "腾讯翻译",
    apiHint: "固定接口，地址不用填",
    keyHint: "必填，格式 SecretId:SecretKey",
    machine: true,
  },
};

/**
 * 免密钥专用：微软 / 谷歌只走各自的**网页版接口**（不是给第三方用的公开 API）。
 *
 * 这两个服务已经不需要、也不接受 API 密钥了（官方接口那条路已废弃）：
 * 它们在设置页里不出现（没有密钥可填、没有地址可改），只在文章页面的翻译器里供选择。
 * 代价是这两条通道都没文档、按 IP 限流、随时可能失效 —— 所以它们只当「零配置的现成选项」，
 * 要稳定、要额度就换 DeepL 或自己配一个大模型服务商。
 * 微软：Edge 浏览器翻译那条；谷歌：网页版 translate_a/single。
 */
export const KEYLESS_PROTOCOLS: readonly TranslateProtocol[] = [
  "microsoft-translator",
  "google-translate",
];

/** 该协议是否免密钥专用（不支持也不要密钥；设置页里不显示这类服务） */
export function supportsKeyless(protocol: TranslateProtocol): boolean {
  return KEYLESS_PROTOCOLS.includes(protocol);
}

/** 是否机器翻译接口（微软 / 谷歌 / DeepL / 腾讯翻译）：这类协议不需要模型，也不需要提示词 */
export function isMachineTranslate(protocol: TranslateProtocol): boolean {
  return PROTOCOL_INFO[protocol].machine;
}

/** 协议标签（列表里显示，如「DeepL」） */
export function protocolLabel(protocol: TranslateProtocol): string {
  return PROTOCOL_INFO[protocol].label;
}


/**
 * 模型目录里的单个模型条目（前端 camelCase）。
 * 除模型 ID 外，每个模型可单独声明自己的能力参数：
 * - contextWindow：上下文窗口（token），仅作展示与参考，不参与请求；
 * - maxOutputTokens：最大输出 token，>0 时作为请求的 max_tokens 发出（Anthropic 协议必填，
 *   未设置时回退 4096），0 表示交给服务端默认。
 */
export interface TranslateModel {
  /** 模型 ID（请求体里的 model 字段） */
  id: string;
  /** 显示名（列表里给人看的名字；留空时回退显示 id） */
  displayName: string;
  /** 上下文窗口（token；0 = 未设置） */
  contextWindow: number;
  /** 最大输出 token（0 = 不指定，由服务端默认） */
  maxOutputTokens: number;
}

/** 发往 Rust 的模型条目形态（snake_case 字段） */
export interface TranslateModelRust {
  id: string;
  display_name: string;
  context_window: number;
  max_output_tokens: number;
}

/** 单个服务提供商（前端 camelCase；发后端时转 snake_case，与 Rust TranslateProvider 对齐） */
export interface TranslateProvider {
  /** Provider ID：小写标识，全配置唯一，用于派生凭据名 */
  providerId: string;
  /** 显示名（用户可读） */
  displayName: string;
  /** API 地址（如 https://gateway.example/v1，Rust 侧按协议补全路径） */
  apiUrl: string;
  /** 协议类型 */
  protocol: TranslateProtocol;
  /** API 密钥（敏感，落盘 app 数据目录，不随 UI 状态丢失） */
  apiKey: string;
  /** 当前选中模型（对应模型目录里的某个条目 id；在文章页面切换） */
  model: string;
  /** 模型目录（可自动获取 / 自定义添加 / 编辑；每条含自己的参数） */
  models: TranslateModel[];
  /** 是否当前激活的 Provider（在设置页点击 Provider 即激活） */
  isActive: boolean;
  /**
   * 是否关闭模型的思考模式（DeepSeek 等推理模型）。
   * DeepSeek 官方 API 的思考模式默认开启、effort 默认 high，翻译这类变换任务会白等一整段
   * 思维链；打开后请求体带上 `thinking:{type:"disabled"}`。
   * 默认 false（不干预）—— 非 DeepSeek 的 OpenAI 兼容网关可能不认这个字段，必须显式开启。
   */
  disableThinking: boolean;
}

/** 完整翻译配置：Provider 列表 + 激活项 + 语言（持久化到 app 数据目录） */
export interface TranslateConfig {
  providers: TranslateProvider[];
  /** 当前激活的 Provider ID（providers 为空时为 null；在文章页面选择） */
  activeProviderId: string | null;
  /** 源语言（"自动检测" = 交给模型判断） */
  sourceLang: string;
  /** 目标语言描述（如 "简体中文" / "English"） */
  targetLang: string;
  /**
   * 已经提供过（并让用户见过）的内置 Provider ID。
   * 旧版本用它做「内建项只在没被见过时补进列表」；现在内置项一律由应用保证存在、
   * 设置页里也没有删除入口，所以这个字段只作为旧配置的遗留数据保留，不再参与判断。
   */
  knownBuiltins: string[];
}

/** 翻译一段文本的请求（与 Rust 侧 TranslateRequest 对齐；provider 为 snake_case 字段） */
export interface TranslateRequest {
  /** 待翻译文本（单段） */
  text: string;
  /** 源语言（"自动检测" 时由模型判断） */
  source: string;
  /** 目标语言描述 */
  target: string;
  /** 所属文章标题等上下文：让模型知道这是文中的一段，别把它当成要展开写作的题目 */
  context?: string;
  /** 多段合并送翻时的分隔标记（snake_case，与 Rust 对齐）：要求模型原样保留，前端据此切回各段 */
  segment_marker?: string;
  /**
   * 流式输出的通道 id（snake_case，与 Rust 对齐）。给出时 Rust 侧走 SSE，
   * 把累计译文用 `translate-delta` 事件推回（载荷 { id, text }），前端按 id 分派。
   * 多批次并发时每个请求一个 id，各自的增量不会串。
   */
  stream_id?: string;
  /** 当前激活的 Provider（snake_case 字段，含 api_url / protocol / api_key / model） */
  provider: TranslateProviderRust;
}

/**
 * 一次翻译多段的请求（机器翻译接口专用，与 Rust 侧 TranslateBatchRequest 对齐）。
 * 段落对应关系由接口保证（返回顺序与入参一致），比「拼成分隔标记再猜着切开」可靠；
 * 各家底层是不是真能一次带多段由 Rust 侧决定（腾讯云一次只翻一段，那边逐段发）。
 */
export interface TranslateBatchRequest {
  texts: string[];
  source: string;
  target: string;
  provider: TranslateProviderRust;
}

/** 发往 Rust 的 Provider 形态（snake_case 字段，与 Rust TranslateProvider 结构对齐） */
export interface TranslateProviderRust {
  provider_id: string;
  display_name: string;
  api_url: string;
  protocol: TranslateProtocol;
  api_key: string;
  model: string;
  models: TranslateModelRust[];
  is_active: boolean;
  /** 关闭模型思考模式（DeepSeek 等推理模型；缺省 false） */
  disable_thinking: boolean;
}

/** 完整翻译配置（snake_case，Rust 侧 TranslateConfig 的持久化形态；load_translate_config 返回它） */
export interface TranslateConfigRust {
  providers: TranslateProviderRust[];
  active_provider_id: string | null;
  source_lang: string | null;
  target_lang: string | null;
  known_builtins?: string[];
}

/** 可选语言（源语言多一个「自动检测」；目标语言不需要它） */
export const LANGUAGE_OPTIONS = [
  "简体中文",
  "繁体中文",
  "English",
  "日本語",
  "한국어",
  "Français",
  "Deutsch",
  "Español",
  "Русский",
];

/** 源语言选项：在语言列表前加「自动检测」 */
export const SOURCE_LANGUAGE_OPTIONS = ["自动检测", ...LANGUAGE_OPTIONS];

export const DEFAULT_SOURCE_LANG = "自动检测";
export const DEFAULT_TARGET_LANG = "简体中文";

/** 翻译配置的默认值（空 Provider 列表 + 默认语言；内置 Provider 由服务层注入） */
export const DEFAULT_TRANSLATE_CONFIG: TranslateConfig = {
  providers: [],
  activeProviderId: null,
  sourceLang: DEFAULT_SOURCE_LANG,
  targetLang: DEFAULT_TARGET_LANG,
  knownBuiltins: [],
};

/** 内置 Provider 的定义（首次使用时自动出现在网关列表里，填个密钥就能用） */
interface BuiltinProviderDef {
  providerId: string;
  displayName: string;
  apiUrl: string;
  protocol: TranslateProtocol;
}

/**
 * 内置的三个机器翻译服务。
 *
 * 都不需要模型（逐段对应由接口保证，不会出现「模型把标题当题目自己写一篇」），
 * 对大模型服务商是很好的补充。三类用法不同：
 * - 微软 / 谷歌：免密钥专用，不用配任何东西就能用 —— 所以在设置页里不显示，
 *   只在文章页面的翻译器里作为现成选项出现（apiUrl 只是留档，实际走的是网页版固定端点）；
 * - DeepL：必须填密钥，所以在设置页里可编辑（改地址 / 填密钥）；
 * - 腾讯翻译：必须填密钥对（SecretId:SecretKey），地址固定。
 * 后两者在设置页里显示但**不可删除、不可拖动**（内置服务由应用保证存在）。
 */
export const BUILTIN_PROVIDERS: readonly BuiltinProviderDef[] = [
  {
    providerId: "microsoft",
    displayName: "微软翻译",
    apiUrl: "https://api.cognitive.microsofttranslator.com",
    protocol: "microsoft-translator",
  },
  {
    providerId: "google",
    displayName: "谷歌翻译",
    apiUrl: "https://translation.googleapis.com",
    protocol: "google-translate",
  },
  {
    providerId: "deepl",
    displayName: "DeepL",
    apiUrl: "https://api-free.deepl.com",
    protocol: "deepl",
  },
  {
    providerId: "tencent",
    displayName: "腾讯翻译",
    apiUrl: "https://tmt.tencentcloudapi.com",
    protocol: "tencent-tmt",
  },
];

/** 造一个内置 Provider 实例（每次返回新对象，避免调用方共享同一份可变状态） */
export function makeBuiltinProvider(def: BuiltinProviderDef): TranslateProvider {
  return {
    providerId: def.providerId,
    displayName: def.displayName,
    apiUrl: def.apiUrl,
    protocol: def.protocol,
    apiKey: "",
    model: "",
    models: [],
    isActive: false,
    disableThinking: false,
  };
}

/** 创建单个 Provider 的工厂（新建时用默认值） */
export function makeProvider(): TranslateProvider {
  return {
    providerId: "",
    displayName: "",
    apiUrl: "",
    protocol: "openai-completions",
    apiKey: "",
    model: "",
    models: [],
    isActive: false,
    disableThinking: false,
  };
}

/** 创建单个模型条目的工厂 */
export function makeModel(id = ""): TranslateModel {
  return { id, displayName: "", contextWindow: 0, maxOutputTokens: 0 };
}

/**
 * 由显示名派生 Provider ID：转小写、空白与下划线转连字符，只保留 [a-z0-9-]。
 * 中文等非 ASCII 字符会被滤掉；结果为空时返回空串，由调用方决定回退（保留原名或随机 ID）。
 * @param taken 已被占用的 ID：同名派生结果自动加 -2、-3 后缀，避免撞车
 */
export function deriveProviderId(displayName: string, taken: readonly string[] = []): string {
  const base = displayName
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) return "";
  let candidate = base;
  let n = 2;
  while (taken.includes(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

/** 旧版单配置的 localStorage 键（迁移到多 Provider 时读取） */
export const LEGACY_TRANSLATE_STORAGE_KEY = "rss-reader-translate-config";