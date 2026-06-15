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

/** Sandboxed text generation (no tools) — distill / plan / route. */
export function complete({ system, user, model }: RunArgs): Promise<string> {
  return runClaude({ system, user, model });
}

/** Sandboxed, returns parsed JSON. */
export async function completeJSON<T = unknown>({ system, user, model }: RunArgs): Promise<T> {
  const text = await runClaude({
    system,
    user: `${user}\n\nRespond with ONLY valid JSON, no prose, no markdown fences.`,
    model,
  });
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error(`no JSON in claude reply: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]) as T;
}

/** Read-only audit of a repo at `cwd` (Read/Grep/Glob allowed) — B5 onboarding. */
export function auditComplete({ system, user, model, cwd }: RunArgs): Promise<string> {
  return runClaude({ system, user, model, cwd, disallowed: AUDIT_DISALLOWED });
}
