import test from 'node:test';
import assert from 'node:assert/strict';
import { presign, presignObject, uriEncode } from './presign';

// AWS's own worked example for a query-string (presigned) GET, from "Authenticating Requests:
// Using Query Parameters (AWS Signature Version 4)". Every input is theirs, and so is the
// expected signature. A SigV4 implementation cannot pass this by accident: one wrong byte in
// the canonical request, the scope or the key derivation changes every character.
test('reproduces the signature AWS publishes for its presigned-URL example', () => {
    const url = presign({
        method: 'GET',
        host: 'examplebucket.s3.amazonaws.com',
        path: '/test.txt',
        region: 'us-east-1',
        accessKey: 'AKIAIOSFODNN7EXAMPLE',
        secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        expiresSec: 86400,
        now: new Date('2013-05-24T00:00:00Z'),
    });

    assert.equal(
        url,
        'https://examplebucket.s3.amazonaws.com/test.txt'
        + '?X-Amz-Algorithm=AWS4-HMAC-SHA256'
        + '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request'
        + '&X-Amz-Date=20130524T000000Z'
        + '&X-Amz-Expires=86400'
        + '&X-Amz-SignedHeaders=host'
        + '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
});

const STORAGE = {
    endpoint: 'https://idjvr9jpxae6.compat.objectstorage.us-ashburn-1.oraclecloud.com',
    region: 'us-ashburn-1',
    accessKey: 'AK',
    secretKey: 'SK',
    bucket: 'wol-replays',
};

test('an upload URL signs the content length, so the storage refuses any other size', () => {
    const url = new URL(presignObject(STORAGE, 'PUT', 'replays/wol/2026/m1.age3Yrec', {
        expiresSec: 900,
        signedHeaders: { 'Content-Length': '1234' },
    }));
    assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'content-length;host');
});

test('the object URL is path-style on the configured endpoint', () => {
    const url = new URL(presignObject(STORAGE, 'HEAD', 'replays/wol/2026/m1.age3Yrec', { expiresSec: 60 }));
    assert.equal(url.host, 'idjvr9jpxae6.compat.objectstorage.us-ashburn-1.oraclecloud.com');
    assert.equal(url.pathname, '/wol-replays/replays/wol/2026/m1.age3Yrec');
});

// Oracle's S3 layer refuses the checksum parameters recent AWS SDKs add by default. The whole
// point of hand-rolling this is that nothing appears that was not asked for.
test('adds no checksum parameter of any kind', () => {
    const url = new URL(presignObject(STORAGE, 'PUT', 'k', {
        expiresSec: 900,
        signedHeaders: { 'content-length': '10' },
    }));
    for (const name of url.searchParams.keys()) {
        assert.doesNotMatch(name.toLowerCase(), /checksum|sdk/);
    }
});

test('the download name travels in the signed query, encoded', () => {
    const disposition = 'attachment; filename="2026-10-09_Ana-vs-Luis_Texas.age3Yrec"';
    const url = presignObject(STORAGE, 'GET', 'k', {
        expiresSec: 600,
        query: { 'response-content-disposition': disposition },
    });
    assert.ok(url.includes(`response-content-disposition=${uriEncode(disposition)}`));
    assert.equal(new URL(url).searchParams.get('response-content-disposition'), disposition);
});

test('uriEncode follows RFC 3986, not encodeURIComponent', () => {
    assert.equal(uriEncode("a b!'()*~"), 'a%20b%21%27%28%29%2A~');
    assert.equal(uriEncode('A-Z_a.z~09'), 'A-Z_a.z~09');
});
