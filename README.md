# Reader

Convert any URL to an LLM-friendly input with a simple prefix `https://r.jina.ai/`. Get improved output for your agent and RAG systems at no cost. Find more at https://jina.ai/reader.

## Usage

### Standard

To use the Reader, simply prepend `https://r.jina.ai/` to any URL. For example, to convert the URL `https://en.wikipedia.org/wiki/Artificial_intelligence` to an LLM-friendly input, use the following URL:

```bash
https://r.jina.ai/https://en.wikipedia.org/wiki/Artificial_intelligence
```

### Streaming mode

Use accept-header to control the streaming behavior:

```bash
curl -H "Accept: text/event-stream" https://r.jina.ai/https://en.m.wikipedia.org/wiki/Main_Page
```

### JSON mode

This is still very early and the result is not really a good JSON but three simple field `url`, `title` and `content`. You can use accept-header to control the output format:
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

## About `[thinapps-shared](thinapps-shared)`

You might notice a reference to `thinapps-shared` submodule, an internal package we use to share code across our products. While it’s not yet open-sourced and isn't integral to the Reader's primary functions, it helps with logging, syntax enhancements, etc. Feel free to disregard it for now.

## License
Apache License 2.0