#!/usr/bin/env node
/**
 * 结构示意图静态检查。
 *
 * 抓的是「度量得出来的错」，不是审美：标签互相压、跑出画布、写死色值、缺无障碍文本、
 * 同页多图 marker id 撞车。这几类上一轮全部真实发生过，靠肉眼一次都没抓到。
 *
 * 用法：
 *   check-svg-geometry.mjs --tsx app/project-diagrams.tsx --css app/globals.css
 *   check-svg-geometry.mjs --url http://localhost:3000/projects/session-eval --css app/globals.css
 *   check-svg-geometry.mjs rendered.svg
 *
 * 退出码非 0 表示存在 error 级问题。warn 只提示，不阻断。
 */
import { readFile } from "node:fs/promises";
import { loadSvgs, parseFontSizes, parseLetterSpacing } from "./lib/load-svgs.mjs";

const DEFAULT_FONT_SIZE = 11;
// 等宽字体的推进宽度：西文约 0.6em，中日韩与全角标点占满 1em。
const WIDE = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
];

function isWide(code) {
  return WIDE.some(([lo, hi]) => code >= lo && code <= hi);
}

function textWidth(text, fontSize) {
  let em = 0;
  for (const ch of text) em += isWide(ch.codePointAt(0)) ? 1 : 0.6;
  return em * fontSize;
}

function attrs(tag) {
  const map = new Map();
  for (const [, key, value] of tag.matchAll(/([:\w-]+)="([^"]*)"/g)) map.set(key, value);
  return map;
}

function num(map, key, fallback = NaN) {
  const value = Number(map.get(key));
  return Number.isFinite(value) ? value : fallback;
}

