// whale — LLM runner. Spawns the Claude Code CLI (`claude`) using your Claude
// Code auth. No API key, no separate billing line.
//
// Two modes:
//  - sandboxed (default): no tools — stages reason over the prompt only.
//  - audit: read-only repo access (Read/Grep/Glob) for onboarding a codebase.

import { spawn } from "node:child_process";

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const TIMEOUT_MS = Number(process.env.WHALE_CLAUDE_TIMEOUT || 240000);

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
};

function runClaude({
  system,
  user,
  model,
  cwd = process.cwd(),
  disallowed = SANDBOX_DISALLOWED,
}: RunArgs): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      CLAUDE_BIN,
      [
        "--model", aliasFor(model),
        "--print",
        "--output-format", "text",
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
      resolve(out.trim());
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

/** Sandboxed, returns parsed JSON — plan / route / refine. */
export async function completeJSON<T = unknown>({ system, user, model }: RunArgs): Promise<T> {
  const text = await runClaude({
    system,
    user: `${user}\n\nRespond with ONLY valid JSON, no prose, no markdown fences.`,
    model,
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
export function auditComplete({ system, user, model, cwd }: RunArgs): Promise<string> {
  return runClaude({ system, user, model, cwd, disallowed: AUDIT_DISALLOWED });
}
