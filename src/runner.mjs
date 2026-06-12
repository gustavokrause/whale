// baleia — LLM runner. Real = Anthropic Messages API (zero-dep fetch).
// Stub callers don't reach here; each stage owns its deterministic fallback.

import { config } from "./config.mjs";

/** Call Claude, return raw text. */
export async function complete({ system, user, model, maxTokens = 1500 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY unset (BALEIA_RUNNER=real)");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: model || config.models.plan,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return (json.content || []).map((b) => b.text || "").join("");
}

/** Call Claude and parse a JSON object/array from the reply. */
export async function completeJSON({ system, user, model, maxTokens = 1500 }) {
  const text = await complete({
    system,
    user: `${user}\n\nRespond with ONLY valid JSON, no prose, no markdown fences.`,
    model,
    maxTokens,
  });
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error(`no JSON in model reply: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]);
}
