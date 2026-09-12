/*
 * 文件名: translateService.ts
 * 描述: AI 翻译服务 — 多 Provider 网关的配置读写 + 翻译调用封装。
 *
 * 流程：正文 HTML → 按块取出待翻段落（见 lib/articleTranslate.ts）→ 按批调 Rust：
 * 大模型协议走 translate_text（Rust 侧按协议分发到 OpenAI Completions / Responses /
 * Anthropic Messages，复用应用代理），机器翻译协议（微软 / 谷歌 / DeepL）走 translate_texts
 * （一次带多段、按顺序返回，逐段对应由接口保证）→ 译文按块插回原文之后，形成逐段对照。
 *
 * 设计要点：
 * 1. 配置为多 Provider 列表（含激活项），持久化到 app 数据目录（Rust 侧 translate-config.json）。
 *    旧版单配置（baseUrl/apiKey/model）在加载时迁移为单个 Provider；
 *    内置的三个机器翻译网关（微软 / 谷歌 / DeepL）在首次加载时补进列表，填个密钥即可用；
 * 2. **段落不能错位**：大模型协议一次翻多段要靠分隔标记（见下），机器翻译协议则由接口保证；
 *    两者都按有限并发压总耗时，并向上暴露进度；
 * 3. 译文以 textContent 赋值插入（不拼 HTML 字符串），译文里的尖括号不会被当成标记。
 */
import { call } from "../../../lib/tauri";
import { listen } from "@tauri-apps/api/event";
import {
  SEGMENT_MARK,
  splitPartialSegments,
  splitSegments,
  trimPartialMarker,
} from "../../../lib/segmentSplit";
import {
  localStorageBackend,
  lookupTranslation,
  saveTranslation,
  translationCacheKey,
  type TranslationCacheBackend,
} from "../../../lib/translationCache";
import {
  BUILTIN_PROVIDERS,
  DEFAULT_TRANSLATE_CONFIG,
  LEGACY_TRANSLATE_STORAGE_KEY,
  isMachineTranslate,
  makeBuiltinProvider,
  makeModel,
  makeProvider,
  supportsKeyless,
  type TranslateBatchRequest,
  type TranslateConfig,
  type TranslateModel,
  type TranslateModelRust,
  type TranslateProtocol,
  type TranslateProvider,
  type TranslateProviderRust,
  type TranslateRequest,
  type TranslateConfigRust,
} from "../types";

// ===== 配置读写（Rust 侧读写 app 数据目录下的 translate-config.json）=====

/** 最近一次加载配置的失败原因（null = 正常）。设置页据此提示，避免把「读不到」误当「还没配」 */
let lastLoadError: string | null = null;

/**
 * 「文件还不存在」的报错标记（Rust 侧 load_translate_config 在没配过时返回它）。
 * 它**不是**读取失败：首次使用就是这种状态，得把它和「文件在却读不出来」分开
 * —— 后者不能再往磁盘上写，否则会把用户存好的配置覆盖掉。
 */
const NO_CONFIG_MARK = "尚未配置 AI 翻译";

/**
 * 最近一次读到/写过的配置。文章页面的选择（模型、语言）都是「读—改—写」整份配置：
 * 每次都重新读盘的话，连续两次改动之间一旦读到旧内容，前一次就会被盖掉。
 * 这里缓存最新一份，读改写始终基于最新状态（写盘成功后同步更新）。
 */
let cachedConfig: TranslateConfig | null = null;

/** 读取最近一次加载配置的失败原因 */
export function getLastLoadError(): string | null {
  return lastLoadError;
}

/**
 * 内置服务商注入：把缺的内置项补进列表，追加在**末尾**（不动用户已有条目的次序）。
 *
 * 三项内置服务一律由应用保证存在：设置页里已经没有它们的删除入口
 * （微软 / 谷歌连显示都没有；DeepL 显示但不可删），所以「缺了」只可能是历史遗留
 * （旧版本允许删除），补回来即可 —— 否则文章页面的翻译器里会凭空少一个选项。
 *
 * 注：配置里的 knownBuiltins 是旧版本「已经提供过就不再补」的记录，
 * 现在不再作为判断依据（保留字段只为兼容旧配置，不再维护）。
 */
function seedBuiltinProviders(config: TranslateConfig): {
  config: TranslateConfig;
  added: number;
} {
  const existing = new Set(config.providers.map((p) => p.providerId));
  const missing = BUILTIN_PROVIDERS.filter((def) => !existing.has(def.providerId));
  if (missing.length === 0) return { config, added: 0 };
  return {
    config: {
      ...config,
      providers: [...config.providers, ...missing.map(makeBuiltinProvider)],
    },
    added: missing.length,
  };
}

