#!/usr/bin/env node

const fs = require('fs');

const f = fs.readFileSync('.secret.local.json', 'utf8');

fs.writeFileSync('.secret.local', `SECRETS_COMBINED=${Buffer.from(JSON.stringify(JSON.parse(f)), 'utf-8').toString('base64')}`, 'utf8');
