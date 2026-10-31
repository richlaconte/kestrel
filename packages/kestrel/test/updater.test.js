import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { feed, keygen, loadKey, mergeFeeds, platformKey, publicKeyOf, sign, validateUpdater } from "../src/updater.js";

test("keys: a pair, the public half of a private key, and loading", () => {
  const { privateKey, publicKey } = keygen();
  assert.equal(Buffer.from(publicKey, "base64").length, 32);
  assert.equal(publicKeyOf(privateKey), publicKey);
  assert.throws(() => publicKeyOf("bm9wZQ=="), /isn't a base64 Ed25519 private key/);
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  assert.throws(() => publicKeyOf(rsa), /Ed25519/);

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kestrel-key-")), "k.key");
  fs.writeFileSync(file, privateKey + "\n");
  assert.equal(loadKey({ KESTREL_UPDATER_KEY: file }), privateKey, "a path");
  assert.equal(loadKey({ KESTREL_UPDATER_KEY: ` ${privateKey}\n` }), privateKey, "the key itself");
  assert.equal(loadKey({}), null);
  fs.rmSync(path.dirname(file), { recursive: true });
});

test("signatures verify with the raw public key, as the host checks them", () => {
  const { privateKey, publicKey } = keygen();
  const data = Buffer.from("an update");
  const sig = sign(data, privateKey);
  assert.equal(Buffer.from(sig, "base64").length, 64);
  // Rebuild the public key from its 32 raw bytes, like the host does.
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKey, "base64")]);
  const pub = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  assert.ok(crypto.verify(null, data, pub, Buffer.from(sig, "base64")));
  assert.ok(!crypto.verify(null, Buffer.from("an updatE"), pub, Buffer.from(sig, "base64")));
});

test("platform keys match the host's", () => {
  assert.equal(platformKey("darwin", "arm64"), "macos-aarch64");
  assert.equal(platformKey("win32", "x64"), "windows-x86_64");
  assert.equal(platformKey("linux", "arm64"), "linux-aarch64");
});

test("feeds, and merging the ones built on each OS", () => {
  const mac = feed({ version: "1.1.0", notes: "Fixes", platform: "macos-aarch64", url: "A.app.tar.gz", signature: "s1", pubDate: "2026-10-30T10:00:00Z" });
  assert.deepEqual(mac, { version: "1.1.0", notes: "Fixes", pubDate: "2026-10-30T10:00:00Z", platforms: { "macos-aarch64": { url: "A.app.tar.gz", signature: "s1" } } });
  const win = feed({ version: "1.1.0", platform: "windows-x86_64", url: "A-setup.exe", signature: "s2", pubDate: "2026-10-30T11:00:00Z" });
  assert.equal("notes" in win, false);
  const merged = mergeFeeds([win, mac]);
  assert.deepEqual(Object.keys(merged.platforms).sort(), ["macos-aarch64", "windows-x86_64"]);
  assert.equal(merged.notes, "Fixes");
  assert.equal(merged.pubDate, "2026-10-30T11:00:00Z", "the newest");
  assert.throws(() => mergeFeeds([mac, { ...win, version: "1.2.0" }]), /different versions: 1\.1\.0, 1\.2\.0/);
  assert.throws(() => mergeFeeds([mac, { ...mac, platforms: { "macos-aarch64": { url: "x", signature: "other" } } }]), /different builds for macos-aarch64/);
  assert.deepEqual(mergeFeeds([mac, mac]).platforms, mac.platforms, "the same feed twice is fine");
  assert.throws(() => mergeFeeds([]), /nothing to merge/);
});

test("the manifest's updater block", () => {
  const pubkey = keygen().publicKey;
  assert.deepEqual(validateUpdater({ endpoint: "https://example.com/latest.json", pubkey }), []);
  assert.deepEqual(validateUpdater({ endpoint: "http://127.0.0.1:8080/latest.json", pubkey }), []);
  assert.match(validateUpdater({ endpoint: "http://example.com/latest.json", pubkey })[0], /https URL/);
  assert.match(validateUpdater({ endpoint: "nope", pubkey })[0], /https URL/);
  assert.match(validateUpdater({ endpoint: "https://e.com/l.json", pubkey: "abc" })[0], /pubkey/);
  assert.match(validateUpdater({ endpoint: "https://e.com/l.json", pubkey, channel: "beta" })[0], /updater\.channel/);
  assert.match(validateUpdater("https://e.com")[0], /must be \{/);
});
