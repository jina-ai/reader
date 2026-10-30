# Reader

[![codecov](https://codecov.io/gh/jina-ai/reader/branch/main/graph/badge.svg)](https://codecov.io/gh/jina-ai/reader)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/jina-ai/reader)

Your LLMs deserve better input.

Reader does two things:
- **Read**: It converts any URL to an **LLM-friendly** input with `https://r.jina.ai/https://your.url`. Get improved output for your agent and RAG systems at no cost.
- **Search**: It searches the web for a given query with `https://s.jina.ai/your+query`. This allows your LLMs to access the latest world knowledge from the web.

Check out [the live demo](https://jina.ai/reader#demo)

Or just visit these URLs (**Read**) https://r.jina.ai/https://github.com/jina-ai/reader, (**Search**) https://s.jina.ai/Who%20will%20win%202024%20US%20presidential%20election%3F and see yourself.

> Feel free to use Reader API in production. It is free, stable and scalable. We are maintaining it actively as one of the core products of Jina AI. [Check out rate limit](https://jina.ai/reader#pricing)

<img width="973" alt="image" src="https://github.com/jina-ai/reader/assets/2041322/2067c7a2-c12e-4465-b107-9a16ca178d41">
<img width="973" alt="image" src="https://github.com/jina-ai/reader/assets/2041322/675ac203-f246-41c2-b094-76318240159f">

> This repository is the open source branch of the codebase behind `https://r.jina.ai` and `https://s.jina.ai`. It runs in stateless or bucket-cached mode; the MongoDB-backed SaaS storage layer is not included here.

## Updates

- **2026-04** — Re-synchronized the open source branch with the SaaS code. The MongoDB-backed storage layer is stripped; the oss branch runs in stateless mode out of the box, with optional MinIO/S3-compatible bucket caching via `docker compose`. See [Local development](#local-development).
- **2025-12** — Storage layer decoupled and binary file uploads landed. PDFs and MS Office documents (Word, Excel, PowerPoint) can now be POSTed directly via the `file` body field — no need to host them first. See [cookbooks.md](./cookbooks.md#pdf-ms-office-and-raw-html-uploads).
- **2025-03** — Major refactor: Reader is no longer a Firebase application. The SaaS migrated off Firestore + Cloud Functions to a Cloud Run image with MongoDB Atlas, removing the platform-coupled bits and unblocking the local-Docker path above.
- **2024-05** — `s.jina.ai` launched, extending Reader from URL→markdown to search→markdown. PDFs added the same month — any URL ending in `.pdf` is parsed with PDF.js and returned as markdown.
- **2024-04** — Reader released and `r.jina.ai` went live as Jina AI's first SaaS API for converting URLs to LLM-friendly input.

## What Reader can read

- **Web pages** — rendered with headless Chrome, or fetched lightweight via `curl-impersonate`. Reader picks intelligently between the two.
- **PDFs** — any URL, parsed with PDF.js. [See this NASA PDF result](https://r.jina.ai/https://www.nasa.gov/wp-content/uploads/2023/01/55583main_vision_space_exploration2.pdf) vs [the original](https://www.nasa.gov/wp-content/uploads/2023/01/55583main_vision_space_exploration2.pdf).
- **MS Office documents** — Word, Excel, PowerPoint, converted via LibreOffice and then processed as HTML/PDF.
- **Images** — captioned by a vision-language model, so your downstream text-only LLM gets *just enough* hints to reason about them.

## Usage

### Using `r.jina.ai` for single URL fetching
Simply prepend `https://r.jina.ai/` to any URL. For example, to convert the URL `https://en.wikipedia.org/wiki/Artificial_intelligence` to an LLM-friendly input, use the following URL:

[https://r.jina.ai/https://en.wikipedia.org/wiki/Artificial_intelligence](https://r.jina.ai/https://en.wikipedia.org/wiki/Artificial_intelligence)

### [Using `r.jina.ai` for a full website fetching (Google Colab)](https://colab.research.google.com/drive/1uoBy6_7BhxqpFQ45vuhgDDDGwstaCt4P#scrollTo=5LQjzJiT9ewT)

### Using `s.jina.ai` for web search
Simply prepend `https://s.jina.ai/` to your search query. Note that if you are using this in the code, make sure to encode your search query first, e.g. if your query is `Who will win 2024 US presidential election?` then your url should look like:

[https://s.jina.ai/Who%20will%20win%202024%20US%20presidential%20election%3F](https://s.jina.ai/Who%20will%20win%202024%20US%20presidential%20election%3F)

Behind the scenes, Reader searches the web, fetches the top 5 results, visits each URL, and applies `r.jina.ai` to it. This is different from many `web search function-calling` in agent/RAG frameworks, which often return only the title, URL, and description provided by the search engine API. If you want to read one result more deeply, you have to fetch the content yourself from that URL. With Reader, `http://s.jina.ai` automatically fetches the content from the top 5 search result URLs for you (reusing the tech stack behind `http://r.jina.ai`). This means you don't have to handle browser rendering, blocking, or any issues related to JavaScript and CSS yourself.

### Using `s.jina.ai` for in-site search
Simply specify `site` in the query parameters such as:

```bash
curl 'https://s.jina.ai/When%20was%20Jina%20AI%20founded%3F?site=jina.ai&site=github.com'
```

### [Interactive Code Snippet Builder](https://jina.ai/reader#apiform)

We highly recommend using the code builder to explore different parameter combinations of the Reader API.

<a href="https://jina.ai/reader#apiform"><img width="973" alt="image" src="https://github.com/jina-ai/reader/assets/2041322/a490fd3a-1c4c-4a3f-a95a-c481c2a8cc8f"></a>

### Using request headers

You can control the behavior of the Reader API using request headers. The list below covers the most useful ones — for the full surface with up-to-date defaults and validation rules, see the live API docs at [https://r.jina.ai/docs](https://r.jina.ai/docs), or the source of truth in [`src/dto/crawler-options.ts`](./src/dto/crawler-options.ts).

- `x-respond-with` — select the output format.
  - `markdown` returns markdown *without* going through `readability`
  - `html` returns `documentElement.outerHTML`
  - `text` returns `document.body.innerText`
  - `screenshot` returns the URL of the webpage's screenshot
  - `pageshot` similar to `screenshot` but tries to capture the whole page instead of just the viewport
  - `frontmatter` returns **Markdown with a YAML frontmatter block**. The default plain-text response uses a custom `Title: …` / `URL Source: …` header format; `frontmatter` replaces that with a front matter block. Example:

    ```bash
    curl -H 'X-Respond-With: frontmatter' 'https://r.jina.ai/https://example.com'
    ```

    ```markdown
    ---
    title: "Example Domain"
    description: "This domain is for use in illustrative examples."
    url: "https://example.com/"
    ---

    ## Example Domain

    This domain is for use in illustrative examples in documents. ...
    ```

  - `markdown+frontmatter` — like `frontmatter` but covers the full page without readability filtering.
- `x-engine` — enforces a fetching engine: `browser` (headless Chrome), `curl` (lightweight, no JS), or `auto` (the default — Combined use of both browser and curl).
- `x-proxy-url` — route the traffic through your designated proxy.
- `x-cache-tolerance` — integer seconds; how stale a cached page is acceptable.
- `x-no-cache: true` — bypass the cached page (lifetime 3600s). Equivalent to `x-cache-tolerance: 0`.
- `x-target-selector` — a CSS selector. Reader returns content within the matched element instead of the full page. Useful when automatic content extraction misses what you want.
- `x-wait-for-selector` — a CSS selector. Reader waits until the matched element is rendered before returning. If `x-target-selector` is set, this can be omitted to wait for the same element.
- `x-timeout` — integer seconds (max 180). When set, Reader will not return early; it waits for network idle or until the timeout is reached.
- `x-max-tokens` — integer (≥500). Trim the response so it never exceeds this many tokens. Useful as a per-request guardrail when feeding a fixed-size context window — Reader truncates rather than rejects.
- `x-token-budget` — integer. Reject the request if the resulting content would exceed this many tokens. Use this when *over*-budget output is worse than no output (e.g. cost control). Ignored on the search endpoint.
- `x-respond-timing` — explicit control over *when* Reader is willing to return. Trade off latency against completeness:
  - `html` — return as soon as the raw HTML lands. No JS execution, no waiting.
  - `visible-content` — return the moment readable content is parseable. Lowest latency that still produces text.
  - `mutation-idle` — wait for DOM mutations to settle for ≥0.2s. Good default for SPAs that lazy-render above the fold.
  - `resource-idle` — wait for content-affecting resources to finish loading (≥0.5s quiet). The default heuristic for content-shaped requests.
  - `media-idle` — wait for media (images, video, fonts) to also finish. Use with `screenshot` / `pageshot` / `vlm`.
  - `network-idle` — full `networkidle0`. Slowest, most complete. Implied when `x-timeout` ≥ 20.

  When omitted, Reader picks one based on `x-respond-with`, `x-timeout`, and `x-with-iframe`. See `presumedRespondTiming` in [src/dto/crawler-options.ts](./src/dto/crawler-options.ts) for the exact rules.
- `x-with-generated-alt: true` — caption images on the page with a VLM.
- `x-mirror-fallback: true` — opt-in mirror fallback. When the target blocks the reader (403/block page), retry the request through a public, read-only mirror of the same content (currently: Reddit thread URLs via a Redlib instance) and annotate the response so mirrored content is never silently presented as the original. Off by default; also enable server-wide with `MIRROR_FALLBACK=true`. See [Having trouble on some websites?](#having-trouble-on-some-websites) for the trust caveats.
- `x-retain-images` — control how images survive into the output:
  - `all` (default) — keep `![alt](url)` markdown for every image.
  - `none` — drop images entirely.
  - `alt` — keep alt text only, no URLs. Cheap on tokens; useful when the downstream LLM has no use for the image link.
- `x-retain-links` — control how links survive into the output:
  - `all` (default) — keep `[text](url)` markdown.
  - `none` — drop links entirely.
  - `text` — keep link anchor text only, drop URLs. Best for embedding / semantic-index pipelines where URLs are noise.
  - `gpt-oss` — emit citations in gpt-oss's `【{id}†...】` format and append a numbered URL footer (also auto-enables `x-with-links-summary`).
- `x-retain-media` — control how `<video>`, `<audio>`, and embedded video iframes (`<iframe>` from YouTube, Vimeo, Bilibili, etc.) appear in the output:
  - `link` (default) — markdown link, e.g. `[Video 1](url)`. Embedded iframes are rewritten to their canonical watch URL. Respects `x-md-link-style`.
  - `none` — drop media entirely; non-video iframes fall back to their inner text content.
  - `text` — bare label only, e.g. `Video 1` or `Audio 1`. No URL.
  - `image` — markdown image syntax, e.g. `![Video 1](url)`.
  - `html` — the original HTML element with cosmetic attributes (`class`, `id`, `style`, `data-*`, `aria-*`) stripped. Embedded video iframes keep their original embed `src` rather than the canonical watch URL.
- `x-with-links-summary` / `x-with-images-summary` — append a deduplicated footer of all links / images to the output. Combine with `x-retain-links: text` or `x-retain-images: alt` to get inline anchor/alt text plus *one* canonical URL list at the end — convenient when you want the model to see URLs without paying for them inline. `x-with-links-summary: all` keeps every link instead of only the unique ones.
- `x-markdown-chunking` — opt-in semantic chunking of the markdown response. Returns a JSON array (or ``-delimited text) of chunks instead of one blob:
  - `true` / `h1` … `h5` — heading-based split at the given heading level (e.g. `h3` chunks at `#`, `##`, and `###`).
  - `structured` / `s1` … `s5` — block-level structured split. `s1` is coarsest, `s5` finest.
- `x-preset` — apply a pre-packaged option bundle for common scenarios. Preset values only take effect for options the caller does *not* set explicitly (via body or another header). See [cookbooks.md](./cookbooks.md#using-presets) for examples.
  - `reader` — for displaying content to human users.
  - `index` — for semantic indexing / embedding pipelines.
  - `research` — for AI research agents needing structured, citable output.
  - `agent` — for AI agents doing everyday browsing tasks.
  - `spider` — for recursive site crawling with a full link inventory.
- `x-detach-invisibles` — detach elements with eventual `display:none` before snapshotting. Implies browser engine; disables caching.
- `x-set-cookie` — forward cookie settings. Requests with cookies are not cached.
- `x-md-*` — fine-tune markdown output (heading style, bullet markers, link style, etc.). See [src/dto/turndown-tweakable-options.ts](./src/dto/turndown-tweakable-options.ts).

### Using `r.jina.ai` for single page application (SPA) fetching
Many websites nowadays rely on JavaScript frameworks and client-side rendering, usually known as Single Page Applications (SPA). Thanks to [Puppeteer](https://github.com/puppeteer/puppeteer) and headless Chrome, Reader natively supports fetching these websites. However, due to specific approaches some SPAs are developed with, there may be some extra precautions to take.

#### SPAs with hash-based routing
By definition of the web standards, content after `#` in a URL is not sent to the server. To mitigate this, use `POST` with the `url` parameter in the body:

```bash
curl -X POST 'https://r.jina.ai/' -d 'url=https://example.com/#/route'
```

#### SPAs with preloading contents
Some SPAs (and even some non-SPAs) show preload content before later loading the main content dynamically. In this case, Reader may capture the preload content instead. Two ways to mitigate:

```bash
# wait for network idle or until timeout
curl 'https://r.jina.ai/https://example.com/' -H 'x-timeout: 10'

# wait for a specific element
curl 'https://r.jina.ai/https://example.com/' -H 'x-wait-for-selector: #content'

# combined use of both to wait for non-existent element (which means waiting for the full timeout duration)
curl 'https://r.jina.ai/https://example.com/' -H 'x-timeout: 30' -H 'x-wait-for-selector: non-existent-element'
```

### JSON mode

Use the accept-header to control the output format:

```bash
curl -H "Accept: application/json" https://r.jina.ai/https://en.m.wikipedia.org/wiki/Main_Page
```

### Generated alt

All images on a page that lack an `alt` tag can be auto-captioned by a VLM (vision-language model) and formatted as `![Image [idx]: [VLM_caption]](img_URL)`. This should give your downstream text-only LLM *just enough* hints to include those images in reasoning, selection, and summarization:

```bash
curl -H "X-With-Generated-Alt: true" https://r.jina.ai/https://en.m.wikipedia.org/wiki/Main_Page
```

## Cookbooks

For pipeline-specific recipes — RAG, semantic indexing, deep research, agentic browsing, visual snapshots, PDF/Office/HTML uploads, and more — see [cookbooks.md](./cookbooks.md). Each entry is a short curl example with the header combination that fits the use case and a paragraph explaining the trade-offs.

## Self-host with Docker

A prebuilt image of the open-source branch is published to GitHub Container Registry. It bundles headless Chrome, LibreOffice, and CJK fonts, so you can run Reader without building it yourself.

```bash
docker pull ghcr.io/jina-ai/reader:oss
```

### Run

The image exposes two ports:

- `8080` — **h2c** (HTTP/2 cleartext). Production-grade, multiplexed; this is what Cloud Run talks to. Plain `curl` won't speak it without `--http2-prior-knowledge`.
- `8081` — **HTTP/1.1** fallback. Same handler, same routes; use this from anything that doesn't speak h2c.

For a quick try-out from `curl` or a browser, map the HTTP/1.1 port:

```bash
docker run --rm -p 3000:8081 ghcr.io/jina-ai/reader:oss
# then: curl http://localhost:3000/https://example.com
```

For load-testing or production-shape traffic, map the h2c port instead (or both):

```bash
docker run --rm -p 3000:8080 -p 3001:8081 ghcr.io/jina-ai/reader:oss
```

With no extra config the container is fully stateless — every request hits the live URL, no cache, no rate limiting. That's the right default for a quick try-out, CI, or throwaway environments.

### Run with caching

Point Reader at an S3-compatible bucket to cache fetched pages and reuse them across requests:

```bash
docker run --rm -p 3000:8081 \
  -e GCP_STORAGE_ENDPOINT=https://s3.example.com \
  -e GCP_STORAGE_BUCKET=reader-cache \
  -e GCP_STORAGE_ACCESS_KEY=... \
  -e GCP_STORAGE_SECRET_KEY=... \
  ghcr.io/jina-ai/reader:oss
```

See [CONTRIBUTING.md](./CONTRIBUTING.md#environment-variables) for the full env-var table.

## Local development

Requirements:
- nvm use
- Docker *(optional — only if you want a local MinIO bucket cache)*

```bash
git clone git@github.com:jina-ai/reader.git
cd reader
npm install
# Optional, for bucket-cached mode:
docker compose up -d
```

Then either press `F5` in VSCode to launch the debugger, or after setting up the appropriate environment variables:

```bash
npm run dev
```

For a deeper tour of the codebase — engines, formatting profiles, abuse alleviation, deployment topology — see [architecture.md](./architecture.md). For dev workflow, env vars, and tests, see [CONTRIBUTING.md](./CONTRIBUTING.md).

### Licensed assets

A few non-redistributable artifacts live in `licensed/` and are needed at build/runtime:

- `GeoLite2-City.mmdb` and `geolite2-asn.mmdb` — MaxMind GeoLite databases (geolocation + ASN lookups).
- `SourceHanSansSC-Regular.otf` — Source Han Sans (CJK rendering for PDFs/screenshots).
- `gsa_useragents.txt` — user-agent list used by the curl engine.

Fetch them in one shot:

```bash
npm run assets:download
```

The script (`download-external-assets.sh`) is idempotent — it skips files already present and exits 0 even on partial network failure. Set `FORCE_DOWNLOAD_EXTERNAL=1` to overwrite, or `SKIP_DOWNLOAD_EXTERNAL=1` to bypass entirely if you supply your own copies. The repo's CI fetches the same URLs inline; this script exists for local convenience.

## How it works
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/jina-ai/reader)

## Having trouble on some websites?

Some sites push back against scrapers — bot challenges, geo blocks, stale CDN edges. A few knobs to try, in roughly increasing order of "this is bothering me":

- **Use an API key.** Anonymous traffic is the most aggressively rate-limited and lands in the lowest-trust pool. Authenticated requests get a higher quota and access to features like the internal proxy. Get one at [jina.ai/reader](https://jina.ai/reader#pricing).
- **Bypass the cache** with `-H 'x-no-cache: true'`. If a stale or already-blocked response got cached, this forces a fresh fetch.
- **Force the browser engine** with `-H 'x-engine: browser'`. The default `auto` engine prefers the lightweight curl path when it can; some sites only serve real content to a JS-capable browser.
- **Route through the SaaS proxy** with `-H 'x-proxy: auto'` (key required). Reader's hosted proxy pool rotates residential / datacenter IPs and handles common anti-bot challenges automatically. You can also pin a country, e.g. `x-proxy: us` (see [Geo- and locale-sensitive scraping](./cookbooks.md#geo--and-locale-sensitive-scraping)).
- **Bring your own proxy** with `-H 'x-proxy-url: <url>'`. As a last resort — when even the hosted proxy can't get through — buy a residential or ISP-grade proxy from a third-party provider (BrightData, Thordata, Oxylabs, etc.) and pass the URL directly. Supports `http`, `https`, `socks4`, `socks5`; for auth use `https://user:pass@host:port`.
- **Opt-in mirror fallback** with `-H 'x-mirror-fallback: true'` (or `MIRROR_FALLBACK=true` server-wide). When a target blocks the reader outright, the request is retried through a public, read-only mirror of the same content — currently Reddit thread URLs via a Redlib instance — and the response is annotated with a warning naming the mirror. Two caveats: a mirror is run by a third party who can see the requested URLs, and public mirrors are disposable (they can go down or add bot gates at any time; gated/blocked/near-empty mirror results are skipped, not served). Never use it for pages that require a login: no credentials are ever sent to a mirror.

If none of those help, please open an issue with the URL and the headers you tried — we'll take a look.

## License

Reader is backed by [Jina AI](https://jina.ai) and licensed under [Apache-2.0](./LICENSE).
