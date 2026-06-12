# 🐋 baleia

The strategy brain on top of [krill](../ai-auto-worflow). You dump anything;
baleia captures it, distills it into living context, plans work with the
[ai-team](../ai-team) personas, triages what needs your review vs. what
bypasses, and drives krill to execute.

> Krill feeds the whale. Krill runs tasks → PRs; baleia decides which tasks
> exist, why, and who reviews them.

See **[PLAN.md](PLAN.md)** for the full architecture and phased build.

## Boundary

```
ai-team/  (personas, read-only)  ──▶  baleia  ──HTTP──▶  krill (execution)
```

One-way: baleia reads the personas, never writes them; talks to krill over its
HTTP API, never its DB.

## Phase 0 — persona-loader (done)

Reads `ai-team/` → routing doctrine + risk rubric + persona registry.

```bash
npm run loader -- /path/to/ai-team
# or: node src/persona-loader.mjs /path/to/ai-team
```

Prints the 14 personas (with full system prompts), the risk tiers, and the
safe-words — the artifacts baleia's planner/router/triage consume.

## Status

- [x] Phase 0 — persona-loader (sync foundation)
- [ ] Phase 1 — capture inbox + distiller + planner (thin slice, one project)
- [ ] Phase 2 — triage automation (risk → krill skip flags)
- [ ] Phase 3 — request router (across projects)
- [ ] Phase 4 — new-project generation (gated) + autonomy dials