/** 读翻译配置（多 Provider 列表）；尚未配置或读取失败时迁移旧配置 / 返回默认 */
export async function loadTranslateConfig(): Promise<TranslateConfig> {
  try {
    const saved = await call<TranslateConfigRust>("load_translate_config");
    lastLoadError = null;
    const loaded: TranslateConfig = {
      providers: (saved.providers ?? []).map(rustToProvider),
      activeProviderId: saved.active_provider_id ?? null,
      sourceLang: saved.source_lang ?? DEFAULT_TRANSLATE_CONFIG.sourceLang,
      targetLang: saved.target_lang ?? DEFAULT_TRANSLATE_CONFIG.targetLang,
      knownBuiltins: saved.known_builtins ?? [],
    };
    const seeded = seedBuiltinProviders(loaded);
    cachedConfig = seeded.config;
    if (seeded.added > 0) {
      // 把注入结果落盘：内置网关的「已提供过」状态要记住，否则用户删掉后又会被塞回来。
      // 这里用底层写入（不广播变更）——本次加载的调用方本来就是来读配置的，再通知一遍只会自我循环。
      try {
        await writeConfig(seeded.config);
      } catch {
        // 写不进去不影响本次使用（下次加载会再补一遍）
      }
    }
    return cachedConfig;
  } catch (err) {
    // 尚未配置：尝试迁移旧版单配置，否则返回默认（注入内置网关）。
    // 但要记下原因——「文件不存在」和「文件在却读不出来」后果完全不同：
    // 后者若当成空配置再保存一次，就会把磁盘上好好存着的 Provider 覆盖掉。
    const reason = String(err);
    const missing = reason.includes(NO_CONFIG_MARK);
    lastLoadError = missing ? null : reason;
    cachedConfig = migrateLegacyConfig();
    if (missing) {
      // 首次使用：内置网关直接落盘，用户一进设置就能看到三个可用网关
      const seeded = seedBuiltinProviders(cachedConfig);
      cachedConfig = seeded.config;
      if (seeded.added > 0) {
        try {
          await writeConfig(seeded.config);
        } catch {
          // 同上：写不进去不影响本次使用
        }
      }
    }
    return cachedConfig;
  }
}

/** 取当前配置：优先用内存里的最新一份，没有才读盘（少一次 IPC，也避免基于旧内容改） */
async function currentConfig(): Promise<TranslateConfig> {
  return cachedConfig ?? (await loadTranslateConfig());
}

/** 迁移旧版单配置（localStorage 里的 baseUrl/apiKey/model/targetLang）为单个 Provider */
function migrateLegacyConfig(): TranslateConfig {
  try {
    const raw = window.localStorage.getItem(LEGACY_TRANSLATE_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_TRANSLATE_CONFIG, knownBuiltins: [] };
    const legacy = JSON.parse(raw) as Record<string, unknown>;
    if (typeof legacy.baseUrl !== "string" || !legacy.baseUrl) {
      return { ...DEFAULT_TRANSLATE_CONFIG, knownBuiltins: [] };
    }
    const p = makeProvider();
    p.providerId = typeof legacy.providerId === "string" ? legacy.providerId : "default";
    p.displayName = typeof legacy.displayName === "string" ? legacy.displayName : "默认服务";
    p.apiUrl = legacy.baseUrl;
    p.protocol =
      legacy.protocol === "openai-responses" || legacy.protocol === "anthropic-messages"
        ? legacy.protocol
        : "openai-completions";
    p.apiKey = typeof legacy.apiKey === "string" ? legacy.apiKey : "";
    p.model = typeof legacy.model === "string" ? legacy.model : "";
    p.isActive = true;
    return {
      providers: [p],
      activeProviderId: p.providerId,
      sourceLang: DEFAULT_TRANSLATE_CONFIG.sourceLang,
      targetLang: typeof legacy.targetLang === "string" ? legacy.targetLang : "简体中文",
      knownBuiltins: [],
    };
  } catch {
    return { ...DEFAULT_TRANSLATE_CONFIG, knownBuiltins: [] };
  }
}

/**
 * 配置变更订阅：保存成功后通知订阅者。
 * 文章页面的翻译选择器要跟着刷新——否则「先在文章页（那时还没配网关）、后去设置里加网关」
 * 这条最常见的顺序下，选择器永远不出现（它只在挂载时读过一次配置）。
 */
const configListeners = new Set<() => void>();

/** 订阅配置变更，返回取消订阅函数 */
export function onTranslateConfigChange(listener: () => void): () => void {
  configListeners.add(listener);
  return () => {
    configListeners.delete(listener);
  };
}

/** 只写盘、不广播（加载时的内置网关注入用它，避免自我循环） */
function writeConfig(config: TranslateConfig): Promise<void> {
  return call<void>("save_translate_config", { config: toRustConfig(config) });
}

