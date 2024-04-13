const { join } = require('path');

let config = {};
if (!process.env.FUNCTIONS_EMULATOR) {
    config = {
        // Changes the cache location for Puppeteer.
        cacheDirectory: join(__dirname, 'node_modules', 'puppeteer', 'walk-around-lame-gcp-build'),
    };
}

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = config;
