import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// This helper is checked out from the release commit, never loaded from the artifact.
// Expected identity/digest come from workflow context and validation outputs, not the download.
const directory = process.argv[2];
assert.ok(
  process.argv.length === 3 || (process.argv.length === 4 && process.argv[3] === "--verify-only"),
  "Expected artifact directory and optional --verify-only",
);
assert.ok(directory, "Supply the verified release artifact directory");
const { RELEASE_TAG: tag, RELEASE_COMMIT: commit, RELEASE_INTEGRITY: expected } = process.env;
assert.match(tag ?? "", /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
assert.match(commit ?? "", /^[a-f0-9]{40}$/);
assert.match(expected ?? "", /^sha512-[A-Za-z0-9+/]{86}==$/);
const metadataPath = join(directory, "metadata.json");
const metadataStat = await lstat(metadataPath);
assert.ok(metadataStat.isFile() && metadataStat.size <= 4096, "Invalid artifact metadata file");
const pkg = JSON.parse(await readFile(metadataPath, "utf8"));
assert.deepEqual(
  pkg,
  {
    name: "@howarewoo/pi-subagents",
    version: tag.slice(1),
    tag,
    commit,
    tarball: "release.tgz",
    integrity: expected,
  },
  "Release artifact metadata does not match validation",
);
const tarball = resolve(directory, "release.tgz");
assert.ok((await lstat(tarball)).isFile(), "Invalid release tarball file");
const integrity = `sha512-${createHash("sha512")
  .update(await readFile(tarball))
  .digest("base64")}`;
assert.equal(integrity, expected, "Release tarball SHA512 does not match validation");

if (process.argv[3] === "--verify-only") {
  console.log(
    `Verified ${pkg.name}@${pkg.version}: ${integrity} (no registry access or publication)`,
  );
  process.exit(0);
}
// No stored-token fallback. Only the protected GitHub job may request OIDC publication.
assert.ok(
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  "GitHub OIDC context required",
);
assert.ok(
  !process.env.NODE_AUTH_TOKEN && !process.env.NPM_TOKEN,
  "Stored npm tokens are not allowed",
);
const [major, minor, patch] = execFileSync("npm", ["--version"], { encoding: "utf8" })
  .trim()
  .split(".")
  .map(Number);
assert.ok(
  major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1))),
  "npm >=11.5.1 required for trusted publishing",
);
const response = await fetch(
  `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`,
);
if (response.status === 404) {
  execFileSync("npm", ["publish", tarball, "--access", "public", "--ignore-scripts"], {
    stdio: "inherit",
  });
} else {
  assert.equal(response.status, 200, "Cannot verify existing npm version; refusing to publish");
  const published = await response.json();
  assert.equal(
    published.dist?.integrity,
    integrity,
    "This version exists with different contents. Never overwrite it; prepare a new version.",
  );
  console.log(`${pkg.name}@${pkg.version} already published with identical contents; continuing`);
}
