# syntax=docker/dockerfile:1
FROM node:24 AS base

FROM base AS build-amd64
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y libreoffice google-chrome-stable fonts-noto-cjk-extra fonts-noto-color-emoji fonts-liberation fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 zstd libc++-dev \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*
ENV OVERRIDE_CHROME_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

FROM base AS build-arm64
RUN apt-get update \
    && apt-get install -y libreoffice chromium fonts-noto-cjk-extra fonts-noto-color-emoji fonts-liberation fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 zstd libc++-dev \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*
ENV OVERRIDE_CHROME_EXECUTABLE_PATH=/usr/bin/chromium

FROM build-${TARGETARCH} AS final
RUN groupadd -r jina
RUN useradd -g jina  -G audio,video -m jina
USER jina
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY build ./build
COPY public ./public
COPY licensed ./licensed
RUN rm -rf ~/.config/chromium && mkdir -p ~/.config/chromium
RUN NODE_COMPILE_CACHE=node_modules npm run dry-run
ENV NODE_COMPILE_CACHE=node_modules
ENV PORT=8080
EXPOSE 3000 3001 8080 8081
ENTRYPOINT ["node"]
CMD [ "build/stand-alone/crawl.js" ]
