import { isIPv4, isIPv6 } from 'net';

export function parseIp(ip: string): Buffer {
    if (isIPv4(ip)) {
        const [a, b, c, d] = ip.split('.').map(Number);

        const buf = Buffer.alloc(4);
        buf.writeUInt8(a, 0);
        buf.writeUInt8(b, 1);
        buf.writeUInt8(c, 2);
        buf.writeUInt8(d, 3);

        return buf;
    }

    if (isIPv6(ip)) {
        if (ip.includes('.')) {
            const parts = ip.split(':');
            const ipv4Part = parts.pop();
            if (!ipv4Part) throw new Error('Invalid IPv6 address');
            const ipv4Bytes = parseIp(ipv4Part);
            parts.push('0');
            const ipv6Bytes = parseIp(parts.join(':'));
            ipv6Bytes.writeUInt32BE(ipv4Bytes.readUInt32BE(0), 12);

            return ipv6Bytes;
        }

        const buf = Buffer.alloc(16);

        // Expand :: notation
        let expanded = ip;
        if (ip.includes('::')) {
            const sides = ip.split('::');
            const left = sides[0] ? sides[0].split(':') : [];
            const right = sides[1] ? sides[1].split(':') : [];
            const middle = Array(8 - left.length - right.length).fill('0');
            expanded = [...left, ...middle, ...right].join(':');
        }

        // Convert to buffer
        const parts = expanded.split(':');
        let offset = 0;
        for (const part of parts) {
            buf.writeUInt16BE(parseInt(part, 16), offset);
            offset += 2;
        }

        return buf;
    }

    throw new Error('Invalid IP address');
}


export function parseCIDR(cidr: string): [Buffer, Buffer] {
    const [ip, prefixTxt] = cidr.split('/');
    const buf = parseIp(ip);
    const maskBuf = Buffer.alloc(buf.byteLength, 0xff);
    const prefixBits = parseInt(prefixTxt);

    let offsetBits = 0;
    while (offsetBits < (buf.byteLength * 8)) {
        if (offsetBits <= (prefixBits - 8)) {
            offsetBits += 8;
            continue;
        }
        const bitsRemain = prefixBits - offsetBits;
        const byteOffset = Math.floor(offsetBits / 8);

        if (bitsRemain > 0) {
            const theByte = buf[byteOffset];
            const mask = 0xff << (8 - bitsRemain);
            maskBuf[byteOffset] = mask;
            buf[byteOffset] = theByte & mask;

            offsetBits += 8;
            continue;
        };
        buf[byteOffset] = 0;
        maskBuf[byteOffset] = 0;

        offsetBits += 8;
    }

    return [buf, maskBuf];
}

export class CIDR {
    buff: Buffer;
    mask: Buffer;
    text: string;
    constructor(cidr: string) {
        this.text = cidr;
        [this.buff, this.mask] = parseCIDR(cidr);
    }

    toString() {
        return this.text;
    }

    get family() {
        return this.buff.byteLength === 4 ? 4 : 6;
    }

    test(ip: string | Buffer): boolean {
        const parsedIp = typeof ip === 'string' ? parseIp(ip) : ip;

        if (parsedIp.byteLength !== this.buff.byteLength) {
            return false;
        }

        for (const i of Array(this.buff.byteLength).keys()) {
            const t = parsedIp[i];
            const m = this.mask[i];

            if (m === 0) {
                return true;
            }

            const r = this.buff[i];
            if ((t & m) !== r) {
                return false;
            }
        }

        return true;
    }
}

const nonPublicNetworks4 = [
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',

    '127.0.0.0/8',
    '255.255.255.255/32',
    '169.254.0.0/16',
    '224.0.0.0/4',

    '100.64.0.0/10',
];


const nonPublicNetworks6 = [
    'fc00::/7',
    'fe80::/10',
    'ff00::/8',

    '::127.0.0.0/104',
    '::/128',
];

const nonPublicCIDRs = [...nonPublicNetworks4, ...nonPublicNetworks6].map(cidr => new CIDR(cidr));

export function isIPInNonPublicRange(ip: string) {
    const parsed = parseIp(ip);

    for (const cidr of nonPublicCIDRs) {
        if (cidr.test(parsed)) {
            return true;
        }
    }

    return false;
}