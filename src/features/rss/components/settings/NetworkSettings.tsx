/*
 * 文件名: NetworkSettings.tsx
 * 描述: 设置面板「网络」分区：HTTP / SOCKS5 代理配置（格式校验 + 端口草稿 + 连通性测试）。
 */
import { useEffect, useState } from "react";
import type { ProxyPrefs } from "../../../../lib/preferences";
import * as rssService from "../../services/rssService";

/** 规范化代理主机：剥离误填的 scheme 前缀与结尾斜杠（与 Rust 侧 normalize_proxy_host 对齐） */
function normalizeProxyHost(host: string): string {
  return host.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

/** 校验代理主机：非空，且能与端口拼出合法 URL（镜像 Rust 侧 http/socks5://{host}:{port} 的拼装方式） */
function proxyHostError(host: string): string | null {
  const trimmed = normalizeProxyHost(host);
  if (!trimmed) return "请输入代理主机";
  try {
    const parsed = new URL(`http://${trimmed}:1`);
    return parsed.hostname ? null : "代理主机格式不正确";
  } catch {
    return "代理主机格式不正确";
  }
}

/** 校验代理端口：1-65535 的整数 */
function proxyPortError(port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "端口需为 1-65535 的整数";
  }
  return null;
}

interface NetworkSettingsProps {
  proxy: ProxyPrefs;
  onProxyChange: (proxy: ProxyPrefs) => void;
}

export function NetworkSettings({ proxy, onProxyChange }: NetworkSettingsProps): JSX.Element {
  // 端口草稿（允许输入中间态，仅合法值向上同步）+ 连接测试
  const [portDraft, setPortDraft] = useState<string>(String(proxy.port));
  const [testingProxy, setTestingProxy] = useState(false);
  const [proxyTestResult, setProxyTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  // 外部端口值变化时同步草稿（如偏好被其他途径更新）
  useEffect(() => {
    setPortDraft(String(proxy.port));
  }, [proxy.port]);

  /** 端口输入：草稿实时更新，仅合法值同步到偏好（避免输入中间态被强行改写为默认值） */
  const handlePortDraftChange = (value: string): void => {
    setPortDraft(value);
    const parsed = Number(value);
    if (value.trim() !== "" && proxyPortError(parsed) === null) {
      onProxyChange({ ...proxy, port: parsed });
    }
  };

  /** 端口失焦：非法草稿回滚为当前生效值 */
  const handlePortDraftBlur = (): void => {
    if (proxyPortError(Number(portDraft)) !== null) {
      setPortDraft(String(proxy.port));
    }
  };

  /** 主机失焦：剥离 scheme 与结尾斜杠，并拆出误填在主机里的端口（如 127.0.0.1:7890） */
  const handleHostBlur = (): void => {
    let host = normalizeProxyHost(proxy.host);
    let port = portDraft;
    const colon = host.lastIndexOf(":");
    if (colon > -1 && !host.startsWith("[") && /^\d+$/.test(host.slice(colon + 1))) {
      port = host.slice(colon + 1);
      host = host.slice(0, colon);
    }
    const portChanged = port !== portDraft;
    const hostChanged = host !== proxy.host;
    if (!hostChanged && !portChanged) return;
    if (portChanged) setPortDraft(port);
    const parsedPort = Number(port);
    onProxyChange({
      ...proxy,
      host,
      ...(proxyPortError(parsedPort) === null ? { port: parsedPort } : {}),
    });
  };

  /** 代理连通性测试：经 Rust 侧通过代理请求探测地址 */
  const handleTestProxy = async (): Promise<void> => {
    const host = normalizeProxyHost(proxy.host);
    if (proxyHostError(host) !== null || proxyPortError(Number(portDraft)) !== null) return;
    setTestingProxy(true);
    setProxyTestResult(null);
    try {
      const result = await rssService.testProxy(host, Number(portDraft), proxy.kind);
      const probeHost = new URL(result.target).host;
      setProxyTestResult({
        ok: true,
        text: `连接成功（${probeHost}，${result.latency_ms} ms）`,
      });
    } catch (err) {
      setProxyTestResult({ ok: false, text: `连接失败：${String(err)}` });
    } finally {
      setTestingProxy(false);
    }
  };

  // 代理配置校验（启用代理时展示错误并禁用测试按钮）
  const proxyHostErr = proxyHostError(proxy.host);
  const proxyPortErr = portDraft.trim() === "" ? "请输入代理端口" : proxyPortError(Number(portDraft));
  const proxyError = proxyHostErr ?? proxyPortErr;
  const proxyValid = proxyError === null;

  return (
    <div className="network-tab">
      <div className="settings-card settings-card--rows">
        <div className="settings-card-header">代理设置</div>
        <div className="settings-field">
          <label>HTTP 代理</label>
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={proxy.enabled}
              onChange={(e) => {
                onProxyChange({ ...proxy, enabled: e.target.checked });
                setProxyTestResult(null);
              }}
            />
            启用代理
          </label>
        </div>
        {proxy.enabled && (
          <>
            <div className="settings-field">
              <label htmlFor="proxy-kind">代理类型</label>
              <select
                id="proxy-kind"
                className="settings-select"
                value={proxy.kind}
                onChange={(e) => {
                  onProxyChange({ ...proxy, kind: e.target.value as ProxyPrefs["kind"] });
                  setProxyTestResult(null);
                }}
              >
                <option value="http">HTTP</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </div>
            <div className="settings-field">
              <label htmlFor="proxy-host">代理主机</label>
              <input
                id="proxy-host"
                className="settings-text-input"
                type="text"
                placeholder="127.0.0.1 或 proxy.example.com"
                value={proxy.host}
                onChange={(e) =>
                  onProxyChange({ ...proxy, host: e.target.value })
                }
                onBlur={handleHostBlur}
              />
            </div>
            <div className="settings-field">
              <label htmlFor="proxy-port">代理端口</label>
              <input
                id="proxy-port"
                className="settings-text-input"
                type="text"
                inputMode="numeric"
                placeholder="8080"
                value={portDraft}
                onChange={(e) => handlePortDraftChange(e.target.value)}
                onBlur={handlePortDraftBlur}
              />
            </div>
            <div className="settings-field">
              <label>连接测试</label>
              <div className="settings-inline">
                <button
                  className="f2-btn-standard"
                  onClick={() => void handleTestProxy()}
                  disabled={!proxyValid || testingProxy}
                >
                  {testingProxy ? "测试中…" : "测试连接"}
                </button>
                {proxyTestResult && (
                  <span
                    className={
                      proxyTestResult.ok ? "form-text-success" : "form-text-error"
                    }
                  >
                    {proxyTestResult.text}
                  </span>
                )}
              </div>
            </div>
          </>
        )}
      </div>
      {proxy.enabled && proxyError && (
        <div className="modal-error" role="alert">{proxyError}</div>
      )}
    </div>
  );
}
