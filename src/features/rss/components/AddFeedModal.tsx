/*
 * 文件名: AddFeedModal.tsx
 * 描述: Fluent 2 ContentDialog — 添加订阅源
 */
import { useEffect, useState, type FormEvent } from "react";
import * as rssService from "../services/rssService";

interface AddFeedModalProps {
  onClose: () => void;
  onAdd: (url: string) => Promise<void>;
  /** 深链等场景预填的地址 */
  initialUrl?: string;
}

export function AddFeedModal({ onClose, onAdd, initialUrl }: AddFeedModalProps): JSX.Element {
  const [url, setUrl] = useState(initialUrl ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Esc 关闭；抓取中不响应，避免打断已发出的请求
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !loading) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [loading, onClose]);

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) {
      setError("请输入订阅源 URL");
      return;
    }
    if (!rssService.isValidHttpUrl(trimmed)) {
      setError("请输入以 http:// 或 https:// 开头的合法 URL");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await onAdd(trimmed);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={loading ? undefined : onClose}>
      <div
        className="modal modal-add-feed"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-feed-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="material-symbols-rounded modal-head-icon">rss_feed</span>
          <div>
            <h2 id="add-feed-title">添加订阅源</h2>
            <p className="modal-subtitle">支持 RSS 2.0 / Atom / JSON Feed</p>
          </div>
        </div>

        {/* noValidate：交给应用自己的中文提示，不用浏览器原生的英文校验气泡 */}
        <form onSubmit={(e) => void handleSubmit(e)} noValidate>
          <label htmlFor="feed-url">订阅源地址</label>
          <input
            id="feed-url"
            className="f2-text-field"
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (error) setError(null);
            }}
            placeholder="https://example.com/feed.xml"
            autoFocus
            disabled={loading}
            aria-invalid={error !== null}
          />
          {error && (
            <div className="modal-error" role="alert">
              {error}
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="f2-btn-standard" onClick={onClose} disabled={loading}>
              取消
            </button>
            <button
              type="submit"
              className="f2-btn-accent"
              disabled={loading || url.trim() === ""}
            >
              {loading ? "获取中…" : "添加"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