/** 保存翻译配置到 Rust 侧（原子写入 app 数据目录；providers 转成 snake_case 字段） */
export async function saveTranslateConfig(config: TranslateConfig): Promise<void> {
  await writeConfig(config);
  // 写盘成功后同步内存缓存：后续的读—改—写基于这份最新状态
  cachedConfig = config;
  // 通知订阅者（文章页据此重新读取选择器数据）
  for (const listener of [...configListeners]) {
    try {
      listener();
    } catch {
      // 单个订阅者出错不影响其它订阅者与保存本身
    }
  }
}

/** 获取激活的 Provider；无 isActive 标记时按 activeProviderId 或取第一个 */
export function getActiveProvider(config: TranslateConfig): TranslateProvider | null {
  if (config.providers.length === 0) return null;
  const byFlag = config.providers.find((p) => p.isActive);
  if (byFlag) return byFlag;
  const byId = config.providers.find((p) => p.providerId === config.activeProviderId);
  return byId ?? config.providers[0] ?? null;
}

/**
 * 翻译配置是否可用。
 * - 大模型协议：要有地址 + 模型（本地服务可无 Key）；
 * - 机器翻译协议：没有模型；微软 / 谷歌的密钥可以留空（留空走免密钥通道），DeepL 必须有密钥。
 */
export function isTranslateConfigured(config: TranslateConfig): boolean {
  const p = getActiveProvider(config);
  if (p === null || p.apiUrl.trim().length === 0) return false;
  if (isMachineTranslate(p.protocol)) {
    return p.apiKey.trim().length > 0 || supportsKeyless(p.protocol);
  }
  return p.model.trim().length > 0;
}

/**
 * camelCase TranslateProvider → snake_case TranslateProviderRust。
 * 嵌套对象的字段名不会做 camelCase→snake_case 自动映射，必须显式转换；
 * 导出给设置页的「测试翻译」复用，避免各处手写字段漏项。
 */
export function providerToRust(p: TranslateProvider): TranslateProviderRust {
  return {
    provider_id: p.providerId,
    display_name: p.displayName,
    api_url: p.apiUrl.trim().replace(/\/+$/, ""),
    protocol: p.protocol,
    api_key: p.apiKey,
    model: p.model,
    // 还没填 ID 的空行不发往后端（否则会把无效条目持久化）
    models: p.models.filter((m) => m.id.trim().length > 0).map(toRustModel),
    is_active: p.isActive,
    disable_thinking: p.disableThinking,
  };
}

/** camelCase 模型条目 → snake_case 模型条目 */
function toRustModel(m: TranslateModel): TranslateModelRust {
  return {
    id: m.id.trim(),
    display_name: m.displayName.trim(),
    context_window: m.contextWindow,
    max_output_tokens: m.maxOutputTokens,
  };
}

/**
 * 归一化模型目录（容错）：
 * 后端返回的应是对象数组，但旧配置里可能是纯字符串数组，两种都接；
 * 缺字段补默认值，无有效 id 的条目丢弃。
 */
function normalizeModels(raw: unknown): TranslateModel[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): TranslateModel[] => {
    if (typeof entry === "string") return entry ? [makeModel(entry)] : [];
    if (!entry || typeof entry !== "object") return [];
    const r = entry as Partial<TranslateModelRust>;
    if (typeof r.id !== "string" || !r.id) return [];
    return [
      {
        id: r.id,
        displayName: typeof r.display_name === "string" ? r.display_name : "",
        contextWindow: typeof r.context_window === "number" ? r.context_window : 0,
        maxOutputTokens: typeof r.max_output_tokens === "number" ? r.max_output_tokens : 0,
      },
    ];
  });
}

/** 选择器里的一个可选条目：value 是模型 ID（机器翻译协议为空串），label 是给人看的名字 */
export interface TranslatePickerItem {
  value: string;
  label: string;
}

/** 选择器里的一个分组（= 一个服务商） */
export interface TranslatePickerGroup {
  providerId: string;
  displayName: string;
  /**
   * 机器翻译服务（微软 / 谷歌 / DeepL / 腾讯翻译）：没有模型可选，整组就是一条，
   * 列表里**不显示分组标题**（服务名就在那一条上），视觉上与模型条目同级。
   */
  machine: boolean;
  items: TranslatePickerItem[];
}

/** 文章页翻译选择器需要的状态：按 Provider 分组的可选条目 + 当前选择 + 语言 */
export interface TranslatePickerState {
  /** 按 Provider 分组：每组是一个下拉里的分组标题 + 该组的可选条目 */
  groups: TranslatePickerGroup[];
  /** 当前激活的 Provider（选中的那个条目所属） */
  activeProviderId: string | null;
  /** 当前模型 ID（机器翻译协议为 ""） */
  currentModel: string;
  /** 按钮上显示的名字（大模型 = 模型 ID，机器翻译 = 网关名） */
  currentLabel: string;
  /**
   * 有网关填了地址、却没有任何可选条目（典型：大模型网关还没添加模型）。
   * 文章页据此提示「未就绪」—— 但仅限这种确实缺东西的情况：
   * 内置的三个翻译服务只是还没填密钥时不该在文章页刷提示。
   */
  needsSetup: boolean;
  sourceLang: string;
  targetLang: string;
}

