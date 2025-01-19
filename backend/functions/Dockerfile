# syntax=docker/dockerfile:1
FROM lwthiker/curl-impersonate:0.6-chrome-slim-bullseye


FROM node:20

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY build ./build
COPY public ./public
COPY licensed ./licensed

COPY --from=0 /usr/local/lib/libcurl-impersonate.so /usr/local/lib/libcurl-impersonate.so

EXPOSE 3000
ENTRYPOINT ["node"]
CMD [ "build/stand-alone/crawl.js" ]
