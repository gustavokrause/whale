// whale — LLM runner. Spawns the Claude Code CLI (`claude`) using your Claude
// Code auth. No API key, no separate billing line.
//
// Two modes:
//  - sandboxed (default): no tools — stages reason over the prompt only.
//  - audit: read-only repo access (Read/Grep/Glob) for onboarding a codebase.

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const TIMEOUT_MS = Number(process.env.WHALE_CLAUDE_TIMEOUT || 240000);

/* ---------- D1 metering: per-call usage capture ---------- */

// JSONL sidecar, NOT a db table — whale's runtime never migrates, and an
// append-only file needs no schema. Resolved lazily (see context-store.ts on
// top-level process.cwd() and Next's file tracer).
const usageFile = () =>
  process.env.WHALE_USAGE_FILE ||
  path.resolve(/* turbopackIgnore: true */ process.cwd(), "data/usage.jsonl");

export type UsageMeta = {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  session_id?: string;
};

/**
 * Parse the `--output-format json` result envelope: the assistant text lives in
 * `result`, usage/cost/duration ride alongside. Graceful: anything that isn't a
 * parseable envelope (an MCP OAuth hijack, a truncated reply) falls back to the
 * raw text with no usage meta. Pure; exported for tests.
 */
export function parseResultEnvelope(stdout: string): { text: string; meta: UsageMeta | null } {
  try {
    const j = JSON.parse(stdout) as Record<string, unknown>;
    if (j && typeof j === "object" && typeof j.result === "string") {
      const u = (j.usage || {}) as Record<string, unknown>;
      const num = (v: unknown) => (typeof v === "number" ? v : undefined);
      return {
        text: j.result.trim(),
        meta: {
          usage: {
            input_tokens: num(u.input_tokens),
            output_tokens: num(u.output_tokens),
            cache_creation_input_tokens: num(u.cache_creation_input_tokens),
            cache_read_input_tokens: num(u.cache_read_input_tokens),
          },
          total_cost_usd: num(j.total_cost_usd),
          num_turns: num(j.num_turns),
          duration_ms: num(j.duration_ms),
          session_id: typeof j.session_id === "string" ? j.session_id : undefined,
        },
      };
    }
  } catch {
    // not JSON — raw-text fallback below
  }
  return { text: stdout, meta: null };
}

// Append one usage row. Metering must never throw into the caller's run.
function recordUsage(row: { at: number; model: string; purpose: string } & UsageMeta): void {
  try {
    const f = usageFile();
    mkdirSync(path.dirname(f), { recursive: true });
    appendFileSync(f, `${JSON.stringify(row)}\n`, "utf8");
  } catch (err) {
    console.warn("usage metering failed:", err);
  }
}

