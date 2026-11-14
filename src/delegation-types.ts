import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionToolContext,
  Skill,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { CapabilityDenial, ToolMetadata } from "./capabilities.ts";
import type { StructuredOutcome } from "./outcomes.ts";
import type { ModelSelection } from "./model-policy.ts";
import type { ExecutionLimits } from "./scheduling.ts";
import type { BuiltinTool, Profile } from "./profiles.ts";

export type DelegationMessage = {
  id: string;
  sender: ChildRef | "root";
  recipient: ChildRef | "root";
  text: string;
  mode: "inbox" | "steer" | "followUp";
  status: "accepted" | "queued" | "handled" | "delivered" | "not-running" | "error";
  error?: string;
};
export type CoordinationWait =
  | { status: "timeout" | "cancelled" | "shutdown" }
  | { status: "messages"; messages: DelegationMessage[] }
  | { status: "message"; message: DelegationMessage }
  | {
      status: "outcome";
      outcome: Pick<ChildSnapshot, "id" | "generation" | "status" | "limitReason" | "pauseReason">;
    };
export type ChildRef = Readonly<{ id: string; generation: number }>;
export type ChildSnapshot = Readonly<
  ChildRef & {
    parentId: string;
    parentGeneration?: number;
    depth: number;
    /** @deprecated No exclusive writer lease is held; new snapshots always report false. */
    writerLease: boolean;
    limits: ExecutionLimits;
    limitReason?: string;
    toolCalls: number;
    spawned?: number;
    pauseReason?: string;
    retainedContext?: boolean;
    window?: number;
    /** Immutable completion evidence from earlier windows of this same conversation. */
    completedWindows?: ReadonlyArray<
      Pick<
        ChildSnapshot,
        "window" | "status" | "result" | "outcome" | "artifacts" | "error" | "endedAt"
      >
    >;
    status:
      | "queued"
      | "setup"
      | "running"
      | "pausing"
      | "paused"
      | "draining"
      | "settled"
      | "failed"
      | "cancelled";
    profile: string;
    tools: readonly BuiltinTool[];
    leafTools?: readonly string[];
    skills?: readonly string[];
    capabilityDenials?: readonly CapabilityDenial[];
    cwd?: string;
    assignment: string;
    activity: string;
    progress: string;
    result: string;
    model: { provider: string; id: string };
    effort: string | null;
    fallback?: {
      chain: readonly ModelSelection[];
      index: number;
      failures: number;
      exhausted: boolean;
      skipped: readonly { target: ModelSelection; reason: string }[];
      attempts: readonly { target: ModelSelection; error?: string; usageKnown: boolean }[];
    };
    prewalk?: {
      target: ModelSelection;
      status: "armed" | "handed-off" | "suppressed-exact" | "no-op";
    };
    telemetry: {
      requests: number | null;
      tokens: ReturnType<AgentSession["getSessionStats"]>["tokens"] | null;
      cost: number | null;
      /** Cost is the known subtotal when failed-attempt usage is unavailable. */
      costIncomplete?: boolean;
      context: ReturnType<AgentSession["getContextUsage"]> | null;
    };
    outcome?: StructuredOutcome;
    artifacts?: { text?: string; structured?: string; error?: string };
    error?: string;
    transcript?: string;
    disposed: boolean;
    createdAt: number;
    endedAt: number | null;
  }
>;
export type RegistryEvent = Readonly<{
  type: "changed" | "sdk";
  child: ChildSnapshot;
  event?: AgentSessionEvent;
}>;
export type StartTask = {
  cwd?: string;
  model?: ModelSelection;
  fallback?: boolean;
  resultSchema?: unknown;
  assignment: string;
  profile: Profile;
  skills: Skill[];
  context: ExtensionToolContext;
  assertTools: (names: readonly string[]) => void;
  toolMetadata?: () => readonly ToolMetadata[];
  /** Live parent codemode availability; never a grant to forward its dispatcher. */
  codemodeEnabled?: () => boolean;
  availableSkills?: () => readonly Skill[];
  capabilityDenials?: CapabilityDenial[];
  leafProvenance?: Readonly<Record<string, string>>;
  callerId: string;
  parent?: ChildRef;
  limits?: Partial<ExecutionLimits>;
  coordinationTools?: (actor: ChildRef) => ToolDefinition[];
  nestedTool?: (parent: ChildRef) => ToolDefinition;
};
