import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installLinkGuard } from "./lib/linkGuard";
import "./styles.css";

// 拦截正文链接的 WebView 整页跳转，改为系统浏览器打开
installLinkGuard();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);