/**
 * 读文章页翻译选择器需要的状态（分组条目 + 语言）。
 * 未配置 / 读取失败时返回空分组（页面据此不显示选择器）。
 *
 * 机器翻译服务（微软 / 谷歌 / DeepL / 腾讯翻译）没有模型可选，列表里就是**一整条**：
 * 只显示服务名，不再挂一个「无需模型」的子项（那只是把同一件事说两遍）。
 * 注意：**用不了的**机器翻译服务不进列表（DeepL / 腾讯翻译没填密钥）—— 选了也只会得到
 * 一句 401 / 签名错；微软 / 谷歌免密钥，永远可用。
 * 排序：内置机器翻译服务置顶（按定义顺序），自建服务商排在后面。
 */
export async function loadTranslatePicker(): Promise<TranslatePickerState> {
  const config = await loadTranslateConfig();
  const active = getActiveProvider(config);
  const groups: TranslatePickerGroup[] = [];
  for (const p of config.providers) {
    const displayName = p.displayName || p.providerId;
    if (isMachineTranslate(p.protocol)) {
      // 免密钥的（微软 / 谷歌）永远可用；要密钥的缺密钥就别放进列表
      if (p.apiKey.trim().length === 0 && !supportsKeyless(p.protocol)) continue;
      groups.push({
        providerId: p.providerId,
        displayName,
        machine: true,
        // 标签刻意不含「翻译」二字：工具栏里按文字找「翻译」按钮时（探针 / 无障碍脚本），
        // 「直接翻译」会被误当成那个按钮
        items: [{ value: "", label: displayName }],
      });
      continue;
    }
    const items = p.models
      .filter((m) => m.id.trim().length > 0)
      .map((m) => ({ value: m.id, label: m.id }));
    if (items.length > 0) groups.push({ providerId: p.providerId, displayName, machine: false, items });
  }
  // 内置服务置顶：它们是「不用配就能用」的现成选项，排在自建服务商前面更容易找到。
  // sort 是稳定的，所以其余分组保持配置里的顺序。
  groups.sort((a, b) => pickerRank(a.providerId) - pickerRank(b.providerId));
  const activeIsMachine = active !== null && isMachineTranslate(active.protocol);
  return {
    groups,
    activeProviderId: active?.providerId ?? null,
    currentModel: active?.model ?? "",
    currentLabel: active ? (activeIsMachine ? active.displayName || active.providerId : active.model) : "",
    needsSetup:
      groups.length === 0 &&
      config.providers.some((p) => !isMachineTranslate(p.protocol) && p.apiUrl.trim().length > 0),
    sourceLang: config.sourceLang,
    targetLang: config.targetLang,
  };
}

/** 选择器里的排序权重：内置服务按定义顺序在前，其余排在后面（保持原有相对顺序）。 */
function pickerRank(providerId: string): number {
  const index = BUILTIN_PROVIDERS.findIndex((def) => def.providerId === providerId);
  return index === -1 ? BUILTIN_PROVIDERS.length : index;
}

/**
 * 选定「用哪个 Provider 的哪个模型」（文章页面的分组选择器调用）。
 * 一次定两件事：激活该 Provider + 用它的这个模型。配置是整份文件写盘，所以读出来改完整体写回。
 */
export async function selectTranslationTarget(
  providerId: string,
  modelId: string,
): Promise<void> {
  const config = await currentConfig();
  await saveTranslateConfig({
    ...config,
    activeProviderId: providerId,
    providers: config.providers.map((p) =>
      p.providerId === providerId
        ? { ...p, model: modelId, isActive: true }
        : { ...p, isActive: false },
    ),
  });
}

/** 设置源语言 / 目标语言（文章页面调用） */
export async function setTranslateLanguages(source: string, target: string): Promise<void> {
  const config = await currentConfig();
  await saveTranslateConfig({ ...config, sourceLang: source, targetLang: target });
}

/** snake_case Rust 结构 → camelCase TranslateProvider */
function rustToProvider(r: TranslateProviderRust): TranslateProvider {
  return {
    providerId: r.provider_id,
    displayName: r.display_name,
    apiUrl: r.api_url,
    protocol: r.protocol as TranslateProtocol,
    apiKey: r.api_key ?? "",
    model: r.model,
    models: normalizeModels(r.models),
    isActive: r.is_active ?? false,
    disableThinking: r.disable_thinking ?? false,
  };
}


