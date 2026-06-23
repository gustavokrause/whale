// krill → whale feedback: pull krill's open follow-ups into whale's inbox as new
// dumps, then mark them consumed in krill. Preserves the one-way dependency
// (whale pulls; krill never calls whale). The dumps then flow through the normal
// Plan → triage → propose → push pipeline, which is the gate.

import * as krill from "./krill-client";
import { addEntry } from "@/db/queries";
import { keyToSlug } from "./context-store";

let ingesting = false;

export async function ingestFollowups(): Promise<number> {
  if (ingesting) return 0; // single-flight within this whale process
  ingesting = true;
  try {
    const items = await krill.listFollowups();
    let n = 0;
    for (const f of items) {
      const body = f.description ? `${f.title}\n\n${f.description}` : f.title;
      const lineage = f.task_id ? `\n\n(follow-up of ${f.task_id})` : "";
      addEntry({
        text: body + lineage,
        projectHint: keyToSlug(f.project_name),
        source: "krill-followup",
      });
      await krill.consumeFollowup(f.id);
      n++;
    }
    return n;
  } catch {
    return 0;
  } finally {
    ingesting = false;
  }
}
