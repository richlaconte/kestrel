// Auto-update support for the CLI (#28): the signing key, signing build
// outputs, and the feed (latest.json) the host's updater reads.
//
// Keys are Ed25519. The private key is a base64 PKCS#8 file that stays with
// the developer (or a CI secret); the public key, base64 of its 32 raw
// bytes, goes in kestrel.json as `updater.pubkey` and ships in the app.
// Signatures are plain Ed25519 over the whole file, base64 in the feed.
import crypto from "node:crypto";
import fs from "node:fs";

/** A new key pair: { privateKey, publicKey }, both base64. */
export function keygen() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    publicKey: rawPublicKey(publicKey),
  };
}

// An Ed25519 SPKI is a fixed 12-byte header followed by the 32-byte key.
const rawPublicKey = (key) => key.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");

function privateKeyObject(b64) {
  try {
    const key = crypto.createPrivateKey({ key: Buffer.from(b64.trim(), "base64"), format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error();
    return key;
  } catch {
    throw new Error("the updater key isn't a base64 Ed25519 private key (make one with `kestrel updater keygen`)");
  }
}

/**
 * The private key from KESTREL_UPDATER_KEY: a path to the key file, or the
 * key itself (handy as a CI secret). Null when unset.
 */
export function loadKey(env = process.env) {
  const v = env.KESTREL_UPDATER_KEY;
  if (!v) return null;
  return fs.existsSync(v) ? fs.readFileSync(v, "utf8").trim() : v.trim();
}

/** The public key (base64) that goes with a private one. */
export const publicKeyOf = (privateKey) => rawPublicKey(crypto.createPublicKey(privateKeyObject(privateKey)));

/** Sign `data` (a Buffer): base64 Ed25519 signature. */
export const sign = (data, privateKey) => crypto.sign(null, data, privateKeyObject(privateKey)).toString("base64");

/** The feed's key for an OS and CPU, matching the host's: "macos-aarch64". */
export function platformKey(platform = process.platform, arch = process.arch) {
  const os = { darwin: "macos", win32: "windows", linux: "linux" }[platform] ?? platform;
  const cpu = { x64: "x86_64", arm64: "aarch64" }[arch] ?? arch;
  return `${os}-${cpu}`;
}

/** A feed with one platform's artifact; `url` is relative to the feed. */
export function feed({ version, notes, platform, url, signature, pubDate = new Date().toISOString() }) {
  return {
    version,
    ...(notes ? { notes } : {}),
    pubDate,
    platforms: { [platform]: { url, signature } },
  };
}

/**
 * One feed from several (one per OS a release was built on). They must all
 * be the same version; the newest pubDate and the first notes win.
 */
export function mergeFeeds(feeds) {
  if (!feeds.length) throw new Error("nothing to merge");
  const versions = [...new Set(feeds.map((f) => f.version))];
  if (versions.length > 1) throw new Error(`the feeds are for different versions: ${versions.join(", ")}`);
  const out = { version: versions[0], pubDate: feeds.map((f) => f.pubDate).filter(Boolean).sort().at(-1), platforms: {} };
  const notes = feeds.find((f) => f.notes)?.notes;
  if (notes) out.notes = notes;
  for (const f of feeds)
    for (const [k, a] of Object.entries(f.platforms ?? {})) {
      if (out.platforms[k] && out.platforms[k].signature !== a.signature)
        throw new Error(`two feeds have different builds for ${k}`);
      out.platforms[k] = a;
    }
  return out;
}

/** Problems with a manifest's `updater` block; empty means valid. */
export function validateUpdater(u) {
  if (typeof u !== "object" || u === null || Array.isArray(u))
    return ['`updater` must be { "endpoint": "https://…/latest.json", "pubkey": "…" }'];
  const errs = [];
  let url;
  try {
    url = new URL(u.endpoint);
  } catch {}
  const local = url && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && local)))
    errs.push(`\`updater.endpoint\` must be an https URL (http only to localhost), got ${JSON.stringify(u.endpoint)}`);
  if (typeof u.pubkey !== "string" || Buffer.from(u.pubkey, "base64").length !== 32 || !/^[A-Za-z0-9+/]{43}=$/.test(u.pubkey))
    errs.push("`updater.pubkey` must be a base64 Ed25519 public key (from `kestrel updater keygen`)");
  for (const k of Object.keys(u))
    if (k !== "endpoint" && k !== "pubkey") errs.push(`\`updater.${k}\` is not a known field`);
  return errs;
}
