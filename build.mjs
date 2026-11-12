// Builds the static site from the content/ folder into dist/.
// No dependencies: run with `node build.mjs` (Node 18+).
//
//   content/site.json        site name, links, and the `preview` switch
//   content/home.md          Home page intro (Markdown + front matter)
//   content/about.md         About page intro (Markdown + front matter)
//   content/profile.json     products, experience, strengths, education
//   content/posts/*.md       one file per blog post — add a file, push, done
//   static/                  copied as-is (favicon, images…)

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, cpSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONTENT = join(ROOT, "content");
const OUT = join(ROOT, "dist");

// ------------------------------------------------------------------ helpers

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function write(path, data) {
  const file = join(OUT, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
}

function parseFrontMatter(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: src };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v === "true") v = true;
    else if (v === "false") v = false;
    else if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    data[kv[1]] = v;
  }
  return { data, body: src.slice(m[0].length) };
}

// --------------------------------------------------------- tiny Markdown

function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(esc(c)) - 1}\u0000`);
  s = esc(s);
  // Images and link targets are stashed too, so * and _ inside URLs are never treated as emphasis.
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `\u0000${codes.push({ raw: `<img src="${src}" alt="${alt}" loading="lazy">` }) - 1}\u0000`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) => `\u0001${codes.push({ raw: `<a href="${href}">` }) - 1}\u0001${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
  return s
    .replace(/\u0001(\d+)\u0001/g, (_, i) => codes[i].raw)
    .replace(/\u0000(\d+)\u0000/g, (_, i) => (typeof codes[i] === "string" ? `<code>${codes[i]}</code>` : codes[i].raw));
}

export function markdown(src) {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  const isBlockStart = (l) => /^(#{1,6}\s|```|>|\s*[-*]\s|\s*\d+\.\s|<)/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = line.match(/^```(\w*)/))) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code${m[1] ? ` class="language-${m[1]}"` : ""}>${esc(buf.join("\n"))}</code></pre>`);
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      const level = Math.min(Math.max(m[1].length, 2), 4); // the page title is the only <h1>
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
      i++;
    } else if (line.startsWith(">")) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith(">")) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${markdown(buf.join("\n"))}</blockquote>`);
    } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\.\s/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i])) {
        let item = lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, "");
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s/.test(lines[i])) item += " " + lines[i++].trim();
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
    } else if (line.startsWith("<")) {
      const buf = [];
      while (i < lines.length && lines[i].trim()) buf.push(lines[i++]);
      out.push(buf.join("\n")); // raw HTML block, passed through
    } else {
      const buf = [];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++].trim());
      const p = inline(buf.join(" "));
      out.push(/^<img [^>]+>$/.test(p) ? `<figure>${p}</figure>` : `<p>${p}</p>`);
    }
  }
  return out.join("\n");
}

// ------------------------------------------------------------------- data

const site = JSON.parse(readFileSync(join(CONTENT, "site.json"), "utf8"));
const profile = JSON.parse(readFileSync(join(CONTENT, "profile.json"), "utf8"));
const about = parseFrontMatter(readFileSync(join(CONTENT, "about.md"), "utf8"));
const home = parseFrontMatter(readFileSync(join(CONTENT, "home.md"), "utf8"));

const fmtDate = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const readTime = (html) => Math.max(1, Math.round(html.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length / 220));
const sourceName = (url) => { try { const h = new URL(url).hostname; return h.includes("linkedin") ? "LinkedIn" : h.replace(/^www\./, ""); } catch { return "the web"; } };

const posts = readdirSync(join(CONTENT, "posts"))
  .filter((f) => f.endsWith(".md"))
  .map((file) => {
    const { data, body } = parseFrontMatter(readFileSync(join(CONTENT, "posts", file), "utf8"));
    const name = basename(file, ".md");
    const dateFromName = name.match(/^(\d{4}-\d{2}-\d{2})-/)?.[1];
    const slug = data.slug || name.replace(/^\d{4}-\d{2}-\d{2}-/, "");
    const date = String(data.date || dateFromName || "");
    if (!data.title) throw new Error(`${file}: missing "title" in front matter`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${file}: missing or invalid "date" (use YYYY-MM-DD)`);
    return { ...data, slug, date, file, html: markdown(body) };
  })
  .filter((p) => !p.draft)
  .sort((a, b) => b.date.localeCompare(a.date));

