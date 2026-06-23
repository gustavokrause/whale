import { loadTeam } from "./persona-loader";
import { config } from "./config";

// Live-read: reload so persona edits in ai-team take effect without a restart.
export const getTeam = () => loadTeam(config.personasDir);
