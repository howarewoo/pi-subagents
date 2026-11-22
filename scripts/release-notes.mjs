import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const tag = process.argv[2] ?? `v${pkg.version}`;

// Prereleases need an explicit channel policy before they can be published.
assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
assert.equal(tag, `v${pkg.version}`, "Release tag must match package.json");
assert.equal(lock.name, pkg.name, "Lockfile name must match package.json");
assert.equal(lock.version, pkg.version, "Lockfile version must match package.json");
for (const key of [
  "name",
  "version",
  "engines",
  "dependencies",
  "peerDependencies",
  "devDependencies",
])
  assert.deepEqual(lock.packages[""][key], pkg[key], `Lockfile root ${key} must match`);
assert.equal(pkg.publishConfig?.access, "public", "Scoped packages must publish publicly");
assert.equal(pkg.license, "MIT", "Review licensing before changing the release policy");

const changelog = await readFile("CHANGELOG.md", "utf8");
const heading = `## [${pkg.version}]`;
const lines = changelog.split("\n");
const start = lines.indexOf(heading);
assert.ok(start >= 0, `Missing changelog heading: ${heading}`);
assert.equal(lines.indexOf(heading, start + 1), -1, "Duplicate release heading");
const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
const notes = lines
  .slice(start + 1, next < 0 ? undefined : next)
  .join("\n")
  .trim();
assert.ok(notes, "Release notes must not be empty");
if (process.argv[3]) await writeFile(process.argv[3], `${notes}\n`);
console.log(`Release metadata verified: ${tag}`);