const slugs = new Set();
for (const p of posts) {
  if (slugs.has(p.slug)) throw new Error(`Two posts share the slug "${p.slug}"`);
  slugs.add(p.slug);
}

// ----------------------------------------------------------------- layout

const CSS = readFileSync(join(ROOT, "static", "style.css"), "utf8");

function page({ title, path, content, description }) {
  const nav = [["/", "Writing"], ["/about/", "About"]]
    .map(([href, label]) => {
      const current = href === "/" ? path === "/" || path.startsWith("/blog/") : path.startsWith(href);
      return `<a href="${href}"${current ? ' aria-current="page"' : ""}>${label}</a>`;
    })
    .join("");
  const canonical = site.url ? `<link rel="canonical" href="${esc(site.url + path)}">` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description || site.description)}">
${site.preview ? '<meta name="robots" content="noindex,nofollow">' : ""}
${canonical}
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description || site.description)}">
<meta name="theme-color" content="#FBF8F3" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1A1917" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/rss+xml" title="${esc(site.name)}" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,400..800&family=Source+Serif+4:ital,opsz,wght@0,8..60,400..650;1,8..60,400&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<header><div class="wrap"><a class="logo" href="/"><span class="bp" aria-hidden="true"></span>${esc(site.name)}</a><nav>${nav}</nav></div></header>
<main><div class="wrap">${content}</div></main>
<footer><div class="wrap"><span>© ${new Date().getUTCFullYear()} ${esc(site.name)}</span><a href="/feed.xml">RSS feed</a></div></footer>
</body>
</html>`;
}

// App icon tile: the official icon from static/icons/ when there is one, otherwise a lettered tile.
function icon(name, src) {
  const img = src ? `<img src="${esc(src)}" alt="" width="64" height="64" loading="lazy">` : "";
  return `<span class="icon" aria-hidden="true"><span class="mono">${esc(name[0])}</span>${img}</span>`;
}

// ------------------------------------------------------------------ pages

function aboutPage() {
  const a = about.data;
  const products = profile.products.map((p) =>
    `<li>${icon(p.name, p.icon)}<strong>${esc(p.name)}</strong><span class="note">${esc(p.note)}</span></li>`).join("");
  const strengths = profile.strengths.map((s) => `<li><span class="bp" aria-hidden="true"></span>${esc(s)}</li>`).join("");
  const experience = profile.experience.map((e) => `
    <li><span class="when">${esc(e.dates)}</span>
      <div><h3>${esc(e.role)}</h3><p class="company">${esc(e.company)}</p><p>${esc(e.text)}</p></div>
    </li>`).join("");
  const links = site.links.map((l) => `<a href="${esc(l.url)}">${esc(l.label)}</a>`).join("");
  const content = `
<section class="hero">
  <h1 class="wordmark"><span class="bp" aria-hidden="true"></span><span class="word">${esc(site.name)}</span></h1>
  ${a.lead ? `<p class="lead">${esc(a.lead)}</p>` : ""}
