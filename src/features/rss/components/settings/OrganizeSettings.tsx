/*
 * 文件名: OrganizeSettings.tsx
 * 描述: 设置面板「分组与排序」分区：分组管理（新建 / 重命名 / 删除 / 折叠）+
 *   订阅源与分组的拖拽排序（HTML5 原生拖拽与 pointer 自绘双通道）。
 *   删除动作只上报父级（onRequestDelete）弹确认框，自身不直接删。
 */
import { useEffect, useRef, useState } from "react";
import type { Feed, Group } from "../../types";
import {
  sortFeedsByGroupOrder,
  type FeedMovePosition,
} from "../../../../lib/feedOrder";

interface OrganizeSettingsProps {
  feeds: Feed[];
  groups: Group[];
  /** 被折叠的分组（分组 id；未分组用 `__ungrouped__`），持久化在偏好里 */
  collapsedGroups: string[];
  onAddGroup: (name: string) => void;
  onRenameGroup: (id: string, name: string) => void;
  onRemoveGroup: (id: string) => void;
  /**
   * 移动订阅源：按档位上移/下移/置顶/置底，或（拖拽时）插到 `beforeId` 之前。
   * 只在同组内生效，`sort_order` 为组内序号。
   */
  onMoveFeed: (feedId: string, position: FeedMovePosition, beforeId?: string | null) => void;
  onMoveToGroup: (feedId: string, groupId: string | null) => void;
  /**
   * 拖动排序分组：把 `groupId` 移到 `beforeGroupId` 之前（null = 移到末尾）。
   * 分组先后由 state.groups 的数组顺序决定，没有 sort_order。
   */
  onReorderGroup: (groupId: string, beforeGroupId: string | null) => void;
  onToggleGroupCollapsed: (key: string) => void;
  /** 行内删除按钮：父级弹确认框后执行 */
  onRequestDelete: (feedIds: string[]) => void;
}

