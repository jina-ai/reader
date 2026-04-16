#!/usr/bin/env node

const fs = require('fs');

const f = fs.readFileSync('.secret.local', 'utf8');

fs.writeFileSync('.secret.local.json', `${JSON.stringify(JSON.parse(Buffer.from(f.slice('SECRETS_COMBINED='.length), 'base64').toString('utf-8')), undefined, 2)}`, 'utf8');
