import 'reflect-metadata';
import './shared/lib/doom-domain';
import { initializeApp } from 'firebase-admin/app';
initializeApp();


import { loadModulesDynamically, registry } from './shared';
import path from 'path';
loadModulesDynamically(path.resolve(__dirname, 'cloud-functions'));
loadModulesDynamically(path.resolve(__dirname, 'shared', 'cloud-functions'));

Object.assign(exports, registry.exportAll());
Object.assign(exports, registry.exportGrouped({
    memory: '4GiB',
    timeoutSeconds: 540,
}));
registry.allHandsOnDeck().catch(() => void 0);
registry.title = 'reader';
registry.version = '0.1.0';

process.on('unhandledRejection', (_err) => `Somehow is false alarm in firebase`);

process.on('uncaughtException', (err) => {
    console.log('Uncaught exception', err);

    // Looks like Firebase runtime does not handle error properly.
    // Make sure to quit the process.
    process.nextTick(() => process.exit(1));
    console.error('Uncaught exception, process quit.');
    throw err;
});
