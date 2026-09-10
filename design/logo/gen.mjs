// 生成 RSS Reader 应用图标 SVG：暗夜霓虹方向（现代 / 年轻向）。
// 运行：node design/logo/gen.mjs
// 产出：design/logo/rss-reader.svg（图标版）、design/logo/rss-reader-mono.svg（单色版）
// 落地：node node_modules/@tauri-apps/cli/tauri.js icon design/logo/rss-reader.svg
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = dirname(fileURLToPath(import.meta.url));
const S = 1024;
const n = (v) => Math.round(v * 100) / 100;

// ── 几何：左下圆点 + 两条沿弧长渐宽的弧（超圆角底板） ──────────────────
const O = { x: 284, y: 737 }; // 涟漪原点
const DOT_R = 124;
const BANDS = [
  { rc: 292, wStart: 116, wEnd: 124 }, // 内弧：中心线半径 / 起点宽 / 终点宽
  { rc: 512, wStart: 124, wEnd: 136 }, // 外弧
];
const CORNER = 240; // 底板超圆角半径（1024 画布）

/**
 * 一条四分之一圆的弧带（正上 90° → 正右 0°），宽度由 wStart 线性过渡到 wEnd，
 * 两端半圆端头 —— 用填充路径而非 stroke，才能做出沿弧长渐宽的扇面张力。
 */
function arcBand({ x: cx, y: cy }, rc, wStart, wEnd, steps = 48) {
  const inner = [];
  const outer = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const th = (Math.PI / 2) * (1 - t);
    const w = wStart + (wEnd - wStart) * t;
    const c = Math.cos(th);
    const s = Math.sin(th);
    inner.push([n(cx + (rc - w / 2) * c), n(cy - (rc - w / 2) * s)]);
    outer.push([n(cx + (rc + w / 2) * c), n(cy - (rc + w / 2) * s)]);
  }
  const p = (pt) => `${pt[0]} ${pt[1]}`;
  return (
    `M${p(inner[0])}A${n(wStart / 2)} ${n(wStart / 2)} 0 0 1 ${p(outer[0])}` +
    outer.slice(1).map((pt) => `L${p(pt)}`).join("") +
    `A${n(wEnd / 2)} ${n(wEnd / 2)} 0 0 1 ${p(inner[steps])}` +
    inner.slice(0, -1).reverse().map((pt) => `L${p(pt)}`).join("") +
    "Z"
  );
}

function squircle(r) {
  const k = n(r * 0.5523);
  const a = n(1024 - r);
  const k1 = n(a + r * 0.5523);
  const k2 = n(r - r * 0.5523);
  return (
    `M${r} 0H${a}` +
    `C${k1} 0 1024 ${k2} 1024 ${r}` +
    `V${a}` +
    `C1024 ${k1} ${k1} 1024 ${a} 1024` +
    `H${r}` +
    `C${k2} 1024 0 ${k1} 0 ${a}` +
    `V${r}` +
    `C0 ${k2} ${k2} 0 ${r} 0Z`
  );
}

const SQ = squircle(CORNER);
const bandPaths = BANDS.map((b) => arcBand(O, b.rc, b.wStart, b.wEnd));
const MARKS = `<circle cx="${O.x}" cy="${O.y}" r="${DOT_R}"/>
    <path d="${bandPaths[0]}"/>
    <path d="${bandPaths[1]}"/>`;

const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" fill="none" role="img" aria-label="RSS Reader">
  <title>RSS Reader 应用图标</title>
  <defs>
    <!-- 底板：近黑深紫，左上透出一层紫光 -->
    <linearGradient id="g-base" x1="120" y1="80" x2="920" y2="960" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#171034"/>
      <stop offset="0.55" stop-color="#0A0817"/>
      <stop offset="1" stop-color="#05040B"/>
    </linearGradient>
    <radialGradient id="g-ambient" cx="0.34" cy="0.16" r="0.82">
      <stop offset="0" stop-color="#5B2BE0" stop-opacity="0.42"/>
      <stop offset="1" stop-color="#5B2BE0" stop-opacity="0"/>
    </radialGradient>
    <!-- 符号：亮青 → 淡蓝紫，保证缩到 16px 仍是高对比实心 -->
    <linearGradient id="g-mark" x1="${O.x}" y1="${O.y - 580}" x2="${O.x + 580}" y2="${O.y}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#B6FFF0"/>
      <stop offset="0.42" stop-color="#63F5F0"/>
      <stop offset="1" stop-color="#9FC0FF"/>
    </linearGradient>
    <!-- 外发光只在下层，轮廓本身不加模糊 -->
    <filter id="g-blur" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="13"/>
    </filter>
    <clipPath id="g-clip"><path d="${SQ}"/></clipPath>
  </defs>

  <g clip-path="url(#g-clip)">
    <rect width="${S}" height="${S}" fill="url(#g-base)"/>
    <rect width="${S}" height="${S}" fill="url(#g-ambient)"/>
  </g>

  <g fill="url(#g-mark)">
    <g filter="url(#g-blur)" opacity="0.85" fill="#2CE9FF">${MARKS}</g>
    ${MARKS}
  </g>
</svg>
`;

// 单色版：透明底 + currentColor，供界面内、README、文档使用
const mono = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" fill="none" role="img" aria-label="RSS Reader">
  <title>RSS Reader 标记（单色）</title>
  <g fill="currentColor">
    ${MARKS}
  </g>
</svg>
`;

writeFileSync(join(OUT, "rss-reader.svg"), icon, "utf8");
writeFileSync(join(OUT, "rss-reader-mono.svg"), mono, "utf8");
console.log("wrote rss-reader.svg + rss-reader-mono.svg");
