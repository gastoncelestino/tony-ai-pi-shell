import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  initializeUi,
  startTurn,
  endTurn,
  setSessionTitle,
  setCurrentModel,
  requestRender,
  addTurnUsage,
  toggleSidebar
} from "#kernel/ui/opencode-ui.ts";

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_event: any, ctx: any) => initializeUi(ctx, pi));
  pi.on("agent_start", () => startTurn());
  pi.on("agent_end", () => endTurn());
  pi.on("input", (event: any) => setSessionTitle(event.text));
  pi.on("model_select", (event: any) => setCurrentModel(event.model.id));
  pi.on("thinking_level_select", () => requestRender());
  pi.on("turn_end", (event: any) => addTurnUsage((event.message as any)?.usage));
  pi.registerCommand("sidebar", {
    description: "Mostrar u ocultar el panel lateral derecho",
    handler: async () => toggleSidebar()
  });
}
