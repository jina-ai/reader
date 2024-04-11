import 'reflect-metadata';
import { initializeApp } from 'firebase-admin/app';
initializeApp();


// export const onUserCreated = functions
//     .runWith({ secrets: [...secretExposer.bundle], memory: '512MB' })
//     .auth.user()
//     .onCreate(async (user) => {

//         return null;
//     });

// export const onUserLogin = functions
//     .runWith({ secrets: [...secretExposer.bundle], memory: '512MB' })
//     .auth.user()
//     .beforeSignIn(async (user, _ctx) => {

//         return;
//     });

import { loadModulesDynamically, registry } from './shared';
import path from 'path';
loadModulesDynamically(path.resolve(__dirname, 'cloud-functions'));

Object.assign(exports, registry.exportAll());
Object.assign(exports, registry.exportGrouped({
    memory: '4GiB',
    timeoutSeconds: 540,
}));
registry.title = 'url2text';
registry.version = '0.1.0';

process.on('unhandledRejection', () => 'no big deal');
