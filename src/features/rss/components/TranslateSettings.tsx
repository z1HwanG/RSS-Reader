/*
 * 文件名: TranslateSettings.tsx
 * 描述: 设置面板「翻译」tab — 多 Provider 网关管理界面。
 *       Provider 列表（增删改 + 拖动排序）+ 当前 Provider 编辑表单（显示名 / Base URL /
 *       API 格式 / API Key）+ 模型列表（测试模型、编辑模型配置、删除）。
 *       填什么就自动存什么（防抖 500ms 落盘），没有「保存」按钮；删除在列表行右侧。
 *       Provider ID 不再让用户填：由显示名自动派生（见 handleDisplayNameChange）。
 *       协议既支持大模型接口（Anthropic Messages / Chat Completions / Responses），
 *       也支持机器翻译接口（DeepL / 腾讯翻译，以及免密钥的微软 / 谷歌）—— 后者没有模型，模型列表整块不显示。
 *       配置落盘到 app 数据目录（Rust 侧 translate-config.json，不随 UI 状态丢失）。
 *       组件自包含：进入时自动从磁盘加载（含旧单配置迁移与内置网关注入）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import {
  BUILTIN_PROVIDERS,
  DEFAULT_TRANSLATE_CONFIG,
  PROTOCOL_INFO,
  deriveProviderId,
  isMachineTranslate,
  makeModel,
  makeProvider,
  supportsKeyless,
  type TranslateConfig,
  type TranslateModel,
  type TranslateProtocol,
  type TranslateProvider,
} from "../types";
import {
  getActiveProvider,
  getLastLoadError,
  loadTranslateConfig,
  saveTranslateConfig,
  testModel,
} from "../services/translateService";

/**
 * API 格式选项（标签 = 下拉里显示的格式名，value = TranslateProtocol）。
 *
 * 这里只列**大模型接口**的格式：下拉是给「填一个 Base URL + 模型」的网关用的。
 * 内置的机器翻译服务（微软翻译 / 谷歌翻译 / DeepL / 腾讯翻译）地址与调用方式都已预置，
 * 它们不出现在这个下拉里 —— 混在一起只会让人以为还要自己选格式、填地址。
 */
const PROTOCOL_OPTIONS: TranslateProtocol[] = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
];

/** 内置翻译服务的 Provider ID 集合（微软 / 谷歌 / DeepL / 腾讯翻译）——列表里恒置顶、不可拖动、不可删除。 */
const BUILTIN_IDS = new Set(BUILTIN_PROVIDERS.map((d) => d.providerId));
const isBuiltinProvider = (p: Pick<TranslateProvider, "providerId">): boolean =>
  BUILTIN_IDS.has(p.providerId);

