import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { SessionManager, initTheme } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { fixture, eventually } from "./fixtures.ts";
import { transcriptLines } from "../src/task-presentation.ts";
import { createNativeThread } from "../src/thread.ts";
import { compactionWouldSpendReserve } from "../src/child-execution.ts";
import type { ChildSnapshot } from "../src/delegation-types.ts";

type Context = Parameters<FauxResponseFactory>[0];
const system = (context: Context) =>
  context.messages.filter((message) => message.role === "system").map((m) => JSON.stringify(m));
const isSummary = (context: Context) =>
  system(context).some((text) => text.includes("You are a context summarization assistant"));
const isChild = (context: Context) =>
  system(context).some((text) => text.includes("delegated child"));

/** A child that reads a ~10k-token file `reads` times, then answers; summaries are recorded. */
async function compactingFixture(t: Parameters<typeof fixture>[0], reads: number) {
  const summaries: Context[] = [];
  const child: Context[] = [];
  let issued = 0;
  const f = await fixture(t, {
    speed: 0,
    // Pi default thresholds: compact above 40000 - 16384 tokens, keep 20000 recent.
    contextWindow: 40000,
    response: (context) => {
      if (isSummary(context)) {
        summaries.push(structuredClone(context));
        return fauxAssistantMessage("## Goal\nCOMPACTED SUMMARY");
      }
      if (isChild(context)) child.push(structuredClone(context));
      if (isChild(context) && issued < reads) {
        issued++;
        return fauxAssistantMessage(fauxToolCall("read", { path: "big.txt" }), {
          stopReason: "toolUse",
        });
      }
      return fauxAssistantMessage("final report");
    },
  });
  await writeFile(
    join(f.root, "big.txt"),
    "ORIGINAL-EVIDENCE\n" +
      Array.from({ length: 400 }, (_, i) => `${i}`.padEnd(99, "x")).join("\n"),
  );
  return { f, summaries, child };
}

test("F4: a child past the compaction threshold compacts through counted parent routing and continues", async (t) => {
  const { f, summaries, child } = await compactingFixture(t, 4);
  const ref = await f.direct("long task", "general", { limits: { requests: 6 } });
  const result = await f.coordinator.wait(ref);
  assert.equal(result.status, "settled", result.error ?? "");
  assert.equal(result.result, "final report");
  assert.ok(summaries.length >= 1, "automatic compaction dispatched a summary request");
  // N2: every physical request, including summaries, is charged by the dispatch gate.
  assert.equal(result.telemetry.requests, child.length + summaries.length);
  assert.equal(result.telemetry.requests, 6);
  // Summaries see earlier history, but never the per-request budget guidance projection.
  assert.match(JSON.stringify(summaries[0]), /ORIGINAL-EVIDENCE/);
  for (const summary of summaries) {
    assert.equal(system(summary).length, 1, "only the summarization prompt is a system message");
    assert.doesNotMatch(JSON.stringify(summary), /delegation budget|Delegation wrap-up/);
  }
  assert.ok(
    child.some((context) => /Delegation wrap-up/.test(JSON.stringify(context))),
    "guidance remained active for ordinary child requests",
  );
  const projected = f.coordinator.messages(ref);
  assert.ok(projected.some((message) => message.role === "compactionSummary"));
  // The JSONL transcript keeps every pre-compaction tool result plus the compaction entry.
  const entries = SessionManager.open(result.transcript!).getEntries();
  assert.ok(entries.some((entry) => entry.type === "compaction"));
  const results = entries.filter(
    (entry) => entry.type === "message" && entry.message.role === "toolResult",
  );
  assert.equal(results.length, 4);
  assert.match(await readFile(result.transcript!, "utf8"), /ORIGINAL-EVIDENCE/);
  // Hub transcript and native thread views still render the compacted session.
  assert.ok(transcriptLines(projected).includes("final report"));
  initTheme("dark", false);
  const tui = new TuiMainScreen(new ProcessTerminal());
  t.mock.method(tui, "requestRender", () => {});
  const lines = createNativeThread({ tui, cwd: f.root }).render(
    "id/1",
    projected,
    undefined,
    undefined,
    80,
  );
  assert.match(lines.join("\n"), /final report/);
});

