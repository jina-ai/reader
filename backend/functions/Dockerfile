# syntax=docker/dockerfile:1
FROM lwthiker/curl-impersonate:0.6-chrome-slim-bullseye

FROM node:20

RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

COPY --from=0 /usr/local/lib/libcurl-impersonate.so /usr/local/lib/libcurl-impersonate.so

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

ENV LD_PRELOAD=/usr/local/lib/libcurl-impersonate.so CURL_IMPERSONATE=chrome116 CURL_IMPERSONATE_HEADERS=no

EXPOSE 3000 3001
ENTRYPOINT ["node"]
CMD [ "build/stand-alone/crawl.js" ]
