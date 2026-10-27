import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initializeUi, startTurn, endTurn, setSessionTitle, setCurrentModel, addTurnUsage, toggleSidebar, requestUiRender } from "#kernel/opencode-ui.ts";

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event: any, context: any) => {
    initializeUi(context, pi);
  });

  pi.on("agent_start", () => startTurn());
  pi.on("agent_end", () => endTurn());

  pi.on("input", async (event: any) => {
    setSessionTitle(event?.text);
  });

  pi.on("model_select", async (event: any) => {
    setCurrentModel(event?.model?.id);
  });

  pi.on("turn_end", async (event: any) => {
    addTurnUsage(event?.message?.usage);
  });

  pi.registerCommand("sidebar", {
    description: "Mostrar u ocultar el panel lateral derecho",
    handler: async () => {
      toggleSidebar();
      requestUiRender();
    }
  });
}
