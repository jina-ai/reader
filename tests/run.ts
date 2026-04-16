import 'reflect-metadata';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { glob } from 'node:fs';
import path from 'path';
import finalizer from '../build/services/finalizer.js';
import server from '../build/stand-alone/crawl.js';

process.env.NODE_ENV = 'test';
async function main() {
    await server.serviceReady();
    const files = await new Promise<string[]>((resolve, reject) => {
        glob(path.join(__dirname, 'e2e', '*.test.js'), (err, found) => {
            if (err) reject(err);
            else resolve(found);
        });
    });

    const stream = run({
        files,
        concurrency: false,
        timeout: 10_000,
        isolation: 'none',
        forceExit: true,
        watch: false,
    });

    stream.compose(spec).pipe(process.stdout);
    let n = 0;
    let i = 0;
    stream.on('test:enqueue', () => {
        i++;
    });

    stream.on('test:complete', () => {
        n++;

        if (n && i === n) {
            process.nextTick(() => {
                finalizer.teardown();
            });
        }
    });
}

main();
