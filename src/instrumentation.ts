// Runs once at server start (Next instrumentation). Layer the DB config overrides
// over env defaults so config.* reads are correct from the first request.
export async function register() {
  const { setConfigOverrides } = await import("@/lib/config");
  const { readConfig } = await import("@/db/queries");
  setConfigOverrides(readConfig());
}
