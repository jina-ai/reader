
# Introduction
Jina Reader is an API-first SaaS application that turns URLs of web pages, PDFs and other documents into markdown or images.
It's meant for helping developers prepare data context for LLMs, now known as context engineering.

# Application Architecture
Jina Reader is a multi-threaded Node.js application. 
It renders web pages using headless Chrome browser, and extracts text content using numerous techniques.
PDF parsing and rendering are done using PDF.js.
MS Office documents are processed using LibreOffice.

# Stateless Core features

## URL to Markdown / Image
Given a URL, Jina Reader fetches the content and renders it using headless Chrome if it's a web page (HTML/xHTML).
If the content is a PDF, it uses PDF.js to parse and render the PDF.
For MS Office documents, it uses LibreOffice to convert them to PDF+HTML first, and then processes the PDF/HTML.

Advanced options are provided to filter or manipulate the page content, such as CSS-selector based filtering, or custom JavaScript execution.
Traffic manipulation is also possible by providing custom proxy options.

## HTML to Markdown
Jina Reader can also take raw HTML and convert it to markdown, using the same HTML to Markdown conversion techniques as the URL to Markdown feature.
## PDF to Markdown / Image
Jina Reader can take a PDF file and extract text content as markdown, and also render each page as an image.
## MS Office to Markdown / Image
Jina Reader can take MS Office documents (Word, Excel, PowerPoint) and convert them to markdown or images, by first converting them to PDF/HTML using LibreOffice
## Image to Text
Jina Reader can take an image and provide a text description of the image (captioning).
This feature is based on `jina-vlm` small vision language model and can be extended to do VQA tasks. Note this is not exactly OCR.

# Multiple URL to HTML engines
Jina Reader supports multiple engines for rendering web pages to HTML
## Browser
The most used engine. Current implementation involves using latest headless Chrome through the `puppeteer` library. It provides the most accurate rendering of web pages, and is able to execute JavaScript on the page, which is essential for modern web pages.
## CURL
A lightweight engine that uses `curl-impersonate` to fetch the raw HTML content of a web page. It does not execute JavaScript.
Reader's implementation includes a simulated cookie layer to help with basic cookie-based redirection.
## CF-Browser-Rendering
Uses Cloudflare's Browser Rendering RESTful API for URL-to-HTML. Strict rate limits apply, this is meant for testing and fallback purposes.
## Auto
This is the default. Reader implementation will intelligently use Curl and Browser engines in combination, depending on the content and requirements.

# Multiple HTML to Markdown profiles
Jina Reader supports multiple profiles for converting HTML to Markdown.
## use of @mozilla/readability
Readability is automatically used to clean HTML before converting to markdown. 
It provides a clean and readable version of the HTML content for some pages.
## html to markdown
### Rule based engine
A custom implementation inspired by the `turndown` library with custom rules and plugins to convert HTML into markdown.
### ReaderLM v2
An experimental engine that uses a specifically trained small language model to convert HTML to markdown.
### ReaderLM v3 / vlm
WIP/Future engine that uses a vision language model to convert Webpage Screenshot to markdown.

# Abuse alleviation (SaaS)
- Request filtering: Block requests targeting suspicious addresses.
- Request throttling: Capped concurrent requests per page.
- Excessive requests from single page opened by anonymous users: Temporarily blocking the WEBSITE for anonymous users.
- Excessive HTML nodes/depth: Fallback to html to text instead of markdown.

# Progressive clustering
- Stage 0: Fully stateless, no caching, no rate limit, no persistence.
- Stage 1: S3-like object storage for caching, no rate limit.
- Stage 2: MongoDB storage + S3-like object storage. MongoDB indexing of object storage stored cache, rate limiting available. This is the SaaS version.


# Vendor provided features
- Proxy: Reader supports having a built-in proxy provider for fetching contents using another IP.
- SERP: Reader primary relies on external SERP providers to provide web search results.
- VLM: Reader relies on a visual language model for image captioning. This model is currently Gemini-2.5-flash-lite, but can be switched to any other model with similar capabilities.

# Deployment Architecture
SaaS version of Jina Reader is currently deployed in Docker image on GCP Cloud Run.
MongoDB Atlas is used for metadata indexing and rate limiting, and Google Cloud Storage is used for cache data storage.
Internal services and dependencies such as billing and `jina-vlm`, `readerlm-v2` are communicated through private VPC peering.
We have deployed two independent clusters, US and EU. US cluster has 3 regions (us-central1, us-east1, us-west1) and EU cluster has 1 region(europe-west1).

Due to the high resource requirements of headless Chrome and LibreOffice, it's best to be deployed on serverless platforms that takes care of auto-scaling and resource management.