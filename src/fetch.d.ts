declare global {
    export const {
        fetch,
        FormData,
        Headers,
        Request,
        Response,
        File,
    }: typeof import('undici');
    export type { FormData, Headers, Request, RequestInit, Response, RequestInit, File } from 'undici';
}

export { };
