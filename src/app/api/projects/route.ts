import { knownProjects } from "@/lib/pipeline";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

// Project picker for the UI: krill projects ∪ onboarded contexts.
export async function GET() {
  try {
    return json({ projects: await knownProjects() });
  } catch (e) {
    return fail(e);
  }
}
