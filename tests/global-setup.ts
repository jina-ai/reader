import server from '../build/stand-alone/crawl.js';
import finalizer from '../build/services/finalizer.js';

export async function globalSetup() {
    await server.serviceReady();

}

export async function globalTeardown() {
    console.log('Global teardown: terminating server and finalizer');
    await finalizer.terminate();
};
