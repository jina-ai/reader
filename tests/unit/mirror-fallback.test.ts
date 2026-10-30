/**
 * Unit tests for the opt-in mirror fallback (src/services/mirror-fallback).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    MIRROR_FALLBACK_CHAIN,
    annotateMirrorSnapshot,
    canonicalMirrorHost,
    isBlockSnapshot,
    isMirrorFallbackEnabled,
    isUsableMirrorSnapshot,
    mirrorCandidates,
    mirrorNotice,
} from '../../build/services/mirror-fallback.js';

// ---------------------------------------------------------------------------
// canonicalMirrorHost
// ---------------------------------------------------------------------------

describe('canonicalMirrorHost', () => {
    it('strips www. and old. subdomains', () => {
        assert.equal(canonicalMirrorHost('www.reddit.com'), 'reddit.com');
        assert.equal(canonicalMirrorHost('old.reddit.com'), 'reddit.com');
        assert.equal(canonicalMirrorHost('reddit.com'), 'reddit.com');
    });

    it('lowercases the hostname', () => {
        assert.equal(canonicalMirrorHost('WWW.Reddit.COM'), 'reddit.com');
    });
});

// ---------------------------------------------------------------------------
// mirrorCandidates
// ---------------------------------------------------------------------------

describe('mirrorCandidates', () => {
    it('rewrites a reddit thread URL to the Redlib chain, catsarch first', () => {
        const candidates = mirrorCandidates(new URL('https://www.reddit.com/r/ChatGPT/comments/1n78p0v/some-slug'));
        assert.equal(candidates[0].hostname, 'redlib.catsarch.com');
        assert.equal(candidates[0].pathname, '/r/ChatGPT/comments/1n78p0v/some-slug');
        assert.deepEqual(
            candidates.map((u) => u.hostname),
            [...MIRROR_FALLBACK_CHAIN['reddit.com']],
        );
    });

    it('returns [] for non-thread reddit paths', () => {
        assert.deepEqual(mirrorCandidates(new URL('https://www.reddit.com/r/ChatGPT/')), []);
        assert.deepEqual(mirrorCandidates(new URL('https://www.reddit.com/r/ChatGPT/s/LzxY4cqoYs')), []);
    });

    it('returns [] for hosts without a configured mirror', () => {
        assert.deepEqual(mirrorCandidates(new URL('https://example.com/r/x/comments/abc')), []);
    });
});

// ---------------------------------------------------------------------------
// isBlockSnapshot / isUsableMirrorSnapshot
// ---------------------------------------------------------------------------

describe('isBlockSnapshot', () => {
    it('treats status 403 as a block', () => {
        assert.equal(isBlockSnapshot({ status: 403, text: 'something' }), true);
    });

    it('treats known block phrases as a block', () => {
        assert.equal(isBlockSnapshot({ status: 200, text: "You've been blocked by network security." }), true);
        assert.equal(isBlockSnapshot({ status: 200, text: 'Performing security verification' }), true);
        assert.equal(isBlockSnapshot({ status: 200, html: '<title>Just a moment...</title>' }), true);
    });

    it('does not flag normal content', () => {
        assert.equal(isBlockSnapshot({ status: 200, text: 'A normal thread body with many words.' }), false);
        assert.equal(isBlockSnapshot(undefined), false);
    });
});

describe('isUsableMirrorSnapshot', () => {
    it('accepts long, non-block content', () => {
        assert.equal(isUsableMirrorSnapshot({ status: 200, text: 'x'.repeat(500) }), true);
    });

    it('rejects block pages and near-empty content', () => {
        assert.equal(isUsableMirrorSnapshot({ status: 403, text: 'x'.repeat(500) }), false);
        assert.equal(isUsableMirrorSnapshot({ status: 200, text: 'short' }), false);
    });
});

// ---------------------------------------------------------------------------
// isMirrorFallbackEnabled
// ---------------------------------------------------------------------------

describe('isMirrorFallbackEnabled', () => {
    it('is off by default', () => {
        const prev = process.env.MIRROR_FALLBACK;
        delete process.env.MIRROR_FALLBACK;
        try {
            assert.equal(isMirrorFallbackEnabled({}), false);
            assert.equal(isMirrorFallbackEnabled(undefined), false);
        } finally {
            if (prev !== undefined) process.env.MIRROR_FALLBACK = prev;
        }
    });

    it('follows the per-request option over the environment', () => {
        const prev = process.env.MIRROR_FALLBACK;
        process.env.MIRROR_FALLBACK = 'true';
        try {
            assert.equal(isMirrorFallbackEnabled({ mirrorFallback: false }), false);
            assert.equal(isMirrorFallbackEnabled({ mirrorFallback: true }), true);
        } finally {
            if (prev !== undefined) process.env.MIRROR_FALLBACK = prev;
            else delete process.env.MIRROR_FALLBACK;
        }
    });

    it('follows MIRROR_FALLBACK when no per-request option is set', () => {
        const prev = process.env.MIRROR_FALLBACK;
        try {
            process.env.MIRROR_FALLBACK = 'true';
            assert.equal(isMirrorFallbackEnabled({}), true);
            process.env.MIRROR_FALLBACK = 'false';
            assert.equal(isMirrorFallbackEnabled({}), false);
        } finally {
            if (prev !== undefined) process.env.MIRROR_FALLBACK = prev;
            else delete process.env.MIRROR_FALLBACK;
        }
    });
});

// ---------------------------------------------------------------------------
// annotateMirrorSnapshot / mirrorNotice
// ---------------------------------------------------------------------------

describe('annotateMirrorSnapshot and mirrorNotice', () => {
    it('attaches provenance metadata without mutating the original', () => {
        const snapshot = { status: 200, text: 'x'.repeat(500), metadata: { keep: 'me' } };
        const annotated = annotateMirrorSnapshot(snapshot, 'https://www.reddit.com/r/a/comments/1', 'https://redlib.catsarch.com/r/a/comments/1');
        assert.equal(annotated.metadata?.['mirror-fallback'], 'true');
        assert.equal(annotated.metadata?.['mirror-source'], 'https://redlib.catsarch.com/r/a/comments/1');
        assert.equal(annotated.metadata?.['mirror-original'], 'https://www.reddit.com/r/a/comments/1');
        assert.equal(annotated.metadata?.['keep'], 'me');
        assert.equal(snapshot.metadata?.['mirror-fallback'], undefined);
    });

    it('renders a notice only for mirrored snapshots', () => {
        const annotated = annotateMirrorSnapshot({ status: 200, text: 'x'.repeat(500) }, 'https://www.reddit.com/r/a/comments/1', 'https://redlib.catsarch.com/r/a/comments/1');
        const notice = mirrorNotice(annotated);
        assert.match(notice || '', /redlib\.catsarch\.com/);
        assert.match(notice || '', /reddit\.com/);
        assert.equal(mirrorNotice({ status: 200, text: 'plain' }), undefined);
    });
});