/** 前端 TranslateConfig → 发后端的 TranslateConfigRust（snake_case 字段） */
function toRustConfig(config: TranslateConfig): TranslateConfigRust {
  return {
    providers: config.providers.map(providerToRust),
    active_provider_id: config.activeProviderId,
    source_lang: config.sourceLang,
    target_lang: config.targetLang,
    known_builtins: config.knownBuiltins ?? [],
  };
}

// ===== 翻译 =====

/** 调 Rust 侧 translate_text 翻译单段文本（大模型协议使用） */
function translateText(req: TranslateRequest): Promise<string> {
  return call<string>("translate_text", { request: req });
}

/** 调 Rust 侧 translate_texts 一次翻译多段（机器翻译协议使用；返回顺序与入参一致） */
function translateTexts(req: TranslateBatchRequest): Promise<string[]> {
  return call<string[]>("translate_texts", { request: req });
}

// ===== 翻译结果缓存 =====
// 主流翻译插件都按 (文本, 源, 目标) 键缓存结果，避免同一句话反复翻译（见 lib/translationCache.ts）。
// 划词翻译与整篇翻译共用同一份缓存：重翻文章、重选同一句都直接命中，秒回、不烧预算。
const TRANSLATION_CACHE_STORAGE_KEY = "rss-reader-translation-cache";
const translationCache: TranslationCacheBackend = localStorageBackend(TRANSLATION_CACHE_STORAGE_KEY);

/**
 * 带缓存的单段翻译：命中直接返回，未命中调用 translateText 并在成功后落缓存。
 * 缓存命中返回一个「已缓存」标记，调用方（如有需要）可据此提示来源。
 */
async function cachedTranslateText(
  text: string,
  source: string,
  target: string,
  context: string | undefined,
  provider: TranslateProviderRust,
): Promise<{ text: string; fromCache: boolean }> {
  const key = translationCacheKey(text, source, target);
  const hit = lookupTranslation(translationCache, key);
  if (hit !== null) return { text: hit, fromCache: true };
  const translated = await translateText({
    text,
    target,
    source,
    context,
    provider,
  });
  saveTranslation(translationCache, key, translated);
  return { text: translated, fromCache: false };
}

/**
 * 测试某个模型能不能真的用起来：发一段极短的翻译请求，服务端**真实返回**即算连通。
 *
 * 为什么要真发一次请求：地址写错、密钥无效、模型名不存在这三件事，只有让服务端回答才能分辨
 * —— 拉 /models 列表只能证明地址通，证明不了这个模型名可用。请求体只有一句 "Hello"，
 * 开销可以忽略。
 */
export async function testModel(
  provider: TranslateProvider,
  modelId: string,
): Promise<{ text: string; ms: number }> {
  const started = Date.now();
  const text = await translateText({
    text: "Hello",
    source: "English",
    target: "简体中文",
    provider: { ...providerToRust(provider), model: modelId },
  });
  return { text, ms: Date.now() - started };
}

/**
 * 逐块翻译的结果。
 * @property translations 与入参 blocks 一一对应；某块失败时为 null
 * @property failed 失败块数
 * @property firstError 第一个失败原因（全部失败时由调用方抛出，让用户看到真正的原因）
 */
export interface BlockTranslateResult {
  translations: (string | null)[];
  failed: number;
  firstError: unknown | null;
}

/**
 * 一批最多多少字符 / 多少段。
 * 批越大请求越少也越快：**推理模型每收到一个请求都要从头「想」一遍**，
 * 所以请求数比总输出量更影响总耗时。上限留得宽松些（6000 字 ≈ 常见长文一整屏），
 * 但仍留一条边界——太大时模型更容易把分隔标记弄丢（丢了会回退逐段翻，反而更慢）。
 */
const BATCH_MAX_CHARS = 6000;
const BATCH_MAX_BLOCKS = 20;

/**
 * 没填密钥的谷歌通道（网页版接口）**一次请求能带多段**（重复 q 参数，返回顺序一致），
 * 但它走的是 GET，批的上限因此是 URL 长度：中文一个字百分号编码后占 9 个字符，
 * 600 字约 5.4KB —— 留有余量（实测 ~6.3KB 仍正常，POST 不被接受）。
 * 批内一次发完，所以这里的批大小只影响「多少字挤进一个 URL」，不再影响请求数。
 */
const KEYLESS_GOOGLE_MAX_CHARS = 600;
const KEYLESS_GOOGLE_MAX_BLOCKS = 6;

/**
 * 批与批之间的并发数：同一时间最多几个请求在飞（太高容易触发服务端限流）。
 * 3 → 5：墙钟时间 ≈ (批数 / 并发数) × 单批延迟，而关掉思考后单批本身就快了，
 * 并发就成了主要瓶颈；5 对 DeepSeek 这类官方 API 仍在正常配额内。
 */
