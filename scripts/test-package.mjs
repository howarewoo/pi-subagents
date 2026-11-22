import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import config from "./test-package.config.mjs";

// Install the actual tarball (cache-first, isolated npm config, no host peers) and load it
// through Pi's package loader. Per-repo values and optional behavior checks live in test-package.config.mjs.
const expected = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const root = await mkdtemp(join(tmpdir(), `${expected.name.split("/").pop()}-packed-`));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
try {
  let tarball = process.argv[2] && resolve(process.argv[2]);
  if (!tarball) {
    const [packed] = JSON.parse(
      execFileSync("npm", ["pack", "--json", "--pack-destination", root], { encoding: "utf8" }),
    );
    tarball = join(root, packed.filename);
  }
  // Inspect real tar headers before installation. Only deliberately shipped files are allowed.
  const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
  for (const entry of entries) {
    assert.ok(!entry.split("/").includes(".."), `Unsafe tar path: ${entry}`);
    assert.match(entry, config.files, `Unexpected packed file: ${entry}`);
  }
  await writeFile(join(root, "package.json"), '{"private":true,"type":"module"}\n');
  await writeFile(join(root, "npmrc"), "");
  execFileSync(
    "npm",
    [
      "install",
      "--prefer-offline",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--userconfig",
      join(root, "npmrc"),
      tarball,
    ],
    { cwd: root, stdio: "inherit" },
  );
  const installed = join(root, "node_modules", ...expected.name.split("/"));
  const pkg = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.deepEqual(pkg, expected);
  assert.ok(
    !pkg.bundledDependencies && !pkg.bundleDependencies,
    "Packages must not bundle dependencies",
  );
  assert.deepEqual(pkg.pi.extensions, ["./index.ts"]);

  // Only the package and its locked production dependencies install; Pi supplies host peers.
  const consumer = JSON.parse(
    await readFile(join(root, "node_modules", ".package-lock.json"), "utf8"),
  );
  const production = Object.entries(lock.packages)
    .filter(([path, entry]) => path && !entry.dev && !entry.devOptional)
    .map(([path]) => path);
  assert.deepEqual(
    Object.keys(consumer.packages).sort(),
    [`node_modules/${pkg.name}`, ...production].sort(),
    "Installed packages must match the locked production tree",
  );
  for (const peer of Object.keys(pkg.peerDependencies ?? {}))
    assert.ok(
      !Object.keys(consumer.packages).some((path) => path.endsWith(`node_modules/${peer}`)),
      `Host package duplicated: ${peer}`,
    );
  const topLevel = new Set(Object.keys(consumer.packages).map((path) => path.split("/")[1]));
  assert.deepEqual((await readdir(join(root, "node_modules"))).sort(), [
    ".package-lock.json",
    ...[...topLevel].sort(),
  ]);

  for (const file of config.requiredFiles)
    assert.ok(
      (await readFile(join(installed, file), "utf8").catch(() => "")).trim(),
      `Missing ${file}`,
    );
  const readme = await readFile(join(installed, "README.md"), "utf8");
  for (const [, target] of readme.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
    if (/^(?:https?:|#)/.test(target)) continue;
    const path = resolve(dirname(join(installed, "README.md")), target.split("#")[0]);
    assert.ok(!relative(installed, path).startsWith(".."), `Escaping README link: ${target}`);
    const bytes = await readFile(path).catch(() => Buffer.alloc(0));
    assert.ok(bytes.length, `Broken packed README link: ${target}`);
  }

  const { DefaultResourceLoader, SettingsManager } =
    await import("@earendil-works/pi-coding-agent");
  const host = JSON.parse(
    await readFile(
      new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    host.version,
    expected.devDependencies["@earendil-works/pi-coding-agent"],
    "Smoke test must exercise the pinned host",
  );
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    settingsManager: SettingsManager.inMemory({ packages: [installed] }),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const [extension] = loaded.extensions;
  assert.equal(extension.path, join(installed, "index.ts"));
  assert.deepEqual([...extension.tools.keys()].sort(), [...config.tools].sort());
  assert.deepEqual([...extension.commands.keys()].sort(), [...config.commands].sort());

  // Exercise the pinned host's real startup-label renderer with npm source metadata.
  // Import by file URL because this internal renderer is not a public SDK export.
  const { InteractiveMode } = await import(
    new URL(
      "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js",
      import.meta.url,
    )
  );
  const renderer = Object.create(InteractiveMode.prototype);
  assert.deepEqual(
    renderer.getCompactExtensionLabels([
      {
        path: extension.path,
        sourceInfo: { ...extension.sourceInfo, source: `npm:${pkg.name}`, baseDir: installed },
      },
    ]),
    [pkg.name],
    "npm startup label must not include an entry-point suffix",
  );

  await config.verify?.({ extension, pkg, installed, root, host });
  console.log(
    `Packed ${pkg.name}@${pkg.version}: ${entries.length} allowed files; README links resolve; isolated Pi ${host.version} load passed. Tarball: ${tarball}`,
  );
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