/** Last `limit` usage rows (newest last), for GET /api/usage. Tolerant of junk lines. */
export function readUsageRows(limit = 200): unknown[] {
  try {
    const f = usageFile();
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

// Sandbox: block side-effecting AND repo-reading tools (planner must not wander).
const SANDBOX_DISALLOWED = ["Write", "Edit", "Bash", "Read", "Grep", "Glob", "WebFetch", "WebSearch", "Task"];
// Audit: allow read-only repo tools; still block writes/shell/web (B5 onboarding).
const AUDIT_DISALLOWED = ["Write", "Edit", "Bash", "WebFetch", "WebSearch", "Task"];

function aliasFor(model: string | undefined): string {
  const m = (model || "").toLowerCase();
  if (m.includes("haiku")) return "haiku";
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  return model || "sonnet";
}

type RunArgs = {
  system: string;
  user: string;
  model?: string;
  cwd?: string;
  disallowed?: string[];
  purpose?: string; // short metering label, e.g. "consensus:propose" (D1)
};

function runClaude({
  system,
  user,
  model,
  cwd = process.cwd(),
  disallowed = SANDBOX_DISALLOWED,
  purpose = "unknown",
}: RunArgs): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      CLAUDE_BIN,
      [
        "--model", aliasFor(model),
        "--print",
        // JSON envelope so usage/cost is capturable (D1). The assistant text
        // moves into the `result` field — extracted below, so callers still
        // receive plain text exactly as with --output-format text.
        "--output-format", "json",
        "--disallowed-tools", ...disallowed,
        // MCP is loaded by default so planning can reach project MCP servers
        // (e.g. Supabase logs). An UNAUTHENTICATED MCP will hijack stdout with an
        // OAuth prompt instead of the reply — authenticate it once so the headless
        // child reuses the cached token. WHALE_NO_MCP=1 loads zero MCP servers as
        // an escape hatch when one misbehaves (keeps CLI auth — never use --bare).
        ...(process.env.WHALE_NO_MCP === "1"
          ? ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']
          : []),
        "--dangerously-skip-permissions",
      ],
      { cwd, stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += b.toString()));
    child.stderr.on("data", (b) => (err += b.toString()));
    const killer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000);
    }, TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(killer);
      reject(
        new Error(
          `claude spawn failed: ${e.message} — is the Claude Code CLI installed/authed? (set CLAUDE_BIN)`,
        ),
      );
    });
    child.on("exit", (code, signal) => {
      clearTimeout(killer);
      if (signal) return reject(new Error(`claude killed (${signal})`));
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.trim().slice(0, 300)}`));
      const { text, meta } = parseResultEnvelope(out.trim());
      if (meta) recordUsage({ at: Date.now(), model: aliasFor(model), purpose, ...meta });
      resolve(text);
    });
    child.stdin.write(`${system}\n\n${user}`);
    child.stdin.end();
  });
}

// An MCP server / the CLI that isn't authenticated answers a headless call with
// an OAuth URL / login prompt instead of doing the work. Detect it so the unit
// can PAUSE and file a blocker (the unblock queue) rather than failing cryptically.
const MCP_AUTH_RE =
  /\b(authoriz|oauth|Open this URL|Please run \/login|Not logged in|authenticate)\b/i;
const LOGIN_RE = /\b(Please run \/login|Not logged in)\b/i;

export function looksLikeMcpAuth(text: string): boolean {
  return MCP_AUTH_RE.test(text);
}

/** Classify a non-JSON reply as a blocker, or null if it's an ordinary failure. */
export function classifyBlock(
  text: string,
): { kind: "mcp_auth" | "cli_login"; actionUrl?: string } | null {
  if (!looksLikeMcpAuth(text)) return null;
  return {
    kind: LOGIN_RE.test(text) ? "cli_login" : "mcp_auth",
    actionUrl: text.match(/https?:\/\/\S+/)?.[0],
  };
}

/** Raised when a headless run hit something interactive a human must clear. */
export class BlockedError extends Error {
  kind: string;
  detail: string;
  actionUrl?: string;
  constructor(o: { kind: string; summary: string; detail: string; actionUrl?: string }) {
    super(o.summary);
    this.name = "BlockedError";
    this.kind = o.kind;
    this.detail = o.detail;
    this.actionUrl = o.actionUrl;
  }
}

/**
 * Sandboxed, returns parsed JSON — plan / route / refine. With fileAccess, the
 * planner gets read-only repo tools (Read/Grep/Glob) scoped to `cwd` — for
 * file-referencing dumps. Output is still text with the JSON appended.
 */
export async function completeJSON<T = unknown>({
  system,
  user,
  model,
  cwd,
  fileAccess,
  purpose,
}: RunArgs & { fileAccess?: boolean }): Promise<T> {
  const text = await runClaude({
    system,
    user: `${user}\n\nRespond with ONLY valid JSON, no prose, no markdown fences.`,
    model,
    cwd,
    disallowed: fileAccess ? AUDIT_DISALLOWED : SANDBOX_DISALLOWED,
    purpose,
  });
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (match) return JSON.parse(match[0]) as T;
  const block = classifyBlock(text);
  if (block) {
    throw new BlockedError({
      kind: block.kind,
      summary:
        block.kind === "cli_login"
          ? "The Claude CLI isn't logged in"
          : "An MCP server needs authentication",
      detail: text.slice(0, 600),
      actionUrl: block.actionUrl,
    });
  }
  throw new Error(`no JSON in claude reply: ${text.slice(0, 200)}`);
}

/** Read-only audit of a repo at `cwd` (Read/Grep/Glob allowed) — B5 onboarding. */
export function auditComplete({ system, user, model, cwd, purpose }: RunArgs): Promise<string> {
  return runClaude({ system, user, model, cwd, disallowed: AUDIT_DISALLOWED, purpose });
}

/** Sandboxed free-text completion (no file tools). Voice output must stay
 *  prose — a JSON contract reshapes the register the D2 harness compares. */
export function completeText({ system, user, model, purpose }: RunArgs): Promise<string> {
  return runClaude({ system, user, model, purpose });
}
