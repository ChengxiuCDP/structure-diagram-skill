/**
 * 把三种输入统一成一组「已渲染的 SVG 标记」。
 *
 * 为什么要三种：结构示意图通常写成组件，源码里的坐标是表达式（x={x + w / 2}），
 * 静态读源码量不出几何。真正能检查的只有渲染结果，所以默认路径是渲染后再检查。
 *
 *   --url  <url>    抓页面 HTML，取其中的 <svg>（有 dev server 时最省事）
 *   --tsx  <file>   就地把组件转译并 SSR 成静态标记（不需要起服务）
 *   <file>          文件本身已经是 SVG / HTML 标记
 */
import { createRequire } from "node:module";
import { readFile, writeFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SVG_BLOCK = /<svg\b[\s\S]*?<\/svg>/g;

export function extractSvgs(markup) {
  return markup.match(SVG_BLOCK) ?? [];
}

/** 从 CSS 里读 class -> font-size(px)，用于估算 <text> 宽度。 */
export function parseFontSizes(css) {
  const sizes = new Map();
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const explicit = body.match(/font-size:\s*([\d.]+)px/);
    const shorthand = body.match(/\bfont:\s*[^;]*?([\d.]+)px/);
    const size = Number(explicit?.[1] ?? shorthand?.[1]);
    if (!Number.isFinite(size)) continue;
    for (const [, cls] of selector.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
      if (!sizes.has(cls)) sizes.set(cls, size);
    }
  }
  return sizes;
}

/** 从 CSS 里读 class -> letter-spacing(px)。字距会实打实地加宽标签：
 *  0.08em 在 36 字符的标签上就是 +31px，不算进去会漏判压字。 */
export function parseLetterSpacing(css, fontSizes) {
  const spacing = new Map();
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const match = body.match(/letter-spacing:\s*(-?[\d.]+)(em|px|rem)/);
    if (!match) continue;
    for (const [, cls] of selector.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
      if (spacing.has(cls)) continue;
      const value = Number(match[1]);
      spacing.set(cls, match[2] === "px" ? value : value * (fontSizes.get(cls) ?? 11));
    }
  }
  return spacing;
}

/** 从 CSS 里读 --token: value，用于光栅化时把 var() 还原成真实色值。 */
export function parseTokens(css) {
  const tokens = new Map();
  for (const [, name, value] of css.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;{}]+);/g)) {
    if (!tokens.has(name)) tokens.set(name, value.trim());
  }
  return tokens;
}

async function renderTsx(file, projectRoot) {
  const require_ = createRequire(join(projectRoot, "noop.js"));
  let esbuild;
  let server;
  try {
    esbuild = require_("esbuild");
    server = await import(pathToFileURL(require_.resolve("react-dom/server")).href);
  } catch {
    throw new Error(
      `--tsx 需要在 ${projectRoot} 解析到 esbuild 与 react-dom。` +
        `\n改用 --url 指向 dev server，或把渲染后的标记存成文件后直接传文件路径。`,
    );
  }

  const source = await readFile(file, "utf8");
  const { code } = await esbuild.transform(source, {
    loader: "tsx",
    jsx: "automatic",
    format: "esm",
    target: "es2022",
  });

  // 组件文件可能不在 projectRoot 里（比如从 git 取出的基线），
  // 把裸模块名换成 projectRoot 解析出的绝对路径，相对 import 保持原样。
  const rewritten = code.replace(
    /(\bfrom\s*)["']([^."'][^"']*)["']/g,
    (match, prefix, specifier) => {
      try {
        return `${prefix}${JSON.stringify(pathToFileURL(require_.resolve(specifier)).href)}`;
      } catch {
        return match;
      }
    },
  );

  // 落在源文件旁边，相对 import 才解析得到；用完删掉。
  const temp = join(dirname(file), `.structure-diagram-${process.pid}.mjs`);
  await writeFile(temp, rewritten);
  try {
    const mod = await import(`${temp}?t=${Date.now()}`);
    const renderToStaticMarkup = server.renderToStaticMarkup ?? server.default?.renderToStaticMarkup;
    const reactModule = await import(pathToFileURL(require_.resolve("react")).href);
    const createElement = reactModule.createElement ?? reactModule.default?.createElement;
    const out = [];
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== "function" || !/^[A-Z]/.test(name)) continue;
      let markup;
      try {
        markup = renderToStaticMarkup(createElement(value));
      } catch (error) {
        out.push({ name, error: error.message, markup: "" });
        continue;
      }
      for (const svg of extractSvgs(markup)) out.push({ name, markup: svg });
    }
    return out;
  } finally {
    await rm(temp, { force: true });
  }
}

export async function loadSvgs({ input, url, tsx, projectRoot = process.cwd() }) {
  if (url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} 返回 ${response.status}`);
    const html = await response.text();
    return extractSvgs(html).map((markup, index) => ({ name: `${url}#${index + 1}`, markup }));
  }
  if (tsx) return renderTsx(resolve(tsx), projectRoot);
  const markup = await readFile(resolve(input), "utf8");
  const svgs = extractSvgs(markup);
  if (svgs.length === 0) throw new Error(`${input} 里没有找到 <svg>；组件源码请改用 --tsx。`);
  const label = basename(input);
  return svgs.map((m, index) => ({ name: `${label}#${index + 1}`, markup: m }));
}