const BATCH_CONCURRENCY = 5;

/**
 * 腾讯翻译（TMT）一次请求只翻一段，前端发一批就等于在 Rust 里串成 N 次请求，
 * 而它是按 QPS 限流的，所以批切小些（10 段 / 3000 字），别一次轰太多。
 */
const TENCENT_MAX_CHARS = 3000;
const TENCENT_MAX_BLOCKS = 10;

/**
 * 把待翻块按顺序切成批次。
 * 不再把短块（标题）单独拆出来：那样每个标题都要独占一次请求，而它在推理模型上代价很高
 * （每请求都要想一遍）。标题的「不许扩写」改由提示词 + 文章标题上下文保证
 * （Rust 侧 build_translate_system：带分隔标记的请求一律要求「逐段对应、不要扩写」）。
 */
function buildBatches(
  blocks: readonly string[],
  maxChars = BATCH_MAX_CHARS,
  maxBlocks = BATCH_MAX_BLOCKS,
): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let size = 0;
  const flush = (): void => {
    if (current.length > 0) batches.push(current);
    current = [];
    size = 0;
  };
  blocks.forEach((text, index) => {
    const add = text.length + SEGMENT_MARK.length + 2;
    if (current.length > 0 && (size + add > maxChars || current.length >= maxBlocks)) {
      flush();
    }
    current.push(index);
    size += add;
  });
  flush();
  return batches;
}

/**
 * 把一次批量请求的译文按标记切回各段。
 * 允许模型在标记前后加空白、或把标记写成 `@@@ RSS-SEG @@@` 这类变体；
 * 切不出期望段数就返回 null，由调用方回退逐段翻译。
 */
// 切分规则与流式用的「尽力切分」放在 lib/segmentSplit.ts（纯函数、有规格盯着）

// ===== 流式增量订阅（Rust 侧 SSE → 前端）=====

/** Rust 侧推回来的增量载荷（text 是**累计**译文，不是本次新增） */
interface TranslateDeltaPayload {
  id: string;
  text: string;
}

/** 每个请求一个 id：多批次并发时各自的增量不会串到别人身上 */
let streamSeq = 0;

/**
 * 订阅一次请求的流式增量。
 * 必须先 await 拿到监听再发请求，否则最先几个增量会漏掉。
 * @param onDelta 收到累计译文时回调（直接覆盖显示即可）
 * @returns id 塞进请求体；stop 在请求结束后注销监听
 */
async function openDeltaStream(
  onDelta: (text: string) => void,
): Promise<{ id: string; stop: () => void }> {
  streamSeq += 1;
  const id = `t${Date.now().toString(36)}-${streamSeq}`;
  const unlisten = await listen<TranslateDeltaPayload>("translate-delta", (event) => {
    if (event.payload?.id !== id) return;
    onDelta(String(event.payload.text ?? ""));
  });
  return { id, stop: () => void unlisten() };
}

/**
 * 逐块翻译（块 = 段落 / 标题 / 列表项…），**按批推进**，每翻完一块回调一次，
 * 调用方据此「翻一段显示一段」。
 *
 * 两条通道，取舍不同：
 * - **大模型协议**：一次请求翻多段要用分隔标记拼成一段，再按标记切回来（模型弄丢标记就让
 *   这一批回退逐段翻译）。一段一请求最稳但太慢 —— 推理模型每收一个请求都要从头「想」一遍，
 *   请求数比总输出量更影响总耗时；
 * - **机器翻译协议**（微软 / 谷歌 / DeepL）：接口本身就支持一次传多段并按顺序返回，
 *   段落对应关系由接口保证，不需要标记，也就没有「切错位」这回事。
 *
 * 两条通道都按顺序切批、批间并行（BATCH_CONCURRENCY），译文出现顺序因此不严格从前往后，
 * 但每段仍插在自己那段原文之后，对照关系不受影响。
 *
 * @param onBlock 每块完成时回调（text 为 null 表示这块失败），同时带上进度
 * @param context 所属文章标题等上下文（只对大模型协议有意义：避免把标题当成要展开写作的题目）
 * @param shouldStop 返回 true 时立即停止（用户点了停止 / 换了文章）：
 *        不再发起新请求，已翻好的部分照常回调出去
 * @param onPartial 流式过程中的中间结果（大模型协议才有）：某块译文拿到一半时先回调一次，
 *        调用方据此把「正在生成」的译文也贴上去，而不是干等整批完成
 */
