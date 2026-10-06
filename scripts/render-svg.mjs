#!/usr/bin/env node
/**
 * 把内联 SVG 离屏光栅化成 PNG，用来「自己看一眼」。
 *
 * 为什么需要：度量能抓重叠与溢出，抓不出「难看」——上一轮两张图各有一大片空白，
 * 所有静态检查都是绿的，只有看到图才发现。浏览器截图并不总是可用（pane 隐藏、
 * 滚动失效），所以留一条不依赖浏览器的通道。
 *
 * 用法：
 *   render-svg.mjs --tsx app/project-diagrams.tsx --css app/globals.css --out .tmp/diagrams
 *   render-svg.mjs --url http://localhost:3000/projects/session-eval --css app/globals.css --out .tmp/x
 *
 * sharp 解析不到时不会崩：仍然写出已还原色值的独立 .svg，可用别的工具打开。
 */
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadSvgs, parseTokens } from "./lib/load-svgs.mjs";

/** var(--x, fallback) 逐层还原；token 之间可以互相引用，所以要迭代。 */
function resolveVars(text, tokens) {
  let out = text;
  for (let pass = 0; pass < 5 && out.includes("var("); pass += 1) {
    out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (match, name, fallback) =>
      tokens.get(name) ?? fallback?.trim() ?? match);
  }
  return out;
}

/** 只挑与本图用到的 class 相关的规则，避免把整份样式表塞进 <style>。 */
function relevantCss(css, markup) {
  const used = new Set();
  for (const [, value] of markup.matchAll(/\bclass="([^"]*)"/g)) {
    for (const cls of value.split(/\s+/)) if (cls) used.add(cls);
  }
  const kept = [];
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const classes = [...selector.matchAll(/\.([A-Za-z0-9_-]+)/g)].map(([, c]) => c);
    if (!classes.length || !classes.some((c) => used.has(c))) continue;
    // 去掉容器/伪类选择器，只保留能作用到 SVG 内部的部分。
    const simple = selector.split(",").map((s) => s.trim())
      .filter((s) => !/[:>]|\s\.|^\.project-diagram(__|\s|$)/.test(s) || /\stext$/.test(s));
    if (simple.length) kept.push(`${simple.join(", ")} { ${body.trim()} }`);
  }
  return kept.join("\n");
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
  const outDir = flag("--out") ?? ".tmp/diagrams";
  const scale = Number(flag("--scale") ?? 2);
  const input = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));

  if (!url && !tsx && !input) {
    console.error("用法：render-svg.mjs [--tsx <file> | --url <url> | <file>] [--css <file>] [--out <dir>] [--scale 2]");
    process.exit(2);
  }

  const css = cssPath ? await readFile(cssPath, "utf8") : "";
  const tokens = parseTokens(css);
  const paper = tokens.get("--paper") ?? "#ffffff";
  const svgs = await loadSvgs({ input, url, tsx });
  await mkdir(outDir, { recursive: true });

  let sharp = null;
  try {
    sharp = createRequire(join(process.cwd(), "noop.js"))("sharp");
  } catch {
    console.warn("解析不到 sharp，只写出 .svg，不生成 PNG。（npm i -D sharp 或用别的工具打开）\n");
  }

  for (const [index, { name, markup, error }] of svgs.entries()) {
    if (error) { console.warn(`${name} 渲染失败：${error}`); continue; }
    const viewBox = (markup.match(/viewBox="([^"]*)"/)?.[1] ?? "0 0 800 400").split(/[\s,]+/).map(Number);
    const [, , vw, vh] = viewBox;
    const style = resolveVars(relevantCss(css, markup), tokens);
    const body = resolveVars(markup, tokens)
      .replace(/<svg\b[^>]*>/, (tag) =>
        `${tag.replace(/\s(width|height)="[^"]*"/g, "")}\n<style>${style}</style>` +
        `\n<rect x="${viewBox[0]}" y="${viewBox[1]}" width="${vw}" height="${vh}" fill="${paper}" />`)
      .replace(/<svg\b/, `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}"`);

    const base = join(outDir, `${String(index + 1).padStart(2, "0")}-${name.replace(/[^\w.-]+/g, "_")}`);
    await writeFile(`${base}.svg`, body);
    if (sharp) {
      await sharp(Buffer.from(body), { density: 72 * scale })
        .resize({ width: Math.round(vw * scale) })
        .png()
        .toFile(`${base}.png`);
    }
    console.log(`${base}${sharp ? ".png" : ".svg"}  (${vw}×${vh})`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(2);
});
