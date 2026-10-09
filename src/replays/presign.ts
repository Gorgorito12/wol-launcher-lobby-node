import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, query-string form: a URL that carries its own short-lived
 * authorisation, which is how a launcher uploads and downloads a recording straight to and
 * from Oracle Object Storage without the bytes ever passing through this server.
 *
 * Hand-rolled on purpose rather than taken from @aws-sdk/s3-request-presigner:
 *
 *  - We need four verbs and one feature (signing `content-length` on the PUT, so the storage
 *    refuses a body of any other size). That is this file.
 *  - Recent SDK versions add a CRC32 checksum to presigned PUTs by default, and Oracle's S3
 *    compatibility layer refuses it. Nothing here adds a parameter we did not ask for.
 *  - No new dependency on a 1 GB VM, and a deploy does not need `npm install`.
 *
 * Pinned by `presign.test.ts`, which reproduces the signature AWS publishes for its own
 * presigned-URL example — the one test a SigV4 implementation cannot pass by accident.
 */

export interface PresignInput {
    method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
    /** Host only, no scheme, no port — e.g. `ns.compat.objectstorage.us-ashburn-1.oraclecloud.com`. */
    host: string;
    /** Unencoded absolute path, e.g. `/bucket/replays/wol/2026/abc.age3Yrec`. */
    path: string;
    region: string;
    accessKey: string;
    secretKey: string;
    expiresSec: number;
    now: Date;
    /** Extra headers that become part of the signature (lowercased). The client MUST send them as given. */
    signedHeaders?: Record<string, string>;
    /** Extra query parameters, signed with the rest (e.g. `response-content-disposition`). */
    query?: Record<string, string>;
}

/** RFC 3986 encoding as SigV4 requires it: everything but `A-Z a-z 0-9 - _ . ~`. */
export function uriEncode(value: string): string {
    return encodeURIComponent(value).replace(
        /[!'()*]/g,
        (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
    );
}

/** Each segment encoded, the slashes between them kept — S3 does not double-encode a path. */
function encodePath(path: string): string {
    return path.split('/').map(uriEncode).join('/');
}

function sha256Hex(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, text: string): Buffer {
    return createHmac('sha256', key).update(text, 'utf8').digest();
}

/** `20130524T000000Z` */
function amzDate(d: Date): string {
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function presign(input: PresignInput): string {
    const stamp = amzDate(input.now);
    const day = stamp.slice(0, 8);
    const scope = `${day}/${input.region}/s3/aws4_request`;

    const headers: Record<string, string> = { host: input.host };
    for (const [name, value] of Object.entries(input.signedHeaders ?? {})) {
        headers[name.toLowerCase()] = String(value).trim();
    }
    const headerNames = Object.keys(headers).sort();
    const signedHeaderList = headerNames.join(';');
    const canonicalHeaders = headerNames.map((n) => `${n}:${headers[n]}\n`).join('');

    const params: Record<string, string> = {
        ...(input.query ?? {}),
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-Credential': `${input.accessKey}/${scope}`,
        'X-Amz-Date': stamp,
        'X-Amz-Expires': String(Math.floor(input.expiresSec)),
        'X-Amz-SignedHeaders': signedHeaderList,
    };
    const canonicalQuery = Object.keys(params)
        .map((k) => [uriEncode(k), uriEncode(params[k]!)] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
        .join('&');

    const canonicalPath = encodePath(input.path);
    const canonicalRequest = [
        input.method,
        canonicalPath,
        canonicalQuery,
        canonicalHeaders,
        signedHeaderList,
        'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
        'AWS4-HMAC-SHA256',
        stamp,
        scope,
        sha256Hex(canonicalRequest),
    ].join('\n');

    const kDate = hmac(`AWS4${input.secretKey}`, day);
    const kRegion = hmac(kDate, input.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

    return `https://${input.host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** The bucket this server writes recordings to. Built by `replayStorageFromEnv`. */
export interface ReplayStorage {
    /** `https://<namespace>.compat.objectstorage.<region>.oraclecloud.com` */
    endpoint: string;
    region: string;
    accessKey: string;
    secretKey: string;
    bucket: string;
}

/**
 * A presigned URL for one object of the replay bucket. Path-style
 * (`/<bucket>/<key>`), which is what Oracle's S3 compatibility endpoint expects.
 */
export function presignObject(
    storage: ReplayStorage,
    method: PresignInput['method'],
    key: string,
    opts: {
        expiresSec: number;
        now?: Date;
        signedHeaders?: Record<string, string>;
        query?: Record<string, string>;
    },
): string {
    return presign({
        method,
        host: new URL(storage.endpoint).host,
        path: `/${storage.bucket}/${key}`,
        region: storage.region,
        accessKey: storage.accessKey,
        secretKey: storage.secretKey,
        expiresSec: opts.expiresSec,
        now: opts.now ?? new Date(),
        signedHeaders: opts.signedHeaders,
        query: opts.query,
    });
}
