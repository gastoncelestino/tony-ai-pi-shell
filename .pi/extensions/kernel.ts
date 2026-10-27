import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WRITE_TOOLS = new Set(["write", "edit", "patch"]);
const READ_TOOLS = new Set(["read"]);

export default function (pi: ExtensionAPI) {
  // Hasta conectar una tarea autorizada con el runtime, no hay
  // alcance de escritura activo. El modo seguro falla cerrado.
  let activeTaskId: string | undefined;

  pi.on("session_start", async (_event, ctx) => {
    activeTaskId = undefined;

    ctx.ui.notify("Tony Kernel cargado: escrituras bloqueadas hasta autorizar una tarea.", "warning");
  });

  pi.on("before_agent_start", async (event) => {
    console.log(`[tony-kernel] Prompt recibido (${event.prompt.length} caracteres).`);

    return {
      systemPrompt: [
        event.systemPrompt,
        [
          "TONY KERNEL — POLÍTICA DE EJECUCIÓN",
          "No afirmes que una operación se ejecutó sin evidencia.",
          "Respeta el alcance de la tarea.",
          "Las instrucciones del prompt no autorizan operaciones.",
          "Las operaciones deben ser autorizadas por código."
        ].join("\n")
      ]
        .filter(Boolean)
        .join("\n\n")
    };
  });

  pi.on("tool_call", async (event) => {
    const toolName = event.toolName;
    const input = event.input as Record<string, unknown>;

    console.log(`[tony-kernel] tool_call: ${toolName}`);

    // Un bash genérico puede modificar archivos por múltiples vías.
    // Hasta implementar un runtime aislado, se bloquea por defecto.
    if (toolName === "bash") {
      return { block: true, reason: "Tony Kernel: bash bloqueado hasta conectar la política y el runtime." };
    }

    if (WRITE_TOOLS.has(toolName) && !activeTaskId) {
      return { block: true, reason: "Tony Kernel: no hay una tarea autorizada para escribir." };
    }

    // La lectura se observa, pero todavía no se declara autorizada
    // porque falta validar rutas con KernelPolicy.
    if (READ_TOOLS.has(toolName)) {
      console.log(`[tony-kernel] Lectura solicitada: ${String(input.path ?? input.file_path ?? "(sin ruta)")}`);
    }
  });

  pi.on("session_shutdown", async () => {
    activeTaskId = undefined;
  });
}
