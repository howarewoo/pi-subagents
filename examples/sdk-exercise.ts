// Controlled real SDK walkthrough; no credentials or live provider calls.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import delegation from "../src/pi-extended-subagents.ts";
import { createControlledProvider } from "./controlled-parent.ts";
import type { RegistryEvent } from "../src/coordinator.ts";

const root = await mkdtemp(join(tmpdir(), "delegation-exercise-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "operator");
try {
  const settings = SettingsManager.inMemory();
  const events: RegistryEvent[] = [];
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      delegation,
      (pi) => {
        pi.events.on("delegation:registry", (event) => events.push(event as RegistryEvent));
      },
    ],
  });
  await loader.reload();
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(root, "cache.json"),
    refreshOnCreate: false,
  });
  const controlled = createControlledProvider();
  runtime.registerNativeProvider(controlled.provider);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: loader,
    modelRuntime: runtime,
    model: controlled.getModel(),
    tools: ["read", "grep", "find", "ls", "delegate_task", "subagent"],
    settingsManager: settings,
    sessionManager: SessionManager.create(root, join(root, "sessions")),
  });
  try {
    await session.bindExtensions({
      mode: "rpc",
      onError: (error) => {
        throw new Error(JSON.stringify(error));
      },
    });
    await session.prompt("delegate example");
    const ref = events.at(-1)!.child;
    assert.equal(ref.status, "running");
    await session.prompt(`steer example ${ref.id}@${ref.generation}`);
    const steered = session.messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === "subagent",
    );
    assert.ok(steered?.role === "toolResult" && !steered.isError, JSON.stringify(steered));
    await session.reload();
    const final = events.filter((event) => event.child.id === ref.id).at(-1)!.child;
    assert.equal(final.status, "cancelled");
    assert.equal(final.disposed, true);
    assert.match(await readFile(final.transcript!, "utf8"), /"stopReason":"aborted"/);
    console.log(
      "PASS: model task -> SDK child, public selected-provider adapter, streaming, identity, steer, reload drain, persistent abort transcript.",
    );
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
} finally {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(root, { recursive: true, force: true });
}