function plainText(inner) {
  return inner
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classesOf(map) {
  return (map.get("class") ?? "").split(/\s+/).filter(Boolean);
}

function letterSpacingOf(map, spacings) {
  const explicit = map.get("letter-spacing");
  if (explicit && /px$/.test(explicit)) return Number.parseFloat(explicit);
  for (const cls of classesOf(map)) {
    if (spacings.has(cls)) return spacings.get(cls);
  }
  return 0;
}

function fontSizeOf(map, fontSizes) {
  const explicit = num(map, "font-size");
  if (Number.isFinite(explicit)) return explicit;
  for (const cls of classesOf(map)) {
    if (fontSizes.has(cls)) return fontSizes.get(cls);
  }
  return DEFAULT_FONT_SIZE;
}

function textBoxes(markup, fontSizes, spacings) {
  const boxes = [];
  for (const [, tag, inner] of markup.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const map = attrs(`<text${tag}>`);
    const content = plainText(inner);
    if (!content) continue;
    const x = num(map, "x", 0);
    const y = num(map, "y", 0);
    const size = fontSizeOf(map, fontSizes);
    // 字距加在每个字符之后，末尾那一份不占视觉宽度。
    const width = textWidth(content, size) + Math.max(0, [...content].length - 1) * letterSpacingOf(map, spacings);
    const anchor = map.get("text-anchor") ?? "start";
    const left = anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
    // y 是基线：上方约 0.8em 是字身，下方约 0.2em 是下伸部。
    boxes.push({ text: content, left, right: left + width, top: y - size * 0.8, bottom: y + size * 0.2 });
  }
  return boxes;
}

/** 只取真正的数字字面量：按分隔符 split 会把首尾空串变成 0，整体错位一个坐标。 */
function numbersIn(source) {
  return (source.match(/-?\d*\.?\d+(?:[eE][+-]?\d+)?/g) ?? []).map(Number).filter(Number.isFinite);
}

function shapeExtents(markup) {
  const shapes = [];
  const push = (kind, xs, ys, soft = false) => {
    const fx = xs.filter(Number.isFinite);
    const fy = ys.filter(Number.isFinite);
    if (!fx.length || !fy.length) return;
    shapes.push({ kind, soft, left: Math.min(...fx), right: Math.max(...fx), top: Math.min(...fy), bottom: Math.max(...fy) });
  };
  for (const [, tag] of markup.matchAll(/<rect\b([^>]*)>/g)) {
    const m = attrs(`<rect${tag}>`);
    const x = num(m, "x", 0), y = num(m, "y", 0);
    push("rect", [x, x + num(m, "width", 0)], [y, y + num(m, "height", 0)]);
  }
  for (const [, tag] of markup.matchAll(/<line\b([^>]*)>/g)) {
    const m = attrs(`<line${tag}>`);
    push("line", [num(m, "x1"), num(m, "x2")], [num(m, "y1"), num(m, "y2")]);
  }
  for (const [, name, tag] of markup.matchAll(/<(polygon|polyline)\b([^>]*)>/g)) {
    const m = attrs(`<${name}${tag}>`);
    const nums = numbersIn(m.get("points") ?? "");
    push(name, nums.filter((_, i) => i % 2 === 0), nums.filter((_, i) => i % 2 === 1));
  }
  for (const [, tag] of markup.matchAll(/<circle\b([^>]*)>/g)) {
    const m = attrs(`<circle${tag}>`);
    const cx = num(m, "cx", 0), cy = num(m, "cy", 0), r = num(m, "r", 0);
    push("circle", [cx - r, cx + r], [cy - r, cy + r]);
  }
  for (const [, tag] of markup.matchAll(/<path\b([^>]*)>/g)) {
    const m = attrs(`<path${tag}>`);
    const nums = numbersIn(m.get("d") ?? "");
    // 直角折线取值精确；含曲线时控制点会被计入，所以只报 warn。
    push("path", nums.filter((_, i) => i % 2 === 0), nums.filter((_, i) => i % 2 === 1), true);
  }
  return shapes;
}

/** 抽出所有直线段。path 只解析绝对 M/L——正交折线正是这类图的主要连线形式。 */
function segments(markup) {
  const out = [];
  for (const [, tag] of markup.matchAll(/<line\b([^>]*)>/g)) {
    const m = attrs(`<line${tag}>`);
    out.push([num(m, "x1", 0), num(m, "y1", 0), num(m, "x2", 0), num(m, "y2", 0)]);
  }
  for (const [, name, tag] of markup.matchAll(/<(polygon|polyline)\b([^>]*)>/g)) {
    const m = attrs(`<${name}${tag}>`);
    const n = numbersIn(m.get("points") ?? "");
    for (let i = 0; i + 3 < n.length; i += 2) out.push([n[i], n[i + 1], n[i + 2], n[i + 3]]);
    if (name === "polygon" && n.length >= 4) out.push([n[n.length - 2], n[n.length - 1], n[0], n[1]]);
  }
  for (const [, tag] of markup.matchAll(/<path\b([^>]*)>/g)) {
    const d = attrs(`<path${tag}>`).get("d") ?? "";
    if (/[cqasthvCQASTHV]/.test(d.replace(/[eE]/g, ""))) continue; // 含曲线或相对指令就跳过
    const n = numbersIn(d);
    for (let i = 0; i + 3 < n.length; i += 2) out.push([n[i], n[i + 1], n[i + 2], n[i + 3]]);
  }
  return out;
}

/** Liang-Barsky：线段是否与矩形相交。 */
function hitsBox(seg, box, inset) {
  const [x0, y0, x1, y1] = seg;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - (box.left + inset), (box.right - inset) - x0, y0 - (box.top + inset), (box.bottom - inset) - y0];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i += 1) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
      else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
  }
  return true;
}

