/*
 * 文件名: AddFeedModal.tsx
 * 描述: Fluent 2 ContentDialog — 添加订阅源
 */
import { useState, type FormEvent } from "react";
import * as rssService from "../services/rssService";

interface AddFeedModalProps {
  onClose: () => void;
  onAdd: (url: string) => Promise<void>;
}

export function AddFeedModal({ onClose, onAdd }: AddFeedModalProps): JSX.Element {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>添加订阅源</h2>
        <form onSubmit={(e) => void handleSubmit(e)}>
          <label htmlFor="feed-url">RSS / Atom 地址</label>
          <input
            id="feed-url"
            className="f2-text-field"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/feed.xml"
            autoFocus
            disabled={loading}
          />
          {error && <div className="modal-error" role="alert">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="f2-btn-standard" onClick={onClose} disabled={loading}>
              取消
            </button>
            <button type="submit" className="f2-btn-accent" disabled={loading}>
              {loading ? "获取中…" : "添加"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
