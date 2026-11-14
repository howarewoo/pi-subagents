import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

test("local package manifest loads the root production entrypoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "extended-subagents-package-"));
  try {
    const repo = fileURLToPath(new URL("..", import.meta.url));
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory({ packages: [repo] }),
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(
      loaded.extensions.map((extension) => extension.path),
      [join(repo, "index.ts")],
    );
    assert.deepEqual([...loaded.extensions[0].commands.keys()].sort(), [
      "subagent-fallback-reset",
      "subagent-hub",
      "subagent-profiles",
      "subagent-status",
      "subagent-steer",
      "subagent-stop",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "isolated real Pi CLI exit aborts the delegated child before scripted completion",
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "extended-subagents-cli-"));
    try {
      const cli = fileURLToPath(
        new URL(
          "../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
          import.meta.url,
        ),
      );
      const extension = fileURLToPath(new URL("../src/pi-extended-subagents.ts", import.meta.url));
      const controlled = fileURLToPath(
        new URL("../examples/controlled-parent.ts", import.meta.url),
      );
      const invocation = promisify(execFile)(
        process.execPath,
        [
          cli,
          "--offline",
          "--no-extensions",
          "--no-mcp",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
          "--tools",
          "read,grep,find,ls,delegate_task",
          "--session-dir",
          join(root, "sessions"),
          "-e",
          extension,
          "-e",
          controlled,
          "-p",
          "delegate example",
        ],
        {
          cwd: root,
          timeout: 10000,
          env: {
            PATH: process.env.PATH,
            HOME: join(root, "home"),
            PI_CODING_AGENT_DIR: join(root, "agent"),
            PI_OFFLINE: "1",
          },
        },
      );
      // Pi consumes piped stdin before processing CLI prompts; signal EOF explicitly.
      invocation.child.stdin?.end();
      await invocation;
      const children = join(root, "sessions", "delegation");
      const parents = await readdir(children);
      assert.equal(parents.length, 1);
      const tasks = await readdir(join(children, parents[0]));
      assert.equal(tasks.length, 1);
      const transcripts = join(children, parents[0], tasks[0], "transcripts");
      const files = await readdir(transcripts);
      assert.equal(files.length, 1);
      const disk = await readFile(join(transcripts, files[0]), "utf8");
      assert.match(disk, /"stopReason":"aborted"/);
      assert.ok(!disk.includes('"stopReason":"stop"'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

for (const tool of ["delegate_task", "subagent"])
  test(
    `isolated ordinary-default Pi CLI ${tool} launches two scouts without activating grep/find/ls`,
    { timeout: 15000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "extended-subagents-default-cli-"));
      try {
        const cli = fileURLToPath(
          new URL(
            "../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
            import.meta.url,
          ),
        );
        const extension = fileURLToPath(
          new URL("../src/pi-extended-subagents.ts", import.meta.url),
        );
        const ai = new URL("../node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.url)
          .href;
        const controlled = join(root, "controlled-default.ts");
        await writeFile(join(root, "input.txt"), "default CLI real read payload");
        await writeFile(
          controlled,
          `
      import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(ai)};
      import { writeFile } from "node:fs/promises";
      import { join } from "node:path";
      export default function(pi) {
        const delegated = ${JSON.stringify(tool)};
        const provider = fauxProvider({provider:"default-cli-controlled", tokensPerSecond:0});
        const children = new Map(); let reads = 0; let complete;
        const drained = new Promise(resolve => {complete = resolve;});
        const respond = context => {
          provider.appendResponses([respond]);
          const user = context.messages.find(message => message.role === "user");
          const text = typeof user?.content === "string" ? user.content : user?.content.filter(block => block.type === "text").map(block => block.text).join("") ?? "";
          if (context.messages.at(-1)?.role === "toolResult" || (text === "default fleet" && context.messages.some(message => message.role === "toolResult" && message.toolName === delegated))) return fauxAssistantMessage("done");
          const tasks = delegated === "subagent" ? {async:false,tasks:[{agent:"scout",task:"alpha"},{agent:"scout",task:"beta"}]} : {background:true,tasks:[{profile:"scout",assignment:"alpha"},{profile:"scout",assignment:"beta"}]};
          return fauxAssistantMessage(fauxToolCall(text === "default fleet" ? delegated : "read", text === "default fleet" ? tasks : {path:"input.txt"}), {stopReason:"toolUse"});
        };
        provider.setResponses([respond]); pi.registerProvider(provider.provider);
        pi.events.on("delegation:registry", event => {
          children.set(event.child.id, event.child);
          if (children.size === 2 && [...children.values()].every(child => child.disposed)) complete();
        });
        pi.on("tool_call", event => {if (event.toolName === "read") reads++;});
        pi.on("session_start", async (_event, ctx) => {
          await ctx.modelRegistry.refresh({allowNetwork:false,providers:[provider.getModel().provider]});
          await pi.setModel(ctx.modelRegistry.find(provider.getModel().provider,provider.getModel().id));
        });
        pi.on("agent_end", async (_event, ctx) => {
          await drained;
          await writeFile(join(ctx.cwd,"observed.json"), JSON.stringify({active:pi.getActiveTools(),reads,children:[...children.values()]}));
        });
      }
    `,
        );
        const invocation = promisify(execFile)(
          process.execPath,
          [
            cli,
            "--offline",
            "--no-extensions",
            "--no-mcp",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "--session-dir",
            join(root, "sessions"),
            "-e",
            extension,
            "-e",
            controlled,
            "-p",
            "default fleet",
          ],
          {
            cwd: root,
            timeout: 10000,
            env: {
              PATH: process.env.PATH,
              HOME: join(root, "home"),
              PI_CODING_AGENT_DIR: join(root, "agent"),
              PI_OFFLINE: "1",
            },
          },
        );
        invocation.child.stdin?.end();
        await invocation;
        const observed = JSON.parse(await readFile(join(root, "observed.json"), "utf8")) as {
          active: string[];
          reads: number;
          children: import("../src/coordinator.ts").ChildSnapshot[];
        };
        assert.equal(observed.reads, 2, JSON.stringify(observed));
        assert.ok(
          observed.active.includes("subagent"),
          "compatibility tool is available at ordinary startup without an enable call",
        );
        for (const name of ["read", "bash", "edit", "write"])
          assert.ok(observed.active.includes(name));
        for (const name of ["grep", "find", "ls"]) assert.ok(!observed.active.includes(name));
        assert.equal(observed.children.length, 2);
        for (const child of observed.children) {
          assert.equal(child.status, "settled");
          assert.equal(child.disposed, true);
          assert.deepEqual(child.tools, ["read"]);
          assert.equal(child.writerLease, false);
          assert.match(await readFile(child.transcript!, "utf8"), /default CLI real read payload/);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
