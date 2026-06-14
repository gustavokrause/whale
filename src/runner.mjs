// baleia — LLM runner. Mirrors krill: spawns the Claude Code CLI (`claude`),
// using your Claude Code auth. No API key, no separate billing line.
//
// Stub callers never reach here; each stage owns its deterministic fallback.

import { spawn } from "node:child_process";

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const TIMEOUT_MS = Number(process.env.BALEIA_CLAUDE_TIMEOUT || 240000);

/** Map any model id/alias to a CLI-accepted alias. */
function aliasFor(model) {
  const m = (model || "").toLowerCase();
  if (m.includes("haiku")) return "haiku";
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  return model || "sonnet";
}

/** Run `claude` headless: full prompt via stdin, text out. */
export function complete({ system, user, model }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      CLAUDE_BIN,
      [
        "--model", aliasFor(model),
        "--print",
        "--output-format", "text",
        // pure text generation — block ALL side-effecting AND repo-reading tools.
        // baleia's stages reason over the prompt only; without this the planner
        // wandered the codebase (read PLAN.md, proposed repo tasks) instead of
        // planning from CONTEXT, and wrote a stray CONTEXT.md. Valid names only
        // (the CLI rejects unknown ones — "MultiEdit" did).
        "--disallowed-tools", "Write", "Edit", "Bash", "Read", "Grep", "Glob", "WebFetch", "WebSearch", "Task",
        "--dangerously-skip-permissions",
      ],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] }
    );

    let out = "", err = "";
    child.stdout.on("data", (b) => (out += b.toString()));
    child.stderr.on("data", (b) => (err += b.toString()));

    const killer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000);
    }, TIMEOUT_MS);

    child.on("error", (e) =>
      (clearTimeout(killer),
      reject(new Error(`claude spawn failed: ${e.message} — is the Claude Code CLI installed/authed? (set CLAUDE_BIN)`)))
    );
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

/** Run `claude` and parse a JSON object/array from the reply. */
export async function completeJSON({ system, user, model }) {
  const text = await complete({
    system,
    user: `${user}\n\nRespond with ONLY valid JSON, no prose, no markdown fences.`,
    model,
  });
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error(`no JSON in claude reply: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]);
}
