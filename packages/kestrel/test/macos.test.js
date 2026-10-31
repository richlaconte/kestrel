import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { appLayout, appNameOf, bundleIdOf, infoPlist, signingPlan } from "../src/macos.js";

const m = { appId: "quick-note", title: "Quick <Note> & Co" };

test("Info.plist names the executable, icon, bundle id and version, escaped", () => {
  const p = infoPlist(m, "1.2.3");
  assert.match(p, /<key>CFBundleExecutable<\/key>\n  <string>quick-note<\/string>/);
  assert.match(p, /<key>CFBundleIdentifier<\/key>\n  <string>dev\.kestrel\.app\.quick-note<\/string>/);
  assert.match(p, /<key>CFBundleShortVersionString<\/key>\n  <string>1\.2\.3<\/string>/);
  assert.match(p, /<key>CFBundleIconFile<\/key>\n  <string>icon\.icns<\/string>/);
  assert.match(p, /<string>Quick &lt;Note&gt; &amp; Co<\/string>/);
  assert.match(p, /<key>NSHighResolutionCapable<\/key>\n  <true\/>/);
  assert.equal(bundleIdOf({ ...m, bundleId: "com.example.qn" }), "com.example.qn");
});

test("bundle name and layout", () => {
  assert.equal(appNameOf({ appId: "a", title: "A/B: C" }), "A-B- C");
  const l = appLayout("/b/Q.app", m);
  // path.join: the same layout is computed on any OS (tests run on Windows).
  assert.equal(l.exe, path.join("/b/Q.app", "Contents", "MacOS", "quick-note"));
  assert.equal(l.resources, path.join("/b/Q.app", "Contents", "Resources"));
  assert.equal(l.plist, path.join("/b/Q.app", "Contents", "Info.plist"));
});

test("signing plan: ad hoc, identity only, or identity plus notarization", () => {
  assert.deepEqual(signingPlan({}), { identity: null, notarize: false, partial: [] });
  const creds = { APPLE_ID: "a@b.c", APPLE_PASSWORD: "x", APPLE_TEAM_ID: "T" };
  assert.equal(signingPlan({ KESTREL_SIGN_IDENTITY: "Developer ID Application: X" }).notarize, false);
  assert.equal(signingPlan({ KESTREL_SIGN_IDENTITY: "Developer ID Application: X", ...creds }).notarize, true);
  assert.deepEqual(signingPlan({ APPLE_ID: "a@b.c" }).partial, ["APPLE_PASSWORD", "APPLE_TEAM_ID"]);
});
