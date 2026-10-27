import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { KernelPolicy } from "#kernel/policy.ts";
import { PiRuntime } from "#kernel/runtime.ts";
import type { Task, TaskExecutionPolicy } from "#kernel/types.ts";

let activeTask: Task | undefined;

const taskContext = {
  getActiveTask(): Task | undefined {
    return activeTask;
  },
};

// Punto de integración para el orquestador.
// No debe exponerse como herramienta al modelo.
export function setKernelActiveTask(task: Task | undefined): void {
  activeTask = task;
}

export async function createKernelRuntime(
  projectRoot: string,
  config: TaskExecutionPolicy,
): Promise<PiRuntime> {
  const policy = await KernelPolicy.create(projectRoot, config);
  return new PiRuntime(policy, taskContext);
}

export default function (pi: ExtensionAPI): void {
  let runtime: PiRuntime | undefined;
  let initializationError: string | undefined;

  const projectRoot = process.cwd();

  const config: TaskExecutionPolicy = {
    allowedRoles: ["orchestrator", "explore", "worker", "verify", "review"],
    allowedFiles: ["."],
    executionMode: "scoped-write",
    limits: {
      maxConcurrency: 1,
      maxDepth: 4,
      maxTasks: 40,
      maxRetries: 2,
      maxIterations: 20,
      timeoutMs: 120_000,
    },
  };

  void createKernelRuntime(projectRoot, config)
    .then((createdRuntime) => {
      runtime = createdRuntime;
    })
    .catch((error: unknown) => {
      initializationError =
        error instanceof Error ? error.message : String(error);
    });

  pi.registerTool({
    name: "kernel_read_file",
    label: "Kernel: leer archivo",
    description:
      "Lee un archivo de texto únicamente si la tarea activa del kernel lo autoriza.",
    parameters: Type.Object({
      path: Type.String({
        description: "Ruta relativa al directorio raíz del proyecto.",
      }),
    }),

    async execute(_toolCallId, params) {
      if (initializationError) {
        return {
          content: [{
            type: "text",
            text: `Kernel no inicializado: ${initializationError}`,
          }],
          isError: true,
        };
      }

      if (!runtime) {
        return {
          content: [{
            type: "text",
            text: "Kernel inicializándose; operación denegada.",
          }],
          isError: true,
        };
      }

      const result = await runtime.readText(params.path);

      return {
        content: [{
          type: "text",
          text: result.ok
            ? result.value
            : `Operación denegada [${result.code}]: ${result.error}`,
        }],
        isError: !result.ok,
      };
    },
  });

  pi.registerTool({
    name: "kernel_write_file",
    label: "Kernel: escribir archivo",
    description:
      "Sobrescribe un archivo existente únicamente si la tarea activa del kernel lo autoriza.",
    parameters: Type.Object({
      path: Type.String({
        description: "Ruta relativa al directorio raíz del proyecto.",
      }),
      content: Type.String({
        description: "Contenido completo que se escribirá en el archivo.",
      }),
    }),

    async execute(_toolCallId, params) {
      if (initializationError) {
        return {
          content: [{
            type: "text",
            text: `Kernel no inicializado: ${initializationError}`,
          }],
          isError: true,
        };
      }

      if (!runtime) {
        return {
          content: [{
            type: "text",
            text: "Kernel inicializándose; operación denegada.",
          }],
          isError: true,
        };
      }

      const result = await runtime.writeText(
        params.path,
        params.content,
      );

      return {
        content: [{
          type: "text",
          text: result.ok
            ? `Archivo actualizado: ${params.path}`
            : `Operación denegada [${result.code}]: ${result.error}`,
        }],
        isError: !result.ok,
      };
    },
  });
}