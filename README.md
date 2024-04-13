# Reader

Your LLMs deserve better input.

Convert any URL to an **LLM-friendly** input with a simple prefix `https://r.jina.ai/`. Get improved output for your agent and RAG systems at no cost.

- Live demo: https://jina.ai/reader
- Or just visit this URL https://r.jina.ai/https://github.com/jina-ai/reader and see yourself.

![banner-reader-api.png](https://jina.ai/banner-reader-api.png)

## Usage

### Standard

To use the Reader, simply prepend `https://r.jina.ai/` to any URL. For example, to convert the URL `https://en.wikipedia.org/wiki/Artificial_intelligence` to an LLM-friendly input, use the following URL:

```bash
https://r.jina.ai/https://en.wikipedia.org/wiki/Artificial_intelligence
```

### Streaming mode

Use accept-header to control the streaming behavior:

> Note, if you run this example below and not see streaming output but a single response, it means someone else has just run this within 5 min you and the result is cached already. Hence, the server simply returns the result instantly. Try with a different URL and you will see the streaming output.
```bash
curl -H "Accept: text/event-stream" https://r.jina.ai/https://en.m.wikipedia.org/wiki/Main_Page
```

If your downstream LLM/agent system requires immediate content delivery or needs to process data in chunks to interleave the IO and LLM time, use Streaming Mode. This allows for quicker access and efficient handling of data:

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

### JSON mode

This is still very early and the result is not really a "useful" JSON. It contains three fields `url`, `title` and `content` only. Nonetheless, you can use accept-header to control the output format:
```bash
curl -H "Accept: application/json" https://r.jina.ai/https://en.m.wikipedia.org/wiki/Main_Page
```

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

## What is `[thinapps-shared](thinapps-shared)` submodule?

You might notice a reference to `thinapps-shared` submodule, an internal package we use to share code across our products. While it’s not open-sourced and isn't integral to the Reader's functions, it mainly helps with decorators, logging, secrets management, etc. Feel free to ignore it for now.

That said, this is *the single codebase* behind `https://r.jina.ai`, so everytime we commit here, we will deploy the new version to the `https://r.jina.ai`.

## Having trouble on some websites?
Please raise an issue with the URL you are having trouble with. We will look into it and try to fix it.

## License
Reader is backed by [Jina AI](https://jina.ai) and licensed under [Apache-2.0](./LICENSE).