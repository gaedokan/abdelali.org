# abdelali.org

Personal site and blog of AbdelAli — built from plain Markdown files and deployed automatically to Cloudflare (free plan) on every push to `main`.

## Publish a new blog post

1. Add a Markdown file to `content/posts/`, named `YYYY-MM-DD-your-post-slug.md`:

   ~~~markdown
   ---
   title: My new post
   summary: One or two sentences shown on the blog list and in search results.
   ---

   Write the post here in **Markdown**.

   ## A heading

   - lists, `inline code`, [links](https://example.com), > quotes
   - images: ![alt text](https://…/image.png) or put files in `static/` and use `/image.png`

   ```swift
   let code = "fenced blocks work too"
   ```
   ~~~

2. Commit and push to `main` (or create the file directly on github.com).
3. That's it — Cloudflare rebuilds and deploys the site in about a minute.

The date comes from the file name, and the URL from the rest of it: `2026-05-01-hello.md` → `/blog/hello/`.

Optional front-matter fields: `date` (overrides the file name), `slug` (overrides the URL), `source` (link to where it was first published — shows "Originally published on …"), and `draft: true` (keeps the file in the repo without publishing it).

## Budget app

A personal budgeting app lives in `budget/` (Angular) and is published at `/budget/`. Its sync API runs in `worker/index.ts`.
See [budget/README.md](budget/README.md) for features, sync setup (D1 + password) and the iPhone Wallet shortcut.

## Edit other content

| What | Where |
| --- | --- |
| Home page intro | `content/home.md` |
| About page intro text | `content/about.md` |
| Products grid, experience, strengths, education | `content/profile.json` |
| Site name, description, social links | `content/site.json` |
| Design (colors, fonts, spacing) | `static/style.css` |

## Going live

While `"preview": true` is set in `content/site.json`, every page tells search engines not to index it. The site has no custom domain: it is only served at `abdelali-site.<account>.workers.dev`, which must stay behind Cloudflare Access (Workers & Pages → abdelali-site → Settings → Domains & Routes → workers.dev → turn on Cloudflare Access, then allow only your email in Zero Trust → Access → Applications).

To launch: set `"preview": false`, push, and attach the custom domain `abdelali.org` to the `abdelali-site` Worker in Cloudflare (Workers & Pages → abdelali-site → Settings → Domains & Routes).

## Run it locally

```sh
npm run build     # generates dist/
npm run dev       # build + serve locally with Wrangler
```

The blog generator has no dependencies (`build.mjs`, Node.js 18+). The budget app in `budget/` is installed and built automatically by `npm run build`.
