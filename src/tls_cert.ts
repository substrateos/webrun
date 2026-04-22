// =========================================================
// TLS_CERT: Pure-JS X.509 certificate generator
// =========================================================
//
// Generates ephemeral ECDSA P-256 certificates using the Web Crypto API.
// Used by the MITM import proxy to create a per-session CA and
// per-host leaf certificates that Deno trusts via --cert.
//
// No external dependencies — all ASN.1 DER encoding is inline.
// Certificates are valid for 24 hours (regenerated each session).

// ── ASN.1 DER primitives ────────────────────────────────────────────────────

function tlv(tag: number, val: Uint8Array): Uint8Array {
    const len = val.length < 128
        ? new Uint8Array([val.length])
        : (() => {
            const b: number[] = [];
            let t = val.length;
            while (t > 0) { b.unshift(t & 0xff); t >>= 8; }
            return new Uint8Array([0x80 | b.length, ...b]);
        })();
    const r = new Uint8Array(1 + len.length + val.length);
    r[0] = tag;
    r.set(len, 1);
    r.set(val, 1 + len.length);
    return r;
}

function cat(...a: Uint8Array[]): Uint8Array {
    const r = new Uint8Array(a.reduce((s, x) => s + x.length, 0));
    let o = 0;
    for (const x of a) { r.set(x, o); o += x.length; }
    return r;
}

const seq = (...items: Uint8Array[]) => tlv(0x30, cat(...items));
const set_ = (...items: Uint8Array[]) => tlv(0x31, cat(...items));
const int_ = (v: Uint8Array) =>
    (v[0] & 0x80) ? tlv(0x02, cat(new Uint8Array([0]), v)) : tlv(0x02, v);
const intN = (n: number) => {
    const b: number[] = [];
    let t = n;
    do { b.unshift(t & 0xff); t >>= 8; } while (t > 0);
    return int_(new Uint8Array(b));
};
const bits = (v: Uint8Array) => tlv(0x03, cat(new Uint8Array([0]), v));
const octs = (v: Uint8Array) => tlv(0x04, v);

function oidEnc(dotted: string): Uint8Array {
    const p = dotted.split(".").map(Number);
    const b: number[] = [40 * p[0] + p[1]];
    for (let i = 2; i < p.length; i++) {
        let v = p[i];
        if (v < 128) { b.push(v); } else {
            const e: number[] = [];
            while (v > 0) { e.unshift(v & 0x7f); v >>= 7; }
            for (let j = 0; j < e.length - 1; j++) b.push(e[j] | 0x80);
            b.push(e[e.length - 1]);
        }
    }
    return tlv(0x06, new Uint8Array(b));
}

const utf8 = (s: string) => tlv(0x0c, new TextEncoder().encode(s));
const utcTime = (d: Date) => {
    const pad = (n: number) => n.toString().padStart(2, "0");
    const s = `${pad(d.getUTCFullYear() % 100)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
    return tlv(0x17, new TextEncoder().encode(s));
};
const ctxTag = (n: number, v: Uint8Array) => tlv(0xa0 | n, v);

/** Convert a P1363 ECDSA signature to DER format. */
function sigToDer(sig: Uint8Array): Uint8Array {
    const h = sig.length / 2;
    let r = sig.slice(0, h), s = sig.slice(h);
    while (r.length > 1 && r[0] === 0) r = r.slice(1);
    while (s.length > 1 && s[0] === 0) s = s.slice(1);
    return seq(int_(r), int_(s));
}

function toPem(der: Uint8Array, label: string): string {
    let b64 = "";
    const chunk = 3 * 1024;
    for (let i = 0; i < der.length; i += chunk)
        b64 += btoa(String.fromCharCode(...der.slice(i, i + chunk)));
    const lines: string[] = [];
    for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
    return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

// ── X.509 building blocks ───────────────────────────────────────────────────

const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const OID_CN = "2.5.4.3";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_SAN = "2.5.29.17";

const algId = () => seq(oidEnc(OID_ECDSA_SHA256));
const rdnCN = (cn: string) => seq(set_(seq(oidEnc(OID_CN), utf8(cn))));

const KP = { name: "ECDSA", namedCurve: "P-256" } as const;
const SP = { name: "ECDSA", hash: "SHA-256" } as const;

// ── Public API ──────────────────────────────────────────────────────────────

/** Result of CA generation. */
export interface CABundle {
    privateKey: CryptoKey;
    certPem: string;
    keyPem: string;
}

/** Result of host certificate generation. */
export interface HostCertBundle {
    certPem: string;
    keyPem: string;
}

/**
 * Generates a self-signed CA certificate with BasicConstraints CA:true.
 * ECDSA P-256, valid for 24 hours.
 */
export async function generateCA(): Promise<CABundle> {
    const kp = await crypto.subtle.generateKey(KP, true, ["sign", "verify"]);
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));

    const now = new Date();
    const later = new Date(now.getTime() + 86400_000);
    const serial = crypto.getRandomValues(new Uint8Array(16));
    serial[0] &= 0x7f;

    const ext = seq(
        oidEnc(OID_BASIC_CONSTRAINTS),
        tlv(0x01, new Uint8Array([0xff])),  // critical: true
        octs(seq(tlv(0x01, new Uint8Array([0xff])))),  // CA:true
    );

    const tbs = seq(
        ctxTag(0, intN(2)),     // version 3
        int_(serial),
        algId(),
        rdnCN("WebRun CA"),     // issuer
        seq(utcTime(now), utcTime(later)),
        rdnCN("WebRun CA"),     // subject
        spki,
        ctxTag(3, seq(ext)),
    );

    const sig = new Uint8Array(await crypto.subtle.sign(SP, kp.privateKey, tbs as unknown as ArrayBuffer));
    const certDer = seq(tbs, algId(), bits(sigToDer(sig)));

    return {
        privateKey: kp.privateKey,
        certPem: toPem(certDer, "CERTIFICATE"),
        keyPem: toPem(pkcs8, "PRIVATE KEY"),
    };
}

/**
 * Generates a leaf certificate for a specific hostname, signed by the CA.
 * Includes a SubjectAltName dNSName extension. ECDSA P-256, valid for 24 hours.
 *
 * The returned certPem is a chain: leaf cert + CA cert (required by Deno.listenTls).
 */
export async function generateHostCert(
    hostname: string,
    caPrivateKey: CryptoKey,
    caCertPem: string,
): Promise<HostCertBundle> {
    const kp = await crypto.subtle.generateKey(KP, true, ["sign", "verify"]);
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));

    const now = new Date();
    const later = new Date(now.getTime() + 86400_000);
    const serial = crypto.getRandomValues(new Uint8Array(16));
    serial[0] &= 0x7f;

    const san = seq(
        oidEnc(OID_SAN),
        octs(seq(tlv(0x82, new TextEncoder().encode(hostname)))),  // dNSName
    );

    const tbs = seq(
        ctxTag(0, intN(2)),     // version 3
        int_(serial),
        algId(),
        rdnCN("WebRun CA"),     // issuer
        seq(utcTime(now), utcTime(later)),
        rdnCN(hostname),        // subject
        spki,
        ctxTag(3, seq(san)),
    );

    const sig = new Uint8Array(await crypto.subtle.sign(SP, caPrivateKey, tbs as unknown as ArrayBuffer));
    const certDer = seq(tbs, algId(), bits(sigToDer(sig)));

    return {
        certPem: toPem(certDer, "CERTIFICATE") + caCertPem,
        keyPem: toPem(pkcs8, "PRIVATE KEY"),
    };
}
