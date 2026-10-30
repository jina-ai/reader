/**
 * Opt-in mirror fallback for targets that block the reader's IPs.
 *
 * Some sites (notably Reddit) reject requests coming from the reader's
 * datacenter IPs with a 403 block page ("blocked by network security").
 * When this feature is enabled, a blocked fetch is retried through a
 * public, read-only mirror of the same content, and the returned
 * snapshot is annotated so the response never silently misattributes
 * mirrored content to the original URL.
 *
 * The feature is OFF by default. Enable it per request with the
 * `x-mirror-fallback` request header, or server-wide with the
 * `MIRROR_FALLBACK=true` environment variable.
 *
 * Trust caveats (also documented in README.md):
 * - A mirror is run by a third party who can see the requested URLs.
 * - Public mirrors are disposable: they can go down, add bot gates,
 *   or be blocked at any time. Candidates that return a block page,
 *   a bot gate, or near-empty content are skipped, not served.
 * - Never use this for pages that require a login. No credentials,
 *   sessions, or cookies are ever sent to a mirror.
 */

export interface BlockLikeSnapshot {
    status?: number;
    statusText?: string;
    text?: string;
    html?: string;
    metadata?: { [k: string]: string };
}

/** Metadata keys attached to snapshots served from a mirror. */
export const MIRROR_METADATA_FALLBACK = 'mirror-fallback';
export const MIRROR_METADATA_SOURCE = 'mirror-source';
export const MIRROR_METADATA_ORIGINAL = 'mirror-original';

/**
 * Default mirror chain per canonical host.
 *
 * Verification status as of 2026-10-29 (fetched through the reader):
 * redlib.catsarch.com returned a full Reddit thread; the remaining
 * instances were behind Cloudflare checks, bot gates, 403s, or down.
 * They stay in the chain because instances come and go: a candidate
 * that gates or blocks is skipped, so a revived instance is useful
 * again without a code change.
 */
export const MIRROR_FALLBACK_CHAIN: Readonly<Record<string, readonly string[]>> = {
    'reddit.com': [
        'redlib.catsarch.com',
        'redlib.perennialte.ch',
        'redlib.freedit.eu',
        'redlib-1.privadency.com',
        'redlib.privacyredirect.com',
        'safereddit.com',
    ],
};

/** Only Reddit thread pages are mirrored: /r/<sub>/comments/<id>[/slug]. */
const REDDIT_THREAD_PATH = /^\/r\/[^/]+\/comments\/[A-Za-z0-9]+/;

/** Phrases that identify a block/bot-gate page (case-insensitive). */
const BLOCK_TEXT_MARKERS = [
    'blocked by network security',
    'you have been blocked',
    "you've been blocked",
    'performing security verification',
    "making sure you're not a bot",
    'just a moment',
    'gandalf - you shall not pass',
    'attention required',
];

/** Minimum readable text for a mirror candidate to count as usable. */
export const MIRROR_MIN_TEXT_LENGTH = 200;

/**
 * Canonical host for mirror lookup: lowercase, with www./old. stripped
 * so www.reddit.com and old.reddit.com both map to reddit.com.
 */
export function canonicalMirrorHost(hostname: string): string {
    return hostname.toLowerCase().replace(/^(www\.|old\.)/, '');
}

/**
 * Ordered mirror URLs for a target URL, or [] when the URL has no
 * configured mirror. The path and query are preserved verbatim.
 */
export function mirrorCandidates(url: URL): URL[] {
    const hosts = MIRROR_FALLBACK_CHAIN[canonicalMirrorHost(url.hostname)];
    if (!hosts || !REDDIT_THREAD_PATH.test(url.pathname)) {
        return [];
    }
    const candidates: URL[] = [];
    for (const host of hosts) {
        try {
            const mirror = new URL(url.toString());
            mirror.hostname = host;
            candidates.push(mirror);
        } catch {
            // Skip unparseable mirror hosts; the chain continues.
            continue;
        }
    }
    return candidates;
}

/** True when a snapshot looks like a block/bot-gate page, not content. */
export function isBlockSnapshot(snapshot: BlockLikeSnapshot | undefined): boolean {
    if (!snapshot) {
        return false;
    }
    if (snapshot.status === 403) {
        return true;
    }
    const haystack = `${snapshot.text || ''}\n${snapshot.html || ''}`.toLowerCase();
    return BLOCK_TEXT_MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * True when a mirror candidate produced real content: not a block page
 * and not near-empty. Thin results advance the chain instead of being
 * served as if the mirror had worked.
 */
export function isUsableMirrorSnapshot(snapshot: BlockLikeSnapshot | undefined): boolean {
    if (!snapshot || isBlockSnapshot(snapshot)) {
        return false;
    }
    return (snapshot.text || '').trim().length >= MIRROR_MIN_TEXT_LENGTH;
}

/**
 * Whether mirror fallback is enabled for a request. The per-request
 * option (CrawlerOptions.mirrorFallback, set by the x-mirror-fallback
 * header) wins; otherwise the MIRROR_FALLBACK environment variable
 * enables it server-wide. Anything else means off: the default
 * behavior is unchanged.
 */
export function isMirrorFallbackEnabled(opts?: { mirrorFallback?: unknown }): boolean {
    if (typeof opts?.mirrorFallback === 'boolean') {
        return opts.mirrorFallback;
    }
    const env = process.env.MIRROR_FALLBACK;
    return !!env && ['1', 'true', 'yes'].includes(env.toLowerCase());
}

/**
 * Annotate a snapshot served from a mirror. The original snapshot is
 * not mutated; metadata keys are merged so downstream formatters can
 * surface the provenance (see mirrorNotice).
 */
export function annotateMirrorSnapshot<T extends BlockLikeSnapshot>(
    snapshot: T,
    originalUrl: string,
    mirrorUrl: string,
): T {
    return {
        ...snapshot,
        metadata: {
            ...(snapshot.metadata || {}),
            [MIRROR_METADATA_FALLBACK]: 'true',
            [MIRROR_METADATA_SOURCE]: mirrorUrl,
            [MIRROR_METADATA_ORIGINAL]: originalUrl,
        },
    };
}

/**
 * Human-readable provenance notice for a mirrored snapshot, or
 * undefined when the snapshot did not come from a mirror. Callers
 * attach this to the response warning so mirrored content is never
 * silently presented as if fetched from the original URL.
 */
export function mirrorNotice(snapshot: BlockLikeSnapshot | undefined): string | undefined {
    const metadata = snapshot?.metadata;
    if (!metadata || metadata[MIRROR_METADATA_FALLBACK] !== 'true') {
        return undefined;
    }
    const source = metadata[MIRROR_METADATA_SOURCE] || 'a mirror';
    const original = metadata[MIRROR_METADATA_ORIGINAL] || 'the requested URL';
    return `Content retrieved via mirror ${source} because ${original} blocked the reader. ` +
        `Mirror content is provided by a third party; verify against the original when possible.`;
}