</section>
<section class="prose intro">${markdown(about.body)}</section>
<section><h2>${esc(profile.productsTitle || "Products I've helped build")}</h2><div class="tray"><ul class="apps">${products}</ul></div></section>
<section><h2>Where I've worked</h2><ol class="timeline">${experience}</ol>
${profile.education ? `<p class="edu">${esc(profile.education)}</p>` : ""}</section>
<section><h2>What I'm good at</h2><ul class="skills">${strengths}</ul></section>
<section class="hello"><h2>Say hello</h2><p>${esc(a.hello || "")}</p>${links ? `<p class="links">${links}</p>` : ""}</section>`;
  return page({ title: `About | ${site.name}`, path: "/about/", content });
}

// Home: a short introduction, then every post, newest first.
function homePage() {
  const links = [...site.links.map((l) => `<a href="${esc(l.url)}">${esc(l.label)}</a>`), `<a href="/about/">More about me</a>`].join("");
  const items = posts.map((p) => `
    <li><a href="/blog/${p.slug}/">${esc(p.title)}</a>
      <p class="meta"><time datetime="${p.date}">${fmtDate(p.date)}</time><span>${readTime(p.html)} min read</span></p>
      ${p.summary ? `<p class="summary">${esc(p.summary)}</p>` : ""}</li>`).join("");
  const content = `
<section class="home-intro">
  <h1>${esc(home.data.greeting || site.name)}</h1>
  <div class="prose">${markdown(home.body)}</div>
  <p class="links">${links}</p>
</section>
<section class="writing">
  <h2>Writing</h2>
  <ul class="post-list">${items || "<li>No posts yet.</li>"}</ul>
</section>`;
  return page({ title: site.title, path: "/", content });
}

function postPage(p) {
  const source = p.source
    ? `<p class="source">Originally published on <a href="${esc(p.source)}">${esc(sourceName(p.source))}</a>.</p>`
    : "";
  const content = `<article>
<div class="post-head"><p class="meta"><span>${fmtDate(p.date)}</span><span>${readTime(p.html)} min read</span></p><h1>${esc(p.title)}</h1>${p.summary ? `<p class="lead">${esc(p.summary)}</p>` : ""}</div>
<div class="prose">${p.html}</div>
${source}<a class="back" href="/">All writing</a>
</article>`;
  return page({ title: `${p.title} | ${site.name}`, path: `/blog/${p.slug}/`, content, description: p.summary });
}

function notFoundPage() {
  return page({ title: `Not found | ${site.name}`, path: "", content: `<h1>Page not found</h1><p class="lead">That page doesn't exist. <a href="/">Go home</a>.</p>` });
}

function feed() {
  const base = site.url || "";
  const items = posts.map((p) => `<item><title>${esc(p.title)}</title><link>${base}/blog/${p.slug}/</link><guid>${base}/blog/${p.slug}/</guid><pubDate>${new Date(p.date + "T00:00:00Z").toUTCString()}</pubDate><description>${esc(p.summary || "")}</description></item>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(site.name)}</title><link>${base}/</link><description>${esc(site.description)}</description>${items}</channel></rss>`;
}

// ------------------------------------------------------------------ build

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(join(ROOT, "static"))) {
  if (f !== "style.css") cpSync(join(ROOT, "static", f), join(OUT, f), { recursive: true });
}
write("index.html", homePage());
write("about/index.html", aboutPage());
write("_redirects", "/blog /  301\n/blog/ /  301\n");
for (const p of posts) write(`blog/${p.slug}/index.html`, postPage(p));
write("404.html", notFoundPage());
write("feed.xml", feed());
write("robots.txt", site.preview ? "User-agent: *\nDisallow: /\n" : `User-agent: *\nAllow: /\n${site.url ? `Sitemap: ${site.url}/sitemap.xml\n` : ""}`);
if (!site.preview && site.url) {
  const urls = ["/", "/about/", ...posts.map((p) => `/blog/${p.slug}/`)];
  write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${site.url}${u}</loc></url>`).join("")}</urlset>`);
}
write("_headers", `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n${site.preview ? "  X-Robots-Tag: noindex, nofollow\n" : ""}`);

console.log(`Built ${posts.length} post(s) into dist/${site.preview ? " (preview mode: hidden from search engines)" : ""}`);
