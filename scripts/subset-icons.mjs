#!/usr/bin/env node
/*
 * 文件名: subset-icons.mjs
 * 描述: 重新生成图标字体子集（src/assets/fonts/material-symbols-rounded.woff2）。
 *
 * 完整 Material Symbols Rounded 约 5 MB，而项目只用到 40 余个图标；
 * 子集化后约 37 KB。新增图标后运行本脚本即可：
 *
 *   node scripts/subset-icons.mjs
 *
 * 依赖：uv（运行 fontTools / HarfBuzz）与网络（从 Google Fonts 取完整字体）。
 *
 * 注意两个坑：
 * 1. 连字目标字形名不一定等于图标名（如 file_upload 的连字指向 upload 字形），
 *    必须先从完整字体反查真实字形名，否则子集里会留下"目标缺失"的死规则；
 * 2. 连字输入字符（a-z / 0-9 / _）必须保留，否则浏览器无法把 "search" 合成图标；
 *    --no-layout-closure 用于避免把 4000+ 条连字全部拉进子集。
 * 最后用 HarfBuzz 实际整形逐个校验，确保每个图标都能被合成为单个字形。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, copyFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 不是图标、但恰好是合法连字名的代码标识符（数据值 / CSS / HTML 标签名）。
 * 自动提取时排除，避免把无关字形打进子集。
 */
const NON_ICON_TOKENS = new Set([
  "feed", "http", "light", "list", "radio", "source", "tab", "title",
]);

/** 递归收集 src 下 .ts/.tsx 里的字符串字面量与 JSX 文本标识符 */
function collectCandidates(dir) {
  const out = new Set();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const name of collectCandidates(path)) out.add(name);
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    const src = readFileSync(path, "utf8");
    for (const re of [/["'`]([a-z][a-z0-9_]{1,30})["'`]/g, />\s*([a-z][a-z0-9_]{1,30})\s*</g]) {
      let m;
      while ((m = re.exec(src))) out.add(m[1]);
    }
  }
  return out;
}

const FONT_CSS_URL =
  "https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200";
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const OUT = "src/assets/fonts/material-symbols-rounded.woff2";

/** 反查图标名 → 真实连字目标字形名 */
const MAP_PY = `
import json, sys
from fontTools.ttLib import TTFont

font = TTFont(sys.argv[1])
gsub = font["GSUB"].table

def unwrap(st):
    while hasattr(st, "ExtSubTable"):
        st = st.ExtSubTable
    return st

seq_to_glyph = {}
for lookup in gsub.LookupList.Lookup:
    for st in lookup.SubTable:
        s = unwrap(st)
        ligs = getattr(s, "ligatures", None)
        if ligs:
            for first, entries in ligs.items():
                for e in entries:
                    seq_to_glyph["".join([first] + list(e.Component))] = e.LigGlyph

result, missing = {}, []
for name in json.loads(sys.argv[2]):
    seq = name.replace("_", "underscore")
    if seq in seq_to_glyph:
        result[name] = seq_to_glyph[seq]
    else:
        missing.append(name)
print(json.dumps({"map": result, "missing": missing}))
`;

/** HarfBuzz 整形校验：每个图标名都必须合成为单个字形 */
const VERIFY_PY = `
import json, sys
import uharfbuzz as hb
from fontTools.ttLib import TTFont

path, icons = sys.argv[1], json.loads(sys.argv[2])
# HarfBuzz 不能直接读 woff2，先解压为 TTF 再整形
tt = TTFont(path)
tt.flavor = None
ttf_path = path + ".ttf"
tt.save(ttf_path)
face = hb.Face(open(ttf_path, "rb").read())
font = hb.Font(face)
bad = []
for name in icons:
    buf = hb.Buffer()
    buf.add_str(name)
    buf.guess_segment_properties()
    hb.shape(font, buf)
    if len(buf.glyph_infos) != 1:
        bad.append(f"{name}({len(buf.glyph_infos)} 个字形)")
print(f"字形数: {TTFont(path)['maxp'].numGlyphs}")
print("连字整形失败:", ", ".join(bad) if bad else "无")
sys.exit(1 if bad else 0)
`;

function run(cmd, args, env) {
  return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", env: { ...process.env, ...env } });
}

async function main() {
  const css = await fetch(FONT_CSS_URL, { headers: { "User-Agent": CHROME_UA } }).then((r) => r.text());
  const match = [...css.matchAll(/url\((https:\/\/[^)]+\.woff2)\)/g)].pop();
  if (!match) throw new Error("未能从 Google Fonts 解析出 woff2 地址");
  console.log("完整字体:", match[1]);

  const tmp = mkdtempSync(join(tmpdir(), "rss-icons-"));
  const full = join(tmp, "full.woff2");
  writeFileSync(full, Buffer.from(await fetch(match[1]).then((r) => r.arrayBuffer())));

  // 从源码自动提取候选标识符，再由完整字体判定哪些是真正的图标连字名
  const candidates = [...collectCandidates("src")].filter((c) => !NON_ICON_TOKENS.has(c));
  const mapPy = join(tmp, "map.py");
  writeFileSync(mapPy, MAP_PY);
  const mapped = JSON.parse(
    run("uvx", ["--from", "fonttools", "--with", "brotli", "python", mapPy, full, JSON.stringify(candidates)]).trim().split("\n").pop(),
  );
  const ICONS = Object.keys(mapped.map).sort();
  if (ICONS.length === 0) {
    throw new Error("未能从源码中提取到任何图标");
  }
  const targetGlyphs = [...new Set(Object.values(mapped.map))];
  console.log(`源码提取图标 ${ICONS.length} 个 → 目标字形 ${targetGlyphs.length} 个`);
  console.log("图标清单:", ICONS.join(", "));

  const subset = join(tmp, "subset.woff2");
  execFileSync(
    "uvx",
    [
      "--from", "fonttools", "--with", "brotli", "pyftsubset", full,
      "--text=abcdefghijklmnopqrstuvwxyz0123456789_",
      `--glyphs=${targetGlyphs.join(",")}`,
      "--no-layout-closure",
      "--layout-features=rlig,rclt",
      "--name-IDs=*",
      "--flavor=woff2",
      `--output-file=${subset}`,
    ],
    { stdio: "inherit" },
  );

  const verifyPy = join(tmp, "verify.py");
  writeFileSync(verifyPy, VERIFY_PY);
  const report = run("uvx", [
    "--from", "fonttools", "--with", "brotli", "--with", "uharfbuzz",
    "python", verifyPy, subset, JSON.stringify(ICONS),
  ]);
  process.stdout.write(report);

  copyFileSync(subset, OUT);
  console.log("已写入", OUT);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