/** 生成简单的唯一 Provider ID */
function makeProviderId(): string {
  return `p-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 自动保存的防抖时长：停手这么久才写盘。
 * 太短会让输入框每敲一个字符都写一次整份配置，太长会让「改完就关面板」丢掉改动。
 */
const AUTO_SAVE_DELAY_MS = 500;

/**
 * 解析数量输入（上下文窗口 / 最大输出 token）。
 * 支持纯数字与 K / M 后缀（32K → 32000、1M → 1000000），**按 1000 进制** ——
 * token 是十进制计数，各家的上下文窗口也都按十进制的整数报（如 128000 / 1000000），
 * 用 1024 反而会把「128K」这种常见写法换算成 131072 这种对不上的数。
 * 注意别和文件大小那套（KB/MB 走 1024）混在一起：两者只是都借用了 K/M 这两个字母。
 * 非法或空输入返回 0（表示未设置）。
 */
const TOKEN_UNIT = 1000;

function toCount(raw: string): number {
  const s = raw.trim().toLowerCase().replace(/[,\s]/g, "");
  if (!s) return 0;
  const m = /^(\d+(?:\.\d+)?)([km])?$/.exec(s);
  if (!m) return 0;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return 0;
  const mult = m[2] === "k" ? TOKEN_UNIT : m[2] === "m" ? TOKEN_UNIT * TOKEN_UNIT : 1;
  return Math.round(base * mult);
}

/**
 * 数量的紧凑显示（模型行上的徽标）：1000000 → 1M、32000 → 32K，除不尽就原样显示数字
 * （旧配置里按 1024 存的 1048576 会原样显示成 1048576，不会被硬凑成「1M」）。
 */
function formatCount(n: number): string {
  if (n <= 0) return "";
  if (n % (TOKEN_UNIT * TOKEN_UNIT) === 0) return `${n / (TOKEN_UNIT * TOKEN_UNIT)}M`;
  if (n % TOKEN_UNIT === 0) return `${n / TOKEN_UNIT}K`;
  return String(n);
}

export function TranslateSettings(): JSX.Element {
  /** 完整配置（providers 列表 + 激活项 + 目标语言） */
  const [config, setConfig] = useState<TranslateConfig>({ ...DEFAULT_TRANSLATE_CONFIG });
  /** 当前正在编辑的 Provider ID（null = 未选中） */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** 是否已从磁盘加载过（避免每次渲染重置用户输入） */
  const loadedRef = useRef(false);
  /** 配置读盘完成；自动保存必须等它变 true，否则会拿初始的空配置覆盖磁盘上那份 */
  const [hydrated, setHydrated] = useState(false);
  /** 已落盘内容的快照：与当前状态一致就不重复写盘 */
  const lastSavedRef = useRef<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<{ ok: boolean; text: string } | null>(null);
  /** 正在被拖拽的自定义 Provider ID（拖动过程不需要重渲染，用 ref 存） */
  const dragIdRef = useRef<string | null>(null);
  /**
   * 每个模型的测试结果（按行下标存），贴在对应行下方显示。
   * 结果里记着测试时的模型 ID：ID 被改掉后这条结果自动失效，不会张冠李戴。
   */
  const [testResults, setTestResults] = useState<
    Record<number, { id: string; ok: boolean; text: string }>
  >({});
  /** 「读不到已保存配置」的原因：提示用户别直接保存，否则会覆盖磁盘上的配置 */
  const [loadError, setLoadError] = useState<string | null>(null);
  /**
   * 「编辑模型配置」弹窗的草稿：null = 弹窗关闭。
   * index 为 null 表示「新建」，否则是列表里被编辑的那一行的下标。
   *
   * 弹窗里改的是这份草稿，**点「确定」才写回列表** —— 否则点开又关掉会在列表里
   * 留下一行没填 ID 的空模型（那种行既没用、又只能再手动删掉）。
   */
  const [modelDraft, setModelDraft] = useState<{
    index: number | null;
    model: TranslateModel;
  } | null>(null);
  /** 正在测试连通性的模型下标（null = 没在测） */
  const [testingIndex, setTestingIndex] = useState<number | null>(null);

  // 首次进入：加载配置，默认选中激活项（激活的是免密钥服务时，退到第一个可编辑的）
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void loadTranslateConfig().then((loaded) => {
      setConfig(loaded);
      setLoadError(getLastLoadError());
      // 记下刚读到的内容：自动保存据此判断「有没有真的改动」，避免刚打开就回写一遍
      lastSavedRef.current = JSON.stringify(loaded);
      setHydrated(true);
      const editable = loaded.providers.filter((p) => !supportsKeyless(p.protocol));
      const active = getActiveProvider(loaded);
      const pick =
        active && !supportsKeyless(active.protocol) ? active : (editable[0] ?? null);
      setEditingId(pick ? pick.providerId : null);
    });
  }, []);

  /**
   * 关面板（组件卸载）时把防抖窗口里还没写盘的改动补上。
   * 清理函数只跑一次、拿不到最新闭包，所以这里每渲染都往 ref 里存一份最新状态。
   */
  const flushRef = useRef({ config, ready: false });
  flushRef.current = { config, ready: hydrated && !loadError };
  useEffect(
    () => () => {
      const { config: latest, ready } = flushRef.current;
      if (!ready || JSON.stringify(latest) === lastSavedRef.current) return;
      void saveTranslateConfig(latest);
    },
    [],
  );

  // 当前编辑的 provider（provider 现在一律先落进列表，不再有独立草稿）
  const editing = useMemo<TranslateProvider | null>(
    () => (editingId ? (config.providers.find((p) => p.providerId === editingId) ?? null) : null),
    [config.providers, editingId],
  );

  /**
   * 自动保存：改动停手 AUTO_SAVE_DELAY_MS 后把整份配置写盘。
   * 防抖是必要的 —— 输入框每敲一个字符都写一次文件既没必要也不安全。
   *
   * 读配置失败时一律不写：那种情况下内存里的列表并不是磁盘上的真实内容，
   * 写回去等于把用户存好的配置覆盖掉（自动保存同样要在这种状态下停手）。
   */
  useEffect(() => {
    if (!hydrated || loadError) return;
    const snapshot = JSON.stringify(config);
    if (snapshot === lastSavedRef.current) return;
    const timer = window.setTimeout(() => {
      void saveTranslateConfig(config)
        .then(() => {
          lastSavedRef.current = snapshot;
          // 清掉上一次的失败提示；成功类的提示（如「已加回内置翻译服务」）留着
          setSaveNotice((notice) => (notice && !notice.ok ? null : notice));
        })
        .catch((err) => setSaveNotice({ ok: false, text: `自动保存失败：${String(err)}` }));
    }, AUTO_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [config, hydrated, loadError]);

  /** 草稿里填的模型 ID 是否可用（「确定」按钮据此启用；空 ID 的模型没有意义） */
  const modelDraftReady = modelDraft !== null && modelDraft.model.id.trim().length > 0;

  /**
   * 渲染顺序：内置项（DeepL）恒置顶，按定义顺序；自定义项在后，按它们在 config.providers
   * 里的出现顺序。磁盘数组本身不保证内置在最前，这里只负责「显示层」置顶
   * + 拖动重排只动自定义项。
   *
   * 免密钥专用的服务（微软 / 谷歌）**不在这里显示**：它们没有密钥可填、没有地址可改，
   * 只在文章页面的翻译器里供选择（但它们仍然存在配置里 —— 否则就选不到了）。
   */
  const sortedProviders = useMemo<TranslateProvider[]>(() => {
    const visible = config.providers.filter((p) => !supportsKeyless(p.protocol));
    const builtins = BUILTIN_PROVIDERS.map((d) =>
      visible.find((p) => p.providerId === d.providerId),
    ).filter((p): p is TranslateProvider => p !== undefined);
    const customs = visible.filter((p) => !isBuiltinProvider(p));
    return [...builtins, ...customs];
  }, [config.providers]);

  /** 把自定义项从 fromId 挪到 beforeId 之前（beforeId=null → 置底），内置项保持最前不动。 */
  const reorderCustoms = (fromId: string, beforeId: string | null): void => {
    const builtins = config.providers.filter((p) => isBuiltinProvider(p));
    const customs = config.providers.filter((p) => !isBuiltinProvider(p));
    const idx = customs.findIndex((p) => p.providerId === fromId);
    if (idx < 0) return;
    const [moved] = customs.splice(idx, 1);
    if (beforeId === null) {
      customs.push(moved);
    } else {
      const to = customs.findIndex((p) => p.providerId === beforeId);
      customs.splice(to < 0 ? customs.length : to, 0, moved);
    }
    const next = { ...config, providers: [...builtins, ...customs] };
    setConfig(next);
    // 拖动排序是用户明确点的动作，应立即落盘（与删除 / 恢复内置同理）
    void saveTranslateConfig(next);
  };

  const onProviderDragStart = (id: string) => (e: ReactDragEvent): void => {
    if (isBuiltinProvider({ providerId: id })) return;
    dragIdRef.current = id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  };
  const onProviderDragOver = (id: string) => (e: ReactDragEvent): void => {
    // 只有自定义项能作为拖放目标；内置项不可拖也不可被拖入。
    if (isBuiltinProvider({ providerId: id })) return;
    if (!dragIdRef.current || dragIdRef.current === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  const onProviderDrop = (id: string) => (e: ReactDragEvent): void => {
    const fromId = dragIdRef.current;
    if (!fromId || fromId === id) return;
    e.preventDefault();
    dragIdRef.current = null;
    reorderCustoms(fromId, id);
  };
  /** 拖到自定义区末尾（列表容器自身落点）→ 置底。 */
  const onListDrop = (e: ReactDragEvent): void => {
    const fromId = dragIdRef.current;
    if (!fromId) return;
    e.preventDefault();
    dragIdRef.current = null;
    reorderCustoms(fromId, null);
  };
  const onListDragOver = (e: ReactDragEvent): void => {
    if (!dragIdRef.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  const onProviderDragEnd = (): void => {
    dragIdRef.current = null;
  };

  const patchEditing = (patch: Partial<TranslateProvider>): void => {
    setSaveNotice(null);
    // 地址 / 密钥 / 格式变了，之前的测试结论就不再成立（连的是另一个目标）
    if ("apiUrl" in patch || "apiKey" in patch || "protocol" in patch) setTestResults({});
    if (!editingId) return;
    setConfig((c) => ({
      ...c,
      providers: c.providers.map((p) => (p.providerId === editingId ? { ...p, ...patch } : p)),
    }));
  };

  /** 统一改当前 Provider 的模型列表 */
  const patchModels = (updater: (models: TranslateModel[]) => TranslateModel[]): void => {
    if (!editingId) return;
    setConfig((c) => ({
      ...c,
      providers: c.providers.map((p) =>
        p.providerId === editingId ? { ...p, models: updater(p.models) } : p,
      ),
    }));
  };

  /** 改弹窗里的草稿（不动列表：确定之后才写回） */
  const patchModelDraft = (patch: Partial<TranslateModel>): void => {
    setModelDraft((draft) => (draft ? { ...draft, model: { ...draft.model, ...patch } } : draft));
  };

  /**
   * 添加模型：只开一张空白草稿，**点「确定」才会真的加进列表**。
   * 以前是「先塞一行空模型再开弹窗」，关掉弹窗就在列表里留下一行「（未填模型 ID）」。
   */
  const handleAddModel = (): void => {
    setModelDraft({ index: null, model: makeModel("") });
  };

  /** 弹窗里的「确定」：把草稿写回列表（新建则追加，编辑则替换） */
  const handleConfirmModel = (): void => {
    const draft = modelDraft;
    if (!draft) return;
    const id = draft.model.id.trim();
    if (id.length === 0) return; // 按钮此时是禁用的，这里再兜一层
    const model: TranslateModel = { ...draft.model, id };
    const { index } = draft;
    if (index === null) {
      patchModels((models) => [...models, model]);
    } else {
      patchModels((models) => models.map((m, i) => (i === index ? model : m)));
    }
    setModelDraft(null);
  };

  const handleRemoveModel = (index: number): void => {
    const removed = editing?.models[index];
    patchModels((models) => models.filter((_, i) => i !== index));
    // 删掉的正是当前模型：清空选择，避免指向已不存在的条目
    if (removed && editing && removed.id === editing.model) patchEditing({ model: "" });
    // 测试结果按下标存，要跟着挪一格
    setTestResults((results) => {
      const next: typeof results = {};
      for (const [key, value] of Object.entries(results)) {
        const i = Number(key);
        if (i === index) continue;
        next[i > index ? i - 1 : i] = value;
      }
      return next;
    });
  };

  /**
   * 测试一个模型：真发一句最短的翻译请求。服务端答上来了才算连通
   * —— 地址、密钥、模型名这三件事哪一件不对，都只有让服务端回答才能分辨。
   * 结果贴在对应行下方（成功绿、失败红），换一个模型测试不会互相覆盖。
   */
  const handleTestModel = async (index: number): Promise<void> => {
    const p = editing;
    const m = p?.models[index];
    if (!p || !m) return;
    const fail = (text: string): void => {
      setTestResults((results) => ({ ...results, [index]: { id: m.id, ok: false, text } }));
    };
    if (!p.apiUrl.trim()) {
      fail("连接失败：还没填 Base URL");
      return;
    }
    if (!m.id.trim()) {
      fail("连接失败：这个模型还没填 ID");
      return;
    }
    setTestingIndex(index);
    // 开测先把上一轮结果清掉，免得旧结论和「正在测」并存
    setTestResults((results) => {
      const next = { ...results };
      delete next[index];
      return next;
    });
    try {
      const { ms } = await testModel(p, m.id);
      setTestResults((results) => ({
        ...results,
        [index]: { id: m.id, ok: true, text: `连接成功！（${ms} ms）` },
      }));
    } catch (err) {
      fail(`连接失败：${String(err)}`);
    } finally {
      setTestingIndex(null);
    }
  };

  /**
   * 显示名变更：Provider ID 一律跟着显示名自动派生（纯中文名派生结果为空时保留原 ID）。
   *
   * 派生出的新 ID 若正是当前激活项，把 activeProviderId 一起改掉 —— 否则配置里会留下一个
   * 指向已不存在 ID 的激活项，getActiveProvider 再回落到列表第一个，等于悄悄换了网关。
   */
  const handleDisplayNameChange = (value: string): void => {
    const patch: Partial<TranslateProvider> = { displayName: value };
    const taken = config.providers
      .map((p) => p.providerId)
      .filter((id) => id !== editingId);
    const derived = deriveProviderId(value, taken);
    if (derived) {
      patch.providerId = derived;
      if (editingId && config.activeProviderId === editingId) {
        setConfig((c) => ({ ...c, activeProviderId: derived }));
      }
    }
    patchEditing(patch);
  };

  /**
   * 点击 Provider：只是切到编辑，**不改「用哪个网关」**。
   * 用哪个网关的哪个模型，改到文章页面的分组选择器里定（设置页只负责增删改）。
   */
  const handleSelectForEdit = (id: string): void => {
    setSaveNotice(null);
    setTestResults({});
    setModelDraft(null);
    setEditingId(id);
  };

  /**
   * 添加 Provider：直接进列表并选中（不再有独立草稿）。
   * 面板是自动保存的，草稿不进列表就意味着「填一半关掉面板，内容全丢」。
   */
  const handleAdd = (): void => {
    const p = makeProvider();
    // 先给一个可用的 ID：显示名是中文时派生结果为空，会被 handleDisplayNameChange 保留下来
    p.providerId = makeProviderId();
    p.displayName = `Provider ${config.providers.length + 1}`;
    setConfig((c) => ({
      ...c,
      providers: [...c.providers, p],
      activeProviderId: c.activeProviderId ?? p.providerId,
    }));
    setEditingId(p.providerId);
    setSaveNotice(null);
    setTestResults({});
    setModelDraft(null);
  };

  const handleDelete = async (id: string): Promise<void> => {
    // 读配置失败时不能落盘 —— 那会把磁盘上好好的配置覆盖掉（与恢复内置同理）。
    if (loadError) {
      setSaveNotice({ ok: false, text: "配置没读上，请先解决上面那条再删除" });
      return;
    }
    const providers = config.providers.filter((p) => p.providerId !== id);
    const active = getActiveProvider({ ...config, providers })?.providerId ?? null;
    const next = { ...config, providers, activeProviderId: active };
    setConfig(next);
    if (editingId === id) {
      // 删掉的正是在编辑的那个：把编辑区让给列表里下一个**可见**的（免密钥服务不在列表里，跳过）
      const nextEditable = providers.find((p) => !supportsKeyless(p.protocol));
      setEditingId(nextEditable ? nextEditable.providerId : null);
      setModelDraft(null);
    }
    setSaveNotice(null);
    try {
      // 删除是用户明确点的动作，应立即落盘，不必等自动保存那一拍
      await saveTranslateConfig(next);
      setSaveNotice({ ok: true, text: "已删除此服务商" });
    } catch (err) {
      setSaveNotice({ ok: false, text: `删除失败：${String(err)}` });
    }
  };
  /**
   * 模型列表不再单独给「共 N 个模型」这类提示：列表就在下面一眼可见，
   * 空态的「（暂无模型）」也已经写在列表里，再说一遍只是重复。
   */

  return (
    <div className="translate-tab">
      <div className="settings-card">
        <div className="settings-card-header">
          <span>服务商</span>
          <div className="settings-inline">
            <button className="f2-btn-outline" onClick={handleAdd}>
              + 添加服务商
            </button>
          </div>
        </div>
        {/* 服务商列表：点击只是切到编辑，不改「用哪个」（那件事在文章页面选）。
            DeepL 恒置顶且不可拖动、也不给删除入口（内置服务由应用保证存在）；
            自定义项可拖动排序、可删除。
            微软 / 谷歌不在此列表：它们免密钥、无可配置项，只在文章页面的翻译器里出现。 */}
        <div
          className="provider-list"
          onDragOver={onListDragOver}
          onDrop={onListDrop}
        >
          {sortedProviders.map((p) => {
            const builtin = isBuiltinProvider(p);
            return (
              <div
                key={p.providerId}
                className={`provider-item ${p.providerId === editingId ? "editing" : ""} ${
                  builtin ? "builtin" : "draggable"
                }`}
                onClick={() => handleSelectForEdit(p.providerId)}
                title={builtin ? "内置服务，固定置顶" : "点击编辑，拖拽排序"}
                draggable={!builtin}
                onDragStart={builtin ? undefined : onProviderDragStart(p.providerId)}
                onDragOver={builtin ? undefined : onProviderDragOver(p.providerId)}
                onDrop={builtin ? undefined : onProviderDrop(p.providerId)}
                onDragEnd={builtin ? undefined : onProviderDragEnd}
              >
                {/* 行里只放名称（+ 自建项的删除按钮）：地址与协议/模型数在下面的编辑区就能看到，
                    列在这里只是噪声。内置服务没有删除按钮 —— 它们由应用保证存在。 */}
                <span className="provider-item-name">
                  {p.displayName || p.providerId || "未命名"}
                </span>
                {!builtin && (
                  <button
                    className="provider-item-delete"
                    onClick={(e) => {
                      // 别让点击冒泡到整行 —— 那会顺带把它切成「正在编辑」
                      e.stopPropagation();
                      void handleDelete(p.providerId);
                    }}
                    title="删除此服务商"
                  >
                    <span className="material-symbols-rounded">delete</span>
                  </button>
                )}
              </div>
            );
          })}
          {config.providers.length === 0 && (
            <p className="provider-empty">（还没有服务商，点右上角「添加服务商」）</p>
          )}
        </div>

        {/* 读取失败：区分「文件不存在」与「文件在却读不出来」——后者若直接保存会覆盖磁盘上的配置 */}
        {loadError && (
          <p className="translation-error translate-load-error">
            <span className="material-symbols-rounded">error</span>
            读取已保存的配置失败：{loadError}
            <br />
            当前列表可能不是磁盘上的真实内容，改动不会被保存。
          </p>
        )}

        {/* 保存反馈：字段改动是自动保存的，所以这里只会有失败提示，
            以及几个明确动作（删除 / 加回内置）的结果 */}
        {saveNotice && (
          <p className={saveNotice.ok ? "form-text-success" : "form-text-error"}>
            {saveNotice.text}
          </p>
        )}

        {/* 编辑当前 Provider */}
        {editing ? (
          <div className="provider-edit">
            <div className="settings-field">
              <label>显示名</label>
              <input
                className="settings-text-input"
                type="text"
                value={editing.displayName}
                onChange={(e) => handleDisplayNameChange(e.target.value)}
              />
            </div>

            {/* 大模型服务商才有「地址 / 格式」可填；内置的机器翻译服务（DeepL）地址与调用方式
                都已预置，用户只需要填密钥 —— 所以那两项压根不显示，不留「展开高级设置」这种入口 */}
            {!isMachineTranslate(editing.protocol) && (
              <>
                <div className="settings-field">
                  <label>Base URL</label>
                  <input
                    className="settings-text-input"
                    type="text"
                    placeholder="https://gateway.example/v1"
                    value={editing.apiUrl}
                    onChange={(e) => patchEditing({ apiUrl: e.target.value })}
                  />
                </div>
                {/* 空提示不占位（协议标签里已经写着路径，不必再重复一遍补全规则） */}
                {PROTOCOL_INFO[editing.protocol].apiHint !== "" && (
                  <p className="settings-hint">{PROTOCOL_INFO[editing.protocol].apiHint}</p>
                )}
                <div className="settings-field">
                  <label>API 格式</label>
                  <select
                    className="settings-select"
                    value={editing.protocol}
                    onChange={(e) => patchEditing({ protocol: e.target.value as TranslateProtocol })}
                  >
                    {PROTOCOL_OPTIONS.map((value) => (
                      <option key={value} value={value}>
                        {PROTOCOL_INFO[value].label}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}
            <div className="settings-field">
              <label>API Key</label>
              <input
                className="settings-text-input"
                type="password"
                placeholder={
                  isMachineTranslate(editing.protocol)
                    ? "粘贴 API 密钥"
                    : "本地服务（如 Ollama）可留空"
                }
                value={editing.apiKey}
                onChange={(e) => patchEditing({ apiKey: e.target.value })}
                autoComplete="off"
              />
            </div>
            {PROTOCOL_INFO[editing.protocol].keyHint !== "" && (
              <p className="settings-hint">{PROTOCOL_INFO[editing.protocol].keyHint}</p>
            )}

            {/* 关闭思考模式：DeepSeek 等推理模型的思考默认开启（effort=high），翻译会先白等一整段
                思维链。只对 OpenAI 兼容协议发这个字段，所以只在它下面显示。
                说明写进 title（悬停才出现），不占版面 —— 这块只有 560px 宽，长句会把勾选框挤成三行。 */}
            {editing.protocol === "openai-completions" && (
              <div className="settings-field">
                <label>思考模式</label>
                <label
                  className="settings-checkbox"
                  title={
                    "DeepSeek 等推理模型的思考默认开启，每次翻译都要先输出一整段思维链；" +
                    "关闭后译文直接生成，明显更快。\n" +
                    "注意：若该网关不认识 thinking 字段，勾选后可能报错，那就取消勾选。"
                  }
                >
                  <input
                    type="checkbox"
                    checked={editing.disableThinking}
                    onChange={(e) => patchEditing({ disableThinking: e.target.checked })}
                  />
                  关闭思考
                </label>
              </div>
            )}

            {/* 机器翻译接口（DeepL / 腾讯翻译）没有「模型」这个概念：整块模型列表不显示。
                不必再写一句「这类服务商不需要模型」——密钥提示已经说明填好就能用。 */}
            {!isMachineTranslate(editing.protocol) && (
              /* 模型列表：每行一个模型（模型 ID + 上下文窗口徽标），行内三个动作
                 —— 测试模型 / 编辑模型配置 / 删除。参数改到弹窗里，列表本身保持紧凑。 */
              <div className="settings-field settings-field--block">
                <div className="model-catalog-head">
                  <div className="model-catalog-title">
                    <label>模型列表</label>
                  </div>
                </div>

                <div className="model-catalog">
                  {editing.models.length === 0 && (
                    <p className="model-catalog-empty">（暂无模型：点下方「添加模型」）</p>
                  )}
                  {editing.models.map((m, index) => {
                    // 结果里记着测试时的模型 ID：ID 改过就当过期，不再显示
                    const tested = testResults[index];
                    const result = tested && tested.id === m.id ? tested : null;
                    return (
                      <div className="model-row-group" key={`${m.id}-${index}`}>
                        <div className="model-row">
                          <div className="model-row-display" title={m.id}>
                            <span className="model-row-id">
                              {m.displayName || m.id || "（未填模型 ID）"}
                            </span>
                            {m.contextWindow > 0 && (
                              <span className="model-row-badge" title="上下文窗口">
                                {formatCount(m.contextWindow)}
                              </span>
                            )}
                          </div>
                          <div className="model-row-actions">
                            <button
                              className={`model-row-action ${testingIndex === index ? "testing" : ""}`}
                              onClick={() => void handleTestModel(index)}
                              disabled={testingIndex !== null}
                              title="测试模型：发一句最短的翻译请求，确认地址、密钥与模型名可用"
                            >
                              <span className="material-symbols-rounded">
                                {testingIndex === index ? "progress_activity" : "cable"}
                              </span>
                            </button>
                            <button
                              className="model-row-action"
                              onClick={() =>
                                setModelDraft({ index, model: { ...m } })
                              }
                              title="编辑模型配置"
                            >
                              <span className="material-symbols-rounded">edit</span>
                            </button>
                            <button
                              className="model-row-action model-row-action--danger"
                              onClick={() => handleRemoveModel(index)}
                              title="删除"
                            >
                              <span className="material-symbols-rounded">delete</span>
                            </button>
                          </div>
                        </div>
                        {/* 测试结果贴在这一行下面：连着测几个模型也不会互相覆盖 */}
                        {result && (
                          <p className={`model-test-result ${result.ok ? "ok" : "fail"}`}>
                            {result.text}
                          </p>
                        )}
                      </div>
                    );
                  })}
                  <button className="f2-btn-outline model-add" onClick={handleAddModel}>
                    添加模型
                  </button>
                </div>
                </div>
            )}
          </div>
        ) : null}
      </div>

      {/* 「编辑模型配置」弹窗：列表行只显示模型 ID 与徽标，参数改在这里做。
          改的是草稿，「确定」才写回列表；取消 / 关闭 / 点遮罩都是丢弃，
          所以「添加模型」点开又关掉不会留下任何空行。 */}
      {modelDraft && (
        <div className="modal-overlay confirm-overlay" onClick={() => setModelDraft(null)}>
          <div
            className="modal model-editor-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="modal-head">
              <h2>{modelDraft.index === null ? "添加模型" : "编辑模型配置"}</h2>
              <button
                className="model-editor-close"
                onClick={() => setModelDraft(null)}
                title="关闭（不保存）"
              >
                <span className="material-symbols-rounded">close</span>
              </button>
            </div>
            <div className="settings-field">
              <label>模型 ID</label>
              <input
                className="settings-text-input"
                type="text"
                placeholder="如 deepseek-chat"
                value={modelDraft.model.id}
                onChange={(e) => patchModelDraft({ id: e.target.value })}
                autoFocus
              />
            </div>
            {/* 两个数量参数并排：各自只填一个短值（32K / 1M），竖排白占两行高度 */}
            <div className="model-editor-row">
              <div className="settings-field">
                <label>上下文窗口</label>
                <input
                  className="settings-text-input"
                  type="text"
                  inputMode="numeric"
                  placeholder="如 1M"
                  title="上下文窗口（token），支持 32K / 1M 写法（K = 1000、M = 1000000）；仅作参考，不参与请求"
                  value={
                    modelDraft.model.contextWindow === 0
                      ? ""
                      : String(modelDraft.model.contextWindow)
                  }
                  onChange={(e) => patchModelDraft({ contextWindow: toCount(e.target.value) })}
                />
              </div>
              <div className="settings-field">
                <label>最大输出 Token</label>
                <input
                  className="settings-text-input"
                  type="text"
                  inputMode="numeric"
                  placeholder="如 32K"
                  title="最大输出 token，支持 32K / 1M 写法（K = 1000、M = 1000000）；留空则不指定该参数（Anthropic 协议回退 4096）"
                  value={
                    modelDraft.model.maxOutputTokens === 0
                      ? ""
                      : String(modelDraft.model.maxOutputTokens)
                  }
                  onChange={(e) => patchModelDraft({ maxOutputTokens: toCount(e.target.value) })}
                />
              </div>
            </div>
            <div className="modal-actions">
              <button className="f2-btn-outline" onClick={() => setModelDraft(null)}>
                取消
              </button>
              <button
                className="f2-btn-standard"
                onClick={handleConfirmModel}
                disabled={!modelDraftReady}
                title={modelDraftReady ? "写回模型列表" : "填上模型 ID 才能确定"}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}