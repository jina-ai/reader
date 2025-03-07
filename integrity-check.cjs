#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, 'licensed/GeoLite2-City.mmdb');

if (!fs.existsSync(file)) {
    console.error(`Integrity check failed: ${file} does not exist.`);
    process.exit(1);
}
