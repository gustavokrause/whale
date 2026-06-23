// Runs once at server start (Next instrumentation). Layer the DB config overrides
// over env defaults so config.* reads are correct from the first request.
export async function register() {
  // better-sqlite3 (via @/db/queries) is Node-only. Skip on the Edge runtime,
  // where instrumentation also runs by default, to avoid Edge bundling warnings.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { setConfigOverrides } = await import("@/lib/config");
  const { readConfig } = await import("@/db/queries");
  setConfigOverrides(readConfig());
}
