# Reader

Your LLMs deserve better input.

Reader can do two things:
1. It converts any URL to an **LLM-friendly** input with a simple prefix `https://r.jina.ai/`. Get improved output for your agent and RAG systems at no cost.
2. It searches the web for a given query by simply using `https://s.jina.ai/your+query`. This allows your LLMs to access the latest world knowledge from the web.

- Live demo: https://jina.ai/reader#demo
- Or just visit these URLs https://r.jina.ai/https://github.com/jina-ai/reader, https://s.jina.ai/Who%20will%20win%202024%20US%20presidential%20election%3F and see yourself.

> Feel free to use Reader API in production. It is free, stable and scalable. We are maintaining it actively as one of the core products of Jina AI.

<img width="973" alt="image" src="https://github.com/jina-ai/reader/assets/2041322/2067c7a2-c12e-4465-b107-9a16ca178d41">
<img width="973" alt="image" src="https://github.com/jina-ai/reader/assets/2041322/675ac203-f246-41c2-b094-76318240159f">


## Updates

- **2024-05-15**: We introduced a new endpoint `s.jina.ai` that searches on the web and return top-5 results, each in a LLM-friendly format. [Read more about this new feature here](https://jina.ai/news/jina-reader-for-search-grounding-to-improve-factuality-of-llms).
- **2024-05-08**: Image capion is off by default for better latency. To turn it on, set `x-with-generated-alt: true` in the request header.
- **2024-05-03**: We finally resolved a DDoS attack since April 29th. Now our API is much more reliable and scalable than ever!
- **2024-04-24**: You now have more fine-grained control over Reader API [using headers](#using-request-headers), e.g. forwarding cookies, using HTTP proxy.
- **2024-04-15**: Reader now supports image reading! It captions all images at the specified URL and adds `Image [idx]: [caption]` as an alt tag (if they initially lack one). This enables downstream LLMs to interact with the images in reasoning, summarizing etc. [See example here](https://x.com/JinaAI_/status/1780094402071023926).

## Usage

### Using `r.jina.ai` for single URL fetching
Simply prepend `https://r.jina.ai/` to any URL. For example, to convert the URL `https://en.wikipedia.org/wiki/Artificial_intelligence` to an LLM-friendly input, use the following URL:

[https://r.jina.ai/https://en.wikipedia.org/wiki/Artificial_intelligence](https://r.jina.ai/https://en.wikipedia.org/wiki/Artificial_intelligence)

All images in that page that lack `alt` tag are auto-captioned by a VLM (vision langauge model) and formatted as `!(Image [idx]: [VLM_caption])[img_URL]`. This should give your downstream text-only LLM *just enough* hints to include those images into reasoning, selecting, and summarization. 

### Using `s.jina.ai` for web search
Simply prepend `https://s.jina.ai/` to your search query. Note that if you are using this in the code, make sure to encode your search query first, e.g. if your query is `Who will win 2024 US presidential election?` then your url should look like:

[https://s.jina.ai/Who%20will%20win%202024%20US%20presidential%20election%3F](https://s.jina.ai/Who%20will%20win%202024%20US%20presidential%20election%3F)

Behind the scenes, Reader searches the web, fetches the top 5 results, visits each URL, and applies `r.jina.ai` to it. This is different from many `web search function-calling` in agent/RAG frameworks, which often return only the title, URL, and description provided by the search engine API. If you want to read one result more deeply, you have to fetch the content yourself from that URL. With Reader, `http://s.jina.ai` automatically fetches the content from the top 5 search result URLs for you (reusing the tech stack behind `http://r.jina.ai`). This means you don't have to handle browser rendering, blocking, or any issues related to JavaScript and CSS yourself.

### [Interactive Code Snippet Builder](https://jina.ai/reader#apiform)

We highly recommend using the code builder to explore different parameter combinations of the Reader API.

<a href="https://jina.ai/reader#apiform"><img width="973" alt="image" src="https://github.com/jina-ai/reader/assets/2041322/a490fd3a-1c4c-4a3f-a95a-c481c2a8cc8f"></a>


### Using request headers

As you have already seen above, one can control the behavior of the Reader API using request headers. Here is a complete list of supported headers.

- You can enable the image caption feature via the `x-with-generated-alt: true` header.
- You can ask the Reader API to forward cookies settings via the `x-set-cookie` header.
  - Note that requests with cookies will not be cached.
- You can bypass `readability` filtering via the `x-respond-with` header, specifically:
  - `x-respond-with: markdown` returns markdown *without* going through `reability`
  - `x-respond-with: html` returns `documentElement.outerHTML`
  - `x-respond-with: text` returns `document.body.innerText`
  - `x-respond-with: screenshot` returns the URL of the webpage's screenshot
- You can specify a proxy server via the `x-proxy-url` header.
- You can bypass the cached page (lifetime 300s) via the `x-no-cache` header.


### Streaming mode

Streaming mode is useful when you find that the standard mode provides an incomplete result. This is because the Reader will wait a bit longer until the page is *stablely* rendered. Use the accept-header to toggle the streaming mode:

```bash
curl -H "Accept: text/event-stream" https://r.jina.ai/https://en.m.wikipedia.org/wiki/Main_Page
```

The data comes in a stream; each subsequent chunk contains more complete information. **The last chunk should provide the most complete and final result.** If you come from LLMs, please note that it is a different behavior than the LLMs' text-generation streaming.

For example, compare these two curl commands below. You can see streaming one gives you complete information at last, whereas standard mode does not. This is because the content loading on this particular site is triggered by some js *after* the page is fully loaded, and standard mode returns the page "too soon".
```bash
curl -H 'x-no-cache: true' https://access.redhat.com/security/cve/CVE-2023-45853
curl -H "Accept: text/event-stream" -H 'x-no-cache: true' https://r.jina.ai/https://access.redhat.com/security/cve/CVE-2023-45853
```

> Note: `-H 'x-no-cache: true'` is used only for demonstration purposes to bypass the cache.

Streaming mode is also useful if your downstream LLM/agent system requires immediate content delivery or needs to process data in chunks to interleave I/O and LLM processing times. This allows for quicker access and more efficient data handling:

```text
Reader API:  streamContent1 ----> streamContent2 ----> streamContent3 ---> ... 
                          |                    |                     |
                          v                    |                     |
Your LLM:                 LLM(streamContent1)  |                     |
                                               v                     |
                                               LLM(streamContent2)   |
                                                                     v
                                                                     LLM(streamContent3)
```

Note that in terms of completeness: `... > streamContent3 > streamContent2 > streamContent1`, each subsequent chunk contains more complete information.

### JSON mode

This is still very early and the result is not really a "useful" JSON. It contains three fields `url`, `title` and `content` only. Nonetheless, you can use accept-header to control the output format:
```bash
curl -H "Accept: application/json" https://r.jina.ai/https://en.m.wikipedia.org/wiki/Main_Page
```

JSON mode is probably more useful in `s.jina.ai` than `r.jina.ai`. For `s.jina.ai` with JSON mode, it returns 5 results in a list, each in the structure of `{'title', 'content', 'url'}`.

## Install

You will need the following tools to run the project:
- Node v18 (The build fails for Node version >18)
- Firebase CLI (`npm install -g firebase-tools`)

For backend, go to the `backend/functions` directory and install the npm dependencies.

```bash
git clone git@github.com:jina-ai/reader.git
cd backend/functions
npm install
```

## What is `thinapps-shared` submodule?

You might notice a reference to `thinapps-shared` submodule, an internal package we use to share code across our products. While it’s not open-sourced and isn't integral to the Reader's functions, it mainly helps with decorators, logging, secrets management, etc. Feel free to ignore it for now.

That said, this is *the single codebase* behind `https://r.jina.ai`, so everytime we commit here, we will deploy the new version to the `https://r.jina.ai`.

## Having trouble on some websites?
Please raise an issue with the URL you are having trouble with. We will look into it and try to fix it.

## License
Reader is backed by [Jina AI](https://jina.ai) and licensed under [Apache-2.0](./LICENSE).