test("F4: compaction never spends the report reserve near the request cap", async (t) => {
  const { f, summaries, child } = await compactingFixture(t, 4);
  const ref = await f.direct("short budget", "general", { limits: { requests: 5 } });
  const result = await f.coordinator.wait(ref);
  assert.equal(result.status, "settled", result.error ?? "");
  assert.equal(result.result, "final report");
  assert.equal(summaries.length, 0);
  assert.equal(result.telemetry.requests, child.length);
  assert.equal(result.telemetry.requests, 5);
});

const scripted = (errors: string[]) => {
  const calls: string[] = [];
  const response: FauxResponseFactory = (context) => {
    if (!isChild(context)) return fauxAssistantMessage("parent");
    const error = errors[calls.length];
    calls.push(error ?? "ok");
    return error
      ? fauxAssistantMessage("failed draft", { stopReason: "error", errorMessage: error })
      : fauxAssistantMessage("recovered");
  };
  return { calls, response };
};

test("F5: an unchained child retries a transient error twice on the same model, counting each attempt", async (t) => {
  const { calls, response } = scripted(["503 Service Unavailable", "overloaded_error"]);
  const f = await fixture(t, { speed: 0, response });
  const ref = await f.direct("transient");
  const result = await f.coordinator.wait(ref);
  assert.equal(result.status, "settled", result.error ?? "");
  assert.equal(result.result, "recovered");
  assert.equal(result.fallback, undefined);
  assert.equal(calls.length, 3);
  assert.equal(result.telemetry.requests, 3);
});

test("F5: an unchained child fails after three transient attempts", async (t) => {
  const { calls, response } = scripted(Array(4).fill("503 Service Unavailable"));
  const f = await fixture(t, { speed: 0, response });
  const result = await f.coordinator.wait(await f.direct("persistent outage"));
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /503/);
  assert.equal(calls.length, 3);
  assert.equal(result.telemetry.requests, 3);
});

for (const error of ["401 Unauthorized: invalid api key", "400 invalid_request_error"]) {
  test(`F5: non-retryable ${error} fails immediately`, async (t) => {
    const { calls, response } = scripted([error, error]);
    const f = await fixture(t, { speed: 0, response });
    const result = await f.coordinator.wait(await f.direct("terminal"));
    assert.equal(result.status, "failed");
    assert.equal(calls.length, 1);
    assert.equal(result.telemetry.requests, 1);
  });
}

test("F5: stopping during same-model retry backoff dispatches no further attempt", async (t) => {
  const { calls, response } = scripted(["503 Service Unavailable"]);
  const f = await fixture(t, { speed: 0, response });
  const ref = await f.direct("stop in backoff");
  await eventually(() => calls.length === 1);
  await f.coordinator.stop(ref);
  const result = await f.coordinator.wait(ref);
  assert.equal(result.status, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(calls.length, 1);
  assert.equal(result.telemetry.requests, 1);
});

test("F4: the compaction reserve guard is relative to the current budget window", () => {
  const state = (requests: number, windowStart?: ChildSnapshot["windowStart"]) =>
    ({ limits: { requests: 10 }, telemetry: { requests }, windowStart }) as ChildSnapshot;
  // Cumulative 9 of 10 would suppress, but this window has used only 4 requests.
  assert.equal(compactionWouldSpendReserve({ state: state(9) }), true);
  assert.equal(
    compactionWouldSpendReserve({ state: state(9, { requests: 5, toolCalls: 0 }) }),
    false,
  );
  assert.equal(
    compactionWouldSpendReserve({ state: state(13, { requests: 5, toolCalls: 0 }) }),
    true,
  );
  // A split-turn compaction needs two summaries: 3 left in the window is not enough.
  assert.equal(
    compactionWouldSpendReserve({ state: state(12, { requests: 5, toolCalls: 0 }) }, 2),
    true,
  );
  assert.equal(
    compactionWouldSpendReserve({ state: state(11, { requests: 5, toolCalls: 0 }) }, 2),
    false,
  );
  assert.equal(
    compactionWouldSpendReserve({
      state: state(9, { requests: 5, toolCalls: 0 }),
      wrapUp: { reason: "requests", requestCeiling: 10 },
    }),
    true,
  );
});