export function OrganizeSettings({
  feeds,
  groups,
  collapsedGroups,
  onAddGroup,
  onRenameGroup,
  onRemoveGroup,
  onMoveFeed,
  onMoveToGroup,
  onReorderGroup,
  onToggleGroupCollapsed,
  onRequestDelete,
}: OrganizeSettingsProps): JSX.Element {
  const [newGroupName, setNewGroupName] = useState("");
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editGroupName, setEditGroupName] = useState("");

  const handleAddGroupClick = (): void => {
    const name = newGroupName.trim();
    if (!name) return;
    onAddGroup(name);
    setNewGroupName("");
  };

  const startEditGroup = (g: Group): void => {
    setEditingGroupId(g.id);
    setEditGroupName(g.name);
  };

  const confirmRenameGroup = (): void => {
    if (editingGroupId && editGroupName.trim()) {
      onRenameGroup(editingGroupId, editGroupName.trim());
    }
    setEditingGroupId(null);
  };

  /** 「分组与排序」页签的顺序：始终按「分组 + 组内 sort_order」，不跟随浏览偏好。 */
  const organizeFeeds = sortFeedsByGroupOrder(feeds, groups);

  // ---- 拖拽排序 ----
  /**
   * 拖拽排序用**原生事件监听**实现，不走 React 的合成事件：
   * 浏览器在 dragstart 之后会立刻连续派发 dragover，而 React 的 setState 是异步批处理的，
   * 那时读取 state 拿到的仍是「没在拖」，onDragOver 里一旦据此 return 就从不 accept，
   * 浏览器会把整片区域显示成「禁止」光标（实测症状）。原生监听里用一个普通变量记录状态，
   * 同步读写、与 React 的渲染时序完全解耦。
   *
   * 两条通道，同屏只启用一条：
   * - `html5`：`draggable` 行 + dragstart/dragover/drop。要求窗口 `dragDropEnabled: false`
   *   （Tauri 默认 true 会由 WebView2 接管拖放，HTML5 拖拽在 Windows 上完全失效）；
   * - `pointer`：按住拖拽手柄后用 pointer 事件自绘。不依赖任何原生拖放能力，
   *   因此在 `dragDropEnabled: true` 的窗口里也能用。
   *
   * 由 `pointerModeRef` 在运行时选定：手柄上指针一按下就先按 pointer 通道走，
   * 真浏览器随后派发 dragstart 时再让位给 HTML5 通道（见 onPointerDown 里的指针捕获释放）。
   */
  const DRAG_THRESHOLD_PX = 4;
  const organizeListRef = useRef<HTMLDivElement | null>(null);
  const draggingIdRef = useRef<string | null>(null);
  /** 正在拖动的分组 id（拖分组时用它，与 draggingIdRef 互斥） */
  const draggingGroupIdRef = useRef<string | null>(null);
  const pointerModeRef = useRef(false);
  const pointerDragRef = useRef<{ startY: number; active: boolean; row: HTMLElement } | null>(null);
  /** 自动滚动的 rAF 句柄（拖到列表上下边缘时用） */
  const autoScrollRafRef = useRef<number | null>(null);
  /**
   * 拖拽期间要读订阅源列表：走 ref 而不是闭包里的 `feeds`。
   * 落点提交会触发一次重排，闭包里的 `feeds` 就成了旧值（跨分组判断会用到 group_id），
   * 而 ref 读的是最新一次渲染的数据。
   */
  const feedsRef = useRef<Feed[]>(feeds);
  feedsRef.current = feeds;

  /** 找当前滚动容器（列表可能整体不滚动，沿用最近的滚动祖先） */
  const scrollContainerOf = (el: HTMLElement): HTMLElement | null => {
    let node: HTMLElement | null = el.parentElement;
    while (node) {
      if (node.scrollHeight > node.clientHeight + 1) return node;
      node = node.parentElement;
    }
    return null;
  };

  /**
   * 按指针位置找落点：命中哪一行的上半 → 插到它之前；落到该分组末尾 → `beforeId` 为 null。
   * 返回 null 表示指针不在任何分组内（此时不提交，避免误判成「置底」）。
   */
  const findDropSlot = (
    clientY: number,
  ): { beforeId: string | null; groupKey: string | null } | null => {
    const container = organizeListRef.current;
    if (!container) return null;
    for (const group of container.querySelectorAll<HTMLElement>(".feed-group")) {
      const rect = group.getBoundingClientRect();
      if (clientY < rect.top || clientY > rect.bottom) continue;
      const groupKey = group.dataset.groupKey ?? null;
      const rows = [...group.querySelectorAll<HTMLElement>(".organize-row")];
      for (const row of rows) {
        const r = row.getBoundingClientRect();
        if (clientY < r.top + r.height / 2) {
          return { beforeId: row.dataset.feedId ?? null, groupKey };
        }
      }
      return { beforeId: null, groupKey };
    }
    return null;
  };

  /**
   * 提交一次移动：`slot` 为 null（指针不在任何分组内）时不做任何事。
   * 跨分组时先改归属，等状态落地再按落点排序。
   * 依赖只走 ref 与 `onMove*`（都是 useCallback 稳定引用），因此监听器可以只挂一次。
   */
  const commitDrop = (
    feedId: string,
    slot: { beforeId: string | null; groupKey: string | null } | null,
  ): void => {
    if (!slot) return;
    const dragged = feedsRef.current.find((f) => f.id === feedId);
    if (!dragged) return;
    const targetGroupId = slot.groupKey === "__ungrouped__" ? null : slot.groupKey;
    const crossGroup = slot.groupKey !== null && (dragged.group_id ?? null) !== targetGroupId;
    const beforeId = slot.beforeId === feedId ? null : slot.beforeId;
    if (crossGroup) onMoveToGroup(dragged.id, targetGroupId);
    // 有落点行 → 插到它之前；落在分组末尾（没有落点行）→ 置底。
    // 注意不能两种都传 "top"：纯函数把 `beforeId` 为 null 时的 "top" 解释成「移到首位」，
    // 拖到组末尾就会被判成原地不动，看着像没生效。
    const position: FeedMovePosition = beforeId ? "top" : "bottom";
    const run = (): void => onMoveFeed(dragged.id, position, beforeId);
    if (crossGroup) window.setTimeout(run, 0);
    else run();
  };

  /**
   * 拖动**分组**时的落点：命中某个分组的标题行 → 插到该分组之前；
   * 落到「未分组」区块 → 返回 `beforeGroupId: null`（排到所有分组之后）。
   * 指针不在任何标题行上时返回 null，不提交（避免误判成置底）。
   */
  const findGroupDropSlot = (clientY: number): { beforeGroupId: string | null } | null => {
    const container = organizeListRef.current;
    if (!container) return null;
    for (const block of container.querySelectorAll<HTMLElement>(".feed-group")) {
      const header = block.querySelector<HTMLElement>(".feed-group-header");
      if (!header) continue;
      const rect = header.getBoundingClientRect();
      if (clientY < rect.top || clientY > rect.bottom) continue;
      const key = block.dataset.groupKey ?? null;
      return { beforeGroupId: key === "__ungrouped__" ? null : key };
    }
    return null;
  };

  /** 提交一次分组拖动 */
  const commitGroupDrop = (
    groupId: string,
    slot: { beforeGroupId: string | null } | null,
  ): void => {
    if (!slot) return;
    if (slot.beforeGroupId === groupId) return; // 落到自己身上 = 不动
    onReorderGroup(groupId, slot.beforeGroupId);
  };

  /**
   * 拖拽手柄与落点逻辑都放在这里，注册只发生一次（组件只在「分组与排序」页签挂载）。
   *
   * 原来把 `feeds` 放进依赖里，导致每次重排都重建监听：
   * 落点提交的那一瞬间正好把「拖拽中」的 DOM 状态和正在处理的监听一起拆掉。
   * 现在顺序由行 key 驱动重排，监听保持稳定，拖拽过程中不断线。
   */
  useEffect(() => {
    const container = organizeListRef.current;
    if (!container) return;

    const clearIndicator = (): void => {
      container.classList.remove("organize-dragging");
      container.querySelectorAll(".drop-before").forEach((el) => el.classList.remove("drop-before"));
      container.querySelectorAll(".drop-here").forEach((el) => el.classList.remove("drop-here"));
      container.querySelectorAll(".dragging").forEach((el) => el.classList.remove("dragging"));
    };

    const showIndicator = (slot: { beforeId: string | null; groupKey: string | null } | null): void => {
      const activeId = draggingIdRef.current;
      container.querySelectorAll(".drop-before").forEach((el) => {
        if (el.getAttribute("data-feed-id") !== slot?.beforeId) el.classList.remove("drop-before");
      });
      container.querySelectorAll(".drop-here").forEach((el) => {
        if (el.getAttribute("data-group-key") !== slot?.groupKey) el.classList.remove("drop-here");
      });
      if (!slot) return;
      const row = slot.beforeId
        ? container.querySelector<HTMLElement>(`.organize-row[data-feed-id="${CSS.escape(slot.beforeId)}"]`)
        : null;
      if (row && slot.beforeId !== activeId) row.classList.add("drop-before");
      if (slot.groupKey) {
        container
          .querySelector<HTMLElement>(`.feed-group[data-group-key="${CSS.escape(slot.groupKey)}"]`)
          ?.classList.add("drop-here");
      }
    };

    /** 分组拖动时的落点指示：给目标分组的标题行加同一条插入线 */
    const showGroupIndicator = (slot: { beforeGroupId: string | null } | null): void => {
      container.querySelectorAll(".feed-group-header.drop-before").forEach((el) => {
        el.classList.remove("drop-before");
      });
      if (!slot) return;
      if (slot.beforeGroupId === draggingGroupIdRef.current) return;
      const key = slot.beforeGroupId ?? "__ungrouped__";
      container
        .querySelector<HTMLElement>(`.feed-group[data-group-key="${CSS.escape(key)}"] .feed-group-header`)
        ?.classList.add("drop-before");
    };

    const stopAutoScroll = (): void => {
      if (autoScrollRafRef.current !== null) {
        cancelAnimationFrame(autoScrollRafRef.current);
        autoScrollRafRef.current = null;
      }
    };

    /** 拖到可滚动区域上下边缘时自动滚动，让长列表也能拖到远处的分组 */
    const startAutoScroll = (clientY: number): void => {
      stopAutoScroll();
      const scroller = scrollContainerOf(container);
      if (!scroller) return;
      const rect = scroller.getBoundingClientRect();
      const margin = 28;
      const speed =
        clientY < rect.top + margin
          ? -Math.ceil((rect.top + margin - clientY) / 3)
          : clientY > rect.bottom - margin
            ? Math.ceil((clientY - (rect.bottom - margin)) / 3)
            : 0;
      if (speed === 0) return;
      const step = (): void => {
        scroller.scrollTop += speed;
        autoScrollRafRef.current = requestAnimationFrame(step);
      };
      autoScrollRafRef.current = requestAnimationFrame(step);
    };

    /** 收起所有拖拽视觉状态（两条通道共用） */
    const resetDragState = (): void => {
      draggingIdRef.current = null;
      draggingGroupIdRef.current = null;
      pointerDragRef.current = null;
      pointerModeRef.current = false;
      stopAutoScroll();
      clearIndicator();
    };

    /** 当前拖的是什么（两类互斥） */
    const dragKind = (): "group" | "feed" | null =>
      draggingGroupIdRef.current ? "group" : draggingIdRef.current ? "feed" : null;

    /**
     * 手柄所在的分组区块。「未分组」区块不是一个分组，不能拖（返回 null）。
     */
    const groupBlockOf = (target: HTMLElement | null): { id: string; el: HTMLElement } | null => {
      const block = target?.closest<HTMLElement>(".feed-group") ?? null;
      const key = block?.dataset.groupKey ?? null;
      if (!block || !key || key === "__ungrouped__") return null;
      return { id: key, el: block };
    };

    // ===== 通道一：HTML5 原生拖拽 =====
    const onDragStart = (event: DragEvent): void => {
      if (!pointerModeRef.current) return;
      // 手柄按下的这次拖拽被浏览器接走了：原生拖放可用 → 从此走 HTML5 通道
      pointerModeRef.current = false;
      pointerDragRef.current = null;
      const target = event.target as HTMLElement | null;
      const group = target?.closest(".group-drag-handle") ? groupBlockOf(target) : null;
      if (group) {
        draggingGroupIdRef.current = group.id;
        group.el.classList.add("dragging");
        container.classList.add("organize-dragging");
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", group.id);
        }
        return;
      }
      const row = target?.closest<HTMLElement>(".organize-row");
      const id = row?.dataset.feedId ?? null;
      draggingIdRef.current = id;
      if (row) row.classList.add("dragging");
      container.classList.add("organize-dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", id ?? "");
      }
    };

    const onDragOver = (event: DragEvent): void => {
      if (pointerModeRef.current || !dragKind()) return;
      // 关键：同步 accept，浏览器就不会显示「禁止」光标
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      startAutoScroll(event.clientY);
      if (draggingGroupIdRef.current) showGroupIndicator(findGroupDropSlot(event.clientY));
      else showIndicator(findDropSlot(event.clientY));
    };

    const onDrop = (event: DragEvent): void => {
      if (pointerModeRef.current) return;
      const kind = dragKind();
      if (!kind) return;
      event.preventDefault();
      const groupId = draggingGroupIdRef.current;
      const feedId = draggingIdRef.current;
      const y = event.clientY;
      resetDragState();
      if (kind === "group" && groupId) commitGroupDrop(groupId, findGroupDropSlot(y));
      else if (feedId) commitDrop(feedId, findDropSlot(y));
    };

    const onDragEnd = (): void => resetDragState();

    // ===== 通道二：指针自绘拖拽（不依赖原生拖放） =====
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      // 分组手柄优先：分组的可拖区域只有标题行上的手柄
      if (target?.closest(".group-drag-handle")) {
        const group = groupBlockOf(target);
        if (!group) return;
        draggingGroupIdRef.current = group.id;
        pointerModeRef.current = true;
        pointerDragRef.current = { startY: event.clientY, active: false, row: group.el };
        group.el.draggable = true;
        try {
          group.el.setPointerCapture(event.pointerId);
        } catch {
          /* 拿不到捕获也能拖，只是移出窗口外会断线 */
        }
        return;
      }
      // 只有手柄按下才算「拖」——整行都能拖会和行内按钮抢事件，也让误拖变多
      if (!target?.closest(".feeds-manage-row-handle")) return;
      const row = target.closest<HTMLElement>(".organize-row");
      if (!row?.dataset.feedId) return;
      draggingIdRef.current = row.dataset.feedId;
      pointerModeRef.current = true;
      pointerDragRef.current = { startY: event.clientY, active: false, row };
      // 手柄按下才让这一行获得原生拖拽语义（原生拖放接管时由 HTML5 通道接手）
      row.draggable = true;
      try {
        // 指针捕获：拖出容器甚至窗口外也能继续收到 pointermove / pointerup。
        // 指针不处于活动状态时会抛 NotFoundError —— 必须在 try 里，
        // 否则异常会中断本处理函数，拖拽状态建不起来（拖拽直接失效）。
        row.setPointerCapture(event.pointerId);
      } catch {
        /* 拿不到捕获也能拖，只是移出窗口外会断线 */
      }
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (!pointerModeRef.current || !dragKind()) return;
      const drag = pointerDragRef.current;
      if (!drag) return;
      if (!drag.active) {
        if (Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
        drag.active = true;
        drag.row.classList.add("dragging");
        container.classList.add("organize-dragging");
      }
      event.preventDefault();
      startAutoScroll(event.clientY);
      if (draggingGroupIdRef.current) showGroupIndicator(findGroupDropSlot(event.clientY));
      else showIndicator(findDropSlot(event.clientY));
    };

    const finishPointerDrag = (event: PointerEvent, commit: boolean): void => {
      if (!pointerModeRef.current) return;
      const kind = dragKind();
      const groupId = draggingGroupIdRef.current;
      const feedId = draggingIdRef.current;
      const drag = pointerDragRef.current;
      const y = event.clientY;
      const active = Boolean(commit && drag?.active);
      const row = drag?.row;
      const groupSlot = active && kind === "group" ? findGroupDropSlot(y) : null;
      const feedSlot = active && kind === "feed" ? findDropSlot(y) : null;
      resetDragState();
      if (row?.hasPointerCapture(event.pointerId)) row.releasePointerCapture(event.pointerId);
      if (row) row.draggable = false;
      if (!active) return;
      if (kind === "group" && groupId) commitGroupDrop(groupId, groupSlot);
      else if (kind === "feed" && feedId) commitDrop(feedId, feedSlot);
    };

    const onPointerUp = (event: PointerEvent): void => finishPointerDrag(event, true);
    const onPointerCancel = (event: PointerEvent): void => finishPointerDrag(event, false);
    /** 拖到一半按 Esc：放弃这次拖拽（不改数据） */
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || !pointerModeRef.current) return;
      const row = pointerDragRef.current?.row;
      resetDragState();
      if (row) row.draggable = false;
    };

    container.addEventListener("dragstart", onDragStart);
    container.addEventListener("dragover", onDragOver);
    container.addEventListener("drop", onDrop);
    container.addEventListener("dragend", onDragEnd);
    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerup", onPointerUp);
    container.addEventListener("pointercancel", onPointerCancel);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("dragstart", onDragStart);
      container.removeEventListener("dragover", onDragOver);
      container.removeEventListener("drop", onDrop);
      container.removeEventListener("dragend", onDragEnd);
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("pointercancel", onPointerCancel);
      document.removeEventListener("keydown", onKeyDown);
      stopAutoScroll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖只走 ref 与稳定引用（见 commitDrop 注释）
  }, []);

  function getFeedsByGroup(groupId: string | null): Feed[] {
    return organizeFeeds.filter((f) => f.group_id === groupId);
  }

  /** 渲染单个订阅源行（分组与排序 tab） */
  function renderFeedRow(feed: Feed): JSX.Element {
    return (
      <li
        key={feed.id}
        data-feed-id={feed.id}
        className="feeds-manage-item organize-row"
        // 初始不可拖：手柄按下时才切到 draggable（见上面的双通道说明）。
        // 常驻 draggable 会让「按下手柄才拖」的语义失效，也会在拖拽被原生拖放接管时出现禁止光标。
        draggable={false}
      >
        <span className="feeds-manage-row-handle material-symbols-rounded" title="按住并上下拖动排序">
          drag_indicator
        </span>
        <span className="feeds-manage-name" title={feed.url}>
          {feed.title || feed.url}
        </span>
        {/* 置顶 / 置底按钮已移除：拖动本来就能落到任意位置（含跨分组），
            档位式移动只是拖拽的退化形式，留在行里只会让控件变挤 */}
        <div className="feeds-manage-controls">
          <select
            className="feeds-manage-group-select"
            value={feed.group_id ?? ""}
            onChange={(e) => onMoveToGroup(feed.id, e.target.value || null)}
            title="切换分组"
          >
            <option value="">未分组</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
          <button
            className="feeds-manage-remove"
            onClick={() => onRequestDelete([feed.id])}
            title="删除"
          >
            <span className="material-symbols-rounded">delete</span>
          </button>
        </div>
      </li>
    );
  }

  /** 渲染分组区块（分组与排序 tab） */
  function renderGroupBlock(label: string, groupId: string | null, group?: Group): JSX.Element {
    const groupFeeds = getFeedsByGroup(groupId);
    const groupKey = groupId ?? "__ungrouped__";
    const collapsed = collapsedGroups.includes(groupKey);
    return (
      <div key={group?.id ?? "__ungrouped__"} data-group-key={groupKey} className="feed-group">
        <div className="feed-group-header">
          {group && (
            <span
              className="group-drag-handle feeds-manage-row-handle material-symbols-rounded"
              title="按住并上下拖动，调整分组顺序"
            >
              drag_indicator
            </span>
          )}
          {group && editingGroupId === group.id ? (
            <input
              className="group-name-input"
              value={editGroupName}
              onChange={(e) => setEditGroupName(e.target.value)}
              onBlur={confirmRenameGroup}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmRenameGroup();
                if (e.key === "Escape") setEditingGroupId(null);
              }}
              autoFocus
            />
          ) : (
            <span
              className="group-name"
              onDoubleClick={() => group && startEditGroup(group)}
              title={group ? "双击重命名" : undefined}
            >
              {label}
              <span className="feed-count-badge">{groupFeeds.length}</span>
            </span>
          )}
          <div className="group-controls">
            <button
              className="f2-mini-btn group-collapse-btn"
              onClick={() => onToggleGroupCollapsed(groupKey)}
              title={collapsed ? "展开分组" : "折叠分组"}
              aria-expanded={!collapsed}
            >
              <span className="material-symbols-rounded">
                {collapsed ? "expand_more" : "expand_less"}
              </span>
            </button>
            {group && (
              <button
                className="group-remove-btn"
                onClick={() => onRemoveGroup(group.id)}
                title="删除分组（订阅源移至未分组）"
              >
                <span className="material-symbols-rounded">close</span>
              </button>
            )}
          </div>
        </div>
        {/* 上移 / 下移分组按钮已移除：分组标题行的手柄可以直接拖到任意位置 */}
        {!collapsed && (
          <div className="feed-group-body">
            {groupFeeds.length === 0 ? (
              <div className="feeds-group-empty">无订阅源</div>
            ) : (
              <ul className="feeds-manage-list">
                {groupFeeds.map((feed) => renderFeedRow(feed))}
              </ul>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="feeds-tab">
      <div className="settings-card">
        <div className="settings-card-header">新建分组</div>
        <div className="feed-add-row">
          <input
            className="group-name-input"
            placeholder="输入分组名称"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddGroupClick();
            }}
          />
          <button
            className="btn-add-group"
            onClick={handleAddGroupClick}
            disabled={!newGroupName.trim()}
          >
            <span className="material-symbols-rounded">add</span>
            添加
          </button>
        </div>
      </div>

      {/* 拖拽排序的监听挂在这个容器上（原生事件，见上方 organizeListRef 说明）。
          容器本身不参与 keyed 重建：行/分组的顺序由各自的 key 驱动，重建容器会把
          拖拽过程中的 DOM 状态（拖拽中、落点提示）一起清掉。 */}
      <div ref={organizeListRef}>
        {groups.map((g) => renderGroupBlock(g.name, g.id, g))}

        {/* 未分组放在最后：与「未分组排在所有分组之后」的排序语义一致
            （src/lib/feedOrder.ts 的 groupRank），也让「把分组拖到未分组区块上 = 排到最后」
            这个落点规则不会自相矛盾 —— 它就在最下面。 */}
        {renderGroupBlock("未分组", null)}
      </div>
    </div>
  );
}