export async function translateBlocks(
  blocks: readonly string[],
  config: TranslateConfig,
  onBlock?: (index: number, text: string | null, done: number, total: number) => void,
  context?: string,
  shouldStop?: () => boolean,
  onPartial?: (index: number, text: string) => void,
): Promise<BlockTranslateResult> {
  const provider = getActiveProvider(config);
  if (!provider) throw new Error("尚未配置翻译服务，请到「设置 → 翻译」添加服务商");
  const rustProvider = providerToRust(provider);
  const machineTranslate = isMachineTranslate(provider.protocol);
  // 机器翻译走的是批量命令（一次多段），没有流式通道；大模型协议才有
  const streaming = !machineTranslate && onPartial !== undefined;
  const translations: (string | null)[] = new Array(blocks.length).fill(null);
  const total = blocks.length;
  let failed = 0;
  let firstError: unknown | null = null;
  let done = 0;

  const requestOne = (text: string, marker?: string): Promise<string> =>
    translateText({
      text,
      target: config.targetLang,
      source: config.sourceLang,
      context,
      segment_marker: marker,
      provider: rustProvider,
    });

  /**
   * 带流式的单段请求：先挂监听再发请求（顺序反了会漏掉头几个增量）。
   * onDelta 收到的是**累计**译文，直接交给调用方覆盖显示。
   */
  const requestOneStreaming = async (
    text: string,
    marker: string | undefined,
    onDelta: (t: string) => void,
  ): Promise<string> => {
    const stream = await openDeltaStream(onDelta);
    try {
      return await translateText({
        text,
        target: config.targetLang,
        source: config.sourceLang,
        context,
        segment_marker: marker,
        stream_id: stream.id,
        provider: rustProvider,
      });
    } finally {
      stream.stop();
    }
  };

  // 每块的缓存读写（键不含 provider，重翻/换源都能命中；文本已由调用方压缩过空白）
  const blockKey = (blockText: string): string =>
    translationCacheKey(blockText, config.sourceLang, config.targetLang);
  const readBlockCache = (blockText: string): string | null =>
    lookupTranslation(translationCache, blockKey(blockText));
  const writeBlockCache = (blockText: string, result: string): void => {
    try {
      saveTranslation(translationCache, blockKey(blockText), result);
    } catch {
      // 缓存失败不影响翻译
    }
  };

  const report = (index: number, text: string | null): void => {
    translations[index] = text;
    done += 1;
    if (text === null) {
      failed += 1;
    }
    onBlock?.(index, text, done, total);
  };

  /** 机器翻译协议：整批一次请求（接口保证顺序），译文条数对不上就整批算失败 */
  const runMachineBatch = async (batch: number[]): Promise<void> => {
    try {
      const texts = await translateTexts({
        texts: batch.map((i) => blocks[i]),
        target: config.targetLang,
        source: config.sourceLang,
        provider: rustProvider,
      });
      if (texts.length !== batch.length) {
        throw new Error(
          `译文条数与原文不一致（原文 ${batch.length} 段，返回 ${texts.length} 段）`,
        );
      }
      texts.forEach((text, k) => {
        report(batch[k], text);
        writeBlockCache(blocks[batch[k]], text);
      });
    } catch (err) {
      if (firstError === null) firstError = err;
      // 整批失败：这批每段都标为未翻出（界面在原位显示「本段未能翻译」，不会凭空少一行）
      batch.forEach((index) => report(index, null));
    }
  };

  /** 大模型协议：1 段就直发；多段合并送翻，标记丢失则这一批回退逐段 */
  const runChatBatch = async (batch: number[]): Promise<void> => {
    let results: (string | null)[] | null = null;

    if (batch.length === 1) {
      // 单块：命中缓存直接返回，未命中直发并落缓存
      const blockText = blocks[batch[0]]!;
      const cached = readBlockCache(blockText);
      if (cached !== null) {
        results = [cached];
      } else {
        try {
          const r = streaming
            ? await requestOneStreaming(blockText, undefined, (t) => onPartial?.(batch[0], t))
            : await requestOne(blockText);
          results = [r];
          writeBlockCache(blockText, r);
        } catch (err) {
          if (firstError === null) firstError = err;
          results = [null];
        }
      }
    } else {
      try {
        const joined = batch.map((i) => blocks[i]!).join(`\n${SEGMENT_MARK}\n`);
        // 流式：累计译文按标记尽力切分，把已经切出来的段实时贴到对应块上。
        // 最后一段往往还没写完，也可能停在半个标记上 —— 用 trimPartialMarker 抹掉那半截。
        const onDelta = streaming
          ? (text: string): void => {
              const parts = splitPartialSegments(text);
              parts.forEach((part, k) => {
                const index = batch[k];
                if (index === undefined) return; // 模型多写了标记：多余的忽略
                const isLast = k === parts.length - 1;
                const piece = (isLast ? trimPartialMarker(part) : part).trim();
                if (piece) onPartial?.(index, piece);
              });
            }
          : undefined;
        const out =
          onDelta !== undefined
            ? await requestOneStreaming(joined, SEGMENT_MARK, onDelta)
            : await requestOne(joined, SEGMENT_MARK);
        results = splitSegments(out, batch.length);
        // 切回的每段按各自块文本落缓存（下次哪怕换批、换顺序也能命中单块）
        if (results !== null) {
          results.forEach((t, k) => t && writeBlockCache(blocks[batch[k]]!, t));
        }
      } catch (err) {
        if (firstError === null) firstError = err;
        results = null;
      }
      if (results === null) {
        // 标记没保住 / 段数对不上：这一批退回逐段翻译（正确性优先），其它批次不受影响。
        // 这条回退路径不走流式：每段一次请求，逐段流式的收益有限、代码却更绕。
        results = [];
        for (const index of batch) {
          if (shouldStop?.()) break;
          const blockText = blocks[index]!;
          const cached = readBlockCache(blockText);
          if (cached !== null) {
            results.push(cached);
          } else {
            try {
              const r = await requestOne(blockText);
              results.push(r);
              writeBlockCache(blockText, r);
            } catch (err) {
              if (firstError === null) firstError = err;
              results.push(null);
            }
          }
        }
      }
    }

    results.forEach((text, k) => report(batch[k], text));
  };

  const runBatch = machineTranslate ? runMachineBatch : runChatBatch;

  // 批与批之间并行（最多 BATCH_CONCURRENCY 个在飞）：总耗时从「各批之和」降到「批次 / 并发数」。
  // 代价是译文的出现顺序不再严格从前往后 —— 每段仍插在自己那段原文之后，所以对照关系不受影响。
  // 没填密钥的谷歌通道批要切小些（受 GET 的 URL 长度限制，见 KEYLESS_GOOGLE_*）。
  const keylessGoogle =
    provider.protocol === "google-translate" && provider.apiKey.trim().length === 0;
  const batches =
    provider.protocol === "tencent-tmt"
      ? buildBatches(blocks, TENCENT_MAX_CHARS, TENCENT_MAX_BLOCKS)
      : keylessGoogle
        ? buildBatches(blocks, KEYLESS_GOOGLE_MAX_CHARS, KEYLESS_GOOGLE_MAX_BLOCKS)
        : buildBatches(blocks);
  let nextBatch = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      // 用户点了停止 / 换了文章：不再发起新请求（在途那些的返回会被调用方忽略）
      if (shouldStop?.()) return;
      const index = nextBatch;
      nextBatch += 1;
      if (index >= batches.length) return;
      await runBatch(batches[index]);
    }
  };
  /**
   * 并发数：默认 3（批与批并行把总耗时压下来）。
   * 腾讯云例外 —— 它按 QPS 限流（默认 5 次/秒），Rust 侧已在批内按 ~4.5 次/秒限速，
   * 前端若再开多批并发，总速率会变成「并发数 × 4.5 次/秒」而必然撞限流，所以它只走一条。
   */
  const concurrency = provider.protocol === "tencent-tmt" ? 1 : BATCH_CONCURRENCY;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, batches.length)) }, worker),
  );

  return { translations, failed, firstError };
}

/**
 * 划词翻译：翻译一段选中的文本（阅读视图里选中单词/句子用的入口）。
 *
 * 复用整篇翻译同一套配置 —— 取当前激活 Provider + 源/目标语言，走 translate_text 单段通道
 * （机器翻译协议也是一段一段由该通道分发），所以用户在哪里配的、选了谁，划词就用谁。
 *
 * 与 translateBlocks 不同：不切块、不批处理、不做逐段插回 —— 一段独立文本直发。
 *
 * @param onDelta 给了就开启流式：译文边生成边回调（累计文本），浮窗里能看着字往外冒，
 *        不用盯着转圈等整段。命中缓存时不会有任何增量回调（直接就是最终结果）。
 */
export async function translateSelection(
  text: string,
  context?: string,
  onDelta?: (partial: string) => void,
): Promise<string> {
  const config = await currentConfig();
  const provider = getActiveProvider(config);
  if (!provider) throw new Error("尚未配置翻译服务，请到「设置 → 翻译」添加服务商");
  const rustProvider = providerToRust(provider);

  // 缓存命中：直接返回，不订阅流式（否则白挂一个监听）
  const key = translationCacheKey(text, config.sourceLang, config.targetLang);
  const hit = lookupTranslation(translationCache, key);
  if (hit !== null) return hit;

  const target = config.targetLang;
  const source = config.sourceLang;
  if (onDelta === undefined || isMachineTranslate(provider.protocol)) {
    const { text: result } = await cachedTranslateText(text, source, target, context, rustProvider);
    return result;
  }

  const stream = await openDeltaStream(onDelta);
  let result: string;
  try {
    result = await translateText({
      text,
      target,
      source,
      context,
      stream_id: stream.id,
      provider: rustProvider,
    });
  } finally {
    stream.stop();
  }
  saveTranslation(translationCache, key, result);
  return result;
}
