/*
 * 文件名: F2Select.tsx
 * 描述: Fluent 2 自定义下拉选择（替代原生 <select>）
 *
 * 为什么不用原生 <select>：弹出列表由操作系统/WebView 渲染，跟随 Windows 系统
 * 深浅色而非应用内主题 —— 暗色应用在浅色系统上会弹出白色列表，与界面割裂。
 * 自绘下拉的菜单是普通 DOM，颜色完全由设计令牌控制。
 *
 * 外观沿用 translate-picker 的形态（按钮 + 右侧展开箭头 + 菜单项选中打勾），
 * 尺寸可用 className 传入（如 settings-select 的宽度）。
 */
import { useEffect, useRef, useState } from "react";
import { useAnchoredDropdown } from "../../../lib/useAnchoredDropdown";

export interface F2SelectOption {
  value: string;
  label: string;
}

interface F2SelectProps {
  value: string;
  options: readonly F2SelectOption[];
  onChange: (value: string) => void;
  /** 附加到根容器的类名（控制宽度等布局细节） */
  className?: string;
  title?: string;
  /** 无障碍标签（aria-label） */
  ariaLabel?: string;
  /** 禁用时只展示不响应 */
  disabled?: boolean;
}

export function F2Select({
  value,
  options,
  onChange,
  className,
  title,
  ariaLabel,
  disabled,
}: F2SelectProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  // fixed 定位 + 视口收边：不受滚动容器 overflow 裁剪
  const { menuRef, menuStyle } = useAnchoredDropdown<HTMLDivElement>(open, rootRef);

  // 打开时点外面或按 Esc 收起（mousedown 与全局右键守卫、其他下拉同一套写法）
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = options.find((option) => option.value === value);

  return (
    <span className={`f2-select toolbar-dropdown ${className ?? ""}`} ref={rootRef}>
      <button
        type="button"
        className="f2-select-btn"
        onClick={() => setOpen((o) => !o)}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
      >
        <span className="f2-select-current">{current?.label ?? value}</span>
        <span className="material-symbols-rounded">expand_more</span>
      </button>
      {open && (
        <div className="dropdown-menu" role="listbox" ref={menuRef} style={menuStyle}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`dropdown-item ${option.value === value ? "selected" : ""}`}
              onClick={() => {
                setOpen(false);
                if (option.value !== value) onChange(option.value);
              }}
            >
              <span className="dropdown-item-name">{option.label}</span>
              {option.value === value && (
                <span className="material-symbols-rounded">check</span>
              )}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
