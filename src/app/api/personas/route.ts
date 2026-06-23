import { getTeam } from "@/lib/team";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

// Diagnostic for bridge status.sh: confirms the ai-team roster resolves.
export async function GET() {
  try {
    const team = await getTeam();
    const thin = team.personas.filter((p) => p.systemPrompt.length < 200).map((p) => p.name);
    return json({ count: team.personas.length, ok: thin.length === 0, thin });
  } catch (e) {
    return fail(e, 500);
  }
}