function checkSvg({ name, markup, error }, fontSizes, spacings, markerIds, findings) {
  const add = (level, message) => findings.push({ level, name, message });
  if (error) {
    add("error", `渲染失败：${error}`);
    return;
  }
  // marker 内部的坐标不是画布几何，先剥掉 <defs>。
  const body = markup.replace(/<defs\b[\s\S]*?<\/defs>/g, "");
  const svgTag = markup.match(/<svg\b[^>]*>/)?.[0] ?? "";
  const svgAttrs = attrs(svgTag);

  // 无障碍：图脱离视觉后语义必须仍然成立。
  const titles = [...markup.matchAll(/<title\b([^>]*)>([\s\S]*?)<\/title>/g)];
  const descs = [...markup.matchAll(/<desc\b([^>]*)>([\s\S]*?)<\/desc>/g)];
  if (!titles.length) add("error", "缺少 <title>");
  if (!descs.length) add("error", "缺少 <desc>");
  if (svgAttrs.get("role") !== "img") add("warn", 'svg 缺少 role="img"');
  const labelledBy = (svgAttrs.get("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
  if (labelledBy.length) {
    const ids = new Set([...titles, ...descs].map(([, tag]) => attrs(`<x${tag}>`).get("id")).filter(Boolean));
    for (const id of labelledBy) {
      if (!ids.has(id)) add("error", `aria-labelledby 指向不存在的 id：${id}`);
    }
  } else {
    add("warn", "svg 缺少 aria-labelledby");
  }
  for (const [, , inner] of descs) {
    if (plainText(inner).length < 40) add("warn", "<desc> 过短，未复述图形结构");
  }

  // 色值必须走 token，写死的颜色会绕过设计规范。
  for (const [, key, value] of markup.matchAll(/\b(fill|stroke|stop-color|style)="([^"]*)"/g)) {
    if (/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(value)) {
      add("error", `${key}="${value}" 是硬编码色值，应引用 token`);
    }
  }

  // 同页多图共用同一个 marker id 会互相污染。
  for (const [, tag] of markup.matchAll(/<marker\b([^>]*)>/g)) {
    const id = attrs(`<marker${tag}>`).get("id");
    if (!id) { add("error", "<marker> 缺少 id"); continue; }
    if (markerIds.has(id)) add("error", `marker id「${id}」与 ${markerIds.get(id)} 重复`);
    else markerIds.set(id, name);
  }

  const viewBox = (svgAttrs.get("viewBox") ?? "").split(/[\s,]+/).map(Number);
  const boxes = textBoxes(body, fontSizes, spacings);

  if (viewBox.length === 4 && viewBox.every(Number.isFinite)) {
    const [vx, vy, vw, vh] = viewBox;
    const outside = (b) => b.left < vx - 1 || b.top < vy - 1 || b.right > vx + vw + 1 || b.bottom > vy + vh + 1;
    for (const b of boxes) {
      if (outside(b)) add("error", `文字「${b.text}」超出 viewBox（${b.left.toFixed(0)}..${b.right.toFixed(0)} × ${b.top.toFixed(0)}..${b.bottom.toFixed(0)}）`);
    }
    for (const s of shapeExtents(body)) {
      if (outside(s)) add(s.soft ? "warn" : "error", `<${s.kind}> 超出 viewBox（${s.left.toFixed(0)}..${s.right.toFixed(0)} × ${s.top.toFixed(0)}..${s.bottom.toFixed(0)}）`);
    }
  } else {
    add("warn", "svg 缺少可解析的 viewBox");
  }

  // 连线穿过文字。垫底矩形断线是合法做法，所以只报 warn。
  for (const seg of segments(body)) {
    for (const b of boxes) {
      if (hitsBox(seg, b, 1)) {
        add("warn", `连线穿过文字「${b.text}」（若已用垫底矩形断线可忽略）`);
        break;
      }
    }
  }

  // 标签互相压：1px 容差，避免把紧邻误判成重叠。
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i], b = boxes[j];
      const dx = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const dy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (dx > 1 && dy > 1) {
        add("error", `文字重叠 ${dx.toFixed(1)}×${dy.toFixed(1)}px：「${a.text}」/「${b.text}」`);
      }
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const url = flag("--url");
  const tsx = flag("--tsx");
  const cssPath = flag("--css");
  const input = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1]?.startsWith("--") !== true);

  if (!url && !tsx && !input) {
    console.error("用法：check-svg-geometry.mjs [--tsx <file> | --url <url> | <file>] [--css <file>]");
    process.exit(2);
  }

  const css = cssPath ? await readFile(cssPath, "utf8") : "";
  const fontSizes = parseFontSizes(css);
  const spacings = parseLetterSpacing(css, fontSizes);
  if (!cssPath) console.warn(`未传 --css，全部 <text> 按 ${DEFAULT_FONT_SIZE}px 估算宽度。\n`);

  const svgs = await loadSvgs({ input, url, tsx });
  const findings = [];
  const markerIds = new Map();
  for (const svg of svgs) checkSvg(svg, fontSizes, spacings, markerIds, findings);

  const errors = findings.filter((f) => f.level === "error");
  const warns = findings.filter((f) => f.level === "warn");
  const byName = new Map();
  for (const f of findings) {
    if (!byName.has(f.name)) byName.set(f.name, []);
    byName.get(f.name).push(f);
  }
  for (const [name, list] of byName) {
    console.log(name);
    for (const f of list) console.log(`  ${f.level === "error" ? "✗" : "!"} ${f.message}`);
  }
  console.log(`\n检查 ${svgs.length} 张图：${errors.length} error / ${warns.length} warn`);
  if (errors.length) process.exit(1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(2);
});
