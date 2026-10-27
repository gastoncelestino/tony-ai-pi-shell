import { posix as path } from "node:path";

import type {
  AgentInput,
  AgentRuntime,
  SchedulerLimits,
  Task
} from "./types.js";

import { Orchestrator } from "./orchestrator.js";
import { KernelPolicy } from "./policy.js";

export type SchedulerOptions = {
  orchestrator: Orchestrator;
  policy: KernelPolicy;
  runtime: AgentRuntime;
  limits: SchedulerLimits;
  getContext?: (task: Task) => Promise<string[]>;
  onEvent?: (event: {
    type: "task-started" | "task-finished" | "task-error";
    taskId: string;
    status?: string;
    message?: string;
  }) => void;
};

type ActiveTask = {
  controller: AbortController;
  files: string[];
  execution: Promise<void>;
};

class SchedulerTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timeout después de ${timeoutMs} ms.`);
    this.name = "SchedulerTimeoutError";
  }
}

export class KernelScheduler {
  private stopped = false;
  private ticking = false;

  private readonly active = new Map<string, ActiveTask>();

  /**
   * Evita repetir indefinidamente el mismo evento de denegación
   * mientras una tarea permanezca ready.
   */
  private readonly reportedDenials = new Map<string, string>();

  constructor(private readonly options: SchedulerOptions) {
    this.validateLimits(options.limits);
  }

  // ─────────────────────────────────────────────
  // Ciclo de vida
  // ─────────────────────────────────────────────

  /**
   * Detiene nuevos despachos y solicita la cancelación de las
   * ejecuciones activas.
   *
   * No espera indefinidamente a runtimes que ignoren AbortSignal.
   * Las tareas activas se limpian cuando sus promesas finalizan.
   */
  async stop(): Promise<void> {
    this.stopped = true;

    for (const { controller } of this.active.values()) {
      if (!controller.signal.aborted) {
        controller.abort(new Error("Scheduler detenido."));
      }
    }
  }

  /**
   * Permite volver a despachar tareas.
   * No reinicia ni resucita ejecuciones anteriores.
   */
  resume(): void {
    this.stopped = false;
  }

  // ─────────────────────────────────────────────
  // Despacho
  // ─────────────────────────────────────────────

  async runOnce(): Promise<void> {
    if (this.stopped) {
      return;
    }

    if (this.ticking) {
      throw new Error("Scheduler ocupado.");
    }

    this.ticking = true;

    try {
      this.options.orchestrator.refreshReadyTasks();

      const tasks = this.options.orchestrator
        .listTasks()
        .filter((task) => task.status === "ready");

      for (const task of tasks) {
        if (this.stopped) {
          break;
        }

        if (
          this.active.size >= this.options.limits.maxConcurrency
        ) {
          break;
        }

        if (this.active.has(task.id)) {
          continue;
        }

        if (this.conflictsWithActive(task)) {
          continue;
        }

        // El runtime no debe recibir el rol reservado al orquestador.
        if (task.role === "orchestrator") {
          this.reportDenial(
            task.id,
            "ROLE_NOT_EXECUTABLE",
            "El rol orchestrator no puede ejecutarse como agente."
          );
          continue;
        }

        const decision = this.options.policy.evaluateTask(task);

        if (!decision.allowed) {
          this.reportDenial(
            task.id,
            "POLICY_DENIED",
            decision.reason
          );
          continue;
        }

        this.reportedDenials.delete(task.id);

        const controller = new AbortController();

        try {
          const started = this.options.orchestrator.startTask(task.id);

          /*
           * Registrar la ejecución antes de iniciar su trabajo
           * asíncrono evita despachos duplicados en este scheduler.
           */
          const execution = this.executeTask(started, controller);

          this.active.set(task.id, {
            controller,
            files: [...started.allowedFiles],
            execution
          });

          this.emit({
            type: "task-started",
            taskId: task.id,
            status: "running"
          });
        } catch (error) {
          this.emit({
            type: "task-error",
            taskId: task.id,
            message: this.errorMessage(error)
          });
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Espera a que las ejecuciones que ya terminaron sean retiradas
   * del registro activo. No se usa para bloquear stop().
   */
  async waitForIdle(): Promise<void> {
    while (this.active.size > 0) {
      const executions = [...this.active.values()].map(
        ({ execution }) => execution
      );

      await Promise.allSettled(executions);
    }
  }

  // ─────────────────────────────────────────────
  // Ejecución
  // ─────────────────────────────────────────────

  private async executeTask(
    task: Task,
    controller: AbortController
  ): Promise<void> {
    try {
      const contextPromise = Promise.resolve().then(() =>
        this.options.getContext?.(task) ?? []
      );

      const context = await this.withTimeout(
        contextPromise,
        this.options.limits.timeoutMs,
        controller
      );

      if (controller.signal.aborted) {
        throw this.getAbortReason(controller);
      }

      const input: AgentInput = {
        taskId: task.id,
        role: task.role as AgentInput["role"],
        objective: task.objective,
        context,
        allowedFiles: [...task.allowedFiles],
        executionMode: task.executionMode,
        acceptanceCriteria: [...task.acceptanceCriteria]
      };

      const runtimePromise = Promise.resolve().then(() =>
        this.options.runtime.execute(input, controller.signal)
      );

      const result = await this.withTimeout(
        runtimePromise,
        this.options.limits.timeoutMs,
        controller
      );

      if (controller.signal.aborted) {
        throw this.getAbortReason(controller);
      }

      if (result.taskId !== task.id) {
        throw new Error(
          "El runtime devolvió un taskId incorrecto."
        );
      }

      const recorded = this.options.orchestrator.recordAgentResult(
        task.id,
        result
      );

      if (recorded.task.status === "failed") {
        this.emit({
          type: "task-error",
          taskId: task.id,
          status: "failed",
          message:
            result.status === "error"
              ? result.error.message
              : "La tarea falló al registrar el resultado."
        });

        return;
      }

      if (recorded.task.status !== "verifying") {
        this.emit({
          type: "task-finished",
          taskId: task.id,
          status: recorded.task.status
        });

        return;
      }

      /*
       * evaluateTask no se envuelve en Promise.race:
       * su evaluación puede modificar el estado del orquestador
       * después de resolverse. Un timeout externo no cancelaría
       * esa modificación y podría dejar una transición tardía.
       *
       * El EvidenceEvaluator actual no recibe AbortSignal.
       */
      const verified = await this.options.orchestrator.evaluateTask(
        task.id
      );

      this.emit({
        type: "task-finished",
        taskId: task.id,
        status: verified.task.status
      });
    } catch (error) {
      const message = this.errorMessage(error);
      const current = this.options.orchestrator.getTask(task.id);

      if (
        controller.signal.aborted &&
        !(controller.signal.reason instanceof SchedulerTimeoutError)
      ) {
        if (
          current.status !== "completed" &&
          current.status !== "cancelled"
        ) {
          try {
            this.options.orchestrator.cancelTask(
              task.id,
              `Ejecución cancelada: ${message}`
            );
          } catch (cancelError) {
            this.emit({
              type: "task-error",
              taskId: task.id,
              message:
                `No se pudo cancelar la tarea: ` +
                this.errorMessage(cancelError)
            });
          }
        }

        this.emit({
          type: "task-error",
          taskId: task.id,
          status: this.options.orchestrator.getTask(task.id).status,
          message
        });

        return;
      }

      if (
        current.status === "running" ||
        current.status === "verifying"
      ) {
        try {
          this.options.orchestrator.failTask(
            task.id,
            message,
            {
              code:
                error instanceof SchedulerTimeoutError
                  ? "TASK_TIMEOUT"
                  : "EXECUTION_FAILED",
              message,
              retryable: true
            }
          );
        } catch (failureError) {
          this.emit({
            type: "task-error",
            taskId: task.id,
            message:
              `Error al registrar el fallo: ` +
              this.errorMessage(failureError)
          });
        }
      }

      this.emit({
        type: "task-error",
        taskId: task.id,
        status: this.options.orchestrator.getTask(task.id).status,
        message
      });
    } finally {
      this.active.delete(task.id);
    }
  }

  // ─────────────────────────────────────────────
  // Conflictos de archivos
  // ─────────────────────────────────────────────

  private conflictsWithActive(task: Task): boolean {
    const requested = task.allowedFiles.map((file) =>
      this.normalize(file)
    );

    for (const active of this.active.values()) {
      const running = active.files.map((file) =>
        this.normalize(file)
      );

      for (const a of requested) {
        for (const b of running) {
          if (this.pathsOverlap(a, b)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Detecta igualdad y relaciones padre/hijo entre rutas.
   * Esto normaliza rutas léxicamente; no resuelve enlaces
   * simbólicos ni sustituye las comprobaciones de KernelPolicy.
   */
  private pathsOverlap(a: string, b: string): boolean {
    return (
      a === b ||
      a.startsWith(`${b}/`) ||
      b.startsWith(`${a}/`)
    );
  }

  private normalize(file: string): string {
    const normalized = path.normalize(file);

    if (
      normalized === "." ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      path.isAbsolute(normalized)
    ) {
      return normalized;
    }

    return normalized.replace(/\/+$/, "");
  }

  // ─────────────────────────────────────────────
  // Timeout y cancelación
  // ─────────────────────────────────────────────

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    controller: AbortController
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new SchedulerTimeoutError(timeoutMs);

        if (!controller.signal.aborted) {
          controller.abort(error);
        }

        reject(error);
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        promise,
        timeoutPromise
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private getAbortReason(controller: AbortController): Error {
    const reason = controller.signal.reason;

    if (reason instanceof Error) {
      return reason;
    }

    return new Error(
      reason === undefined
        ? "Ejecución abortada."
        : String(reason)
    );
  }

  // ─────────────────────────────────────────────
  // Eventos y errores
  // ─────────────────────────────────────────────

  private reportDenial(
    taskId: string,
    code: string,
    message: string
  ): void {
    const signature = `${code}:${message}`;

    if (this.reportedDenials.get(taskId) === signature) {
      return;
    }

    this.reportedDenials.set(taskId, signature);

    this.emit({
      type: "task-error",
      taskId,
      status: "ready",
      message
    });
  }

  private emit(event: {
    type: "task-started" | "task-finished" | "task-error";
    taskId: string;
    status?: string;
    message?: string;
  }): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // Un callback de observabilidad no debe romper el scheduler.
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error
      ? error.message
      : String(error);
  }

  // ─────────────────────────────────────────────
  // Validación de configuración
  // ─────────────────────────────────────────────

  private validateLimits(limits: SchedulerLimits): void {
    if (
      !Number.isSafeInteger(limits.maxConcurrency) ||
      limits.maxConcurrency < 1
    ) {
      throw new Error(
        "maxConcurrency debe ser un entero positivo."
      );
    }

    if (
      !Number.isFinite(limits.timeoutMs) ||
      limits.timeoutMs <= 0
    ) {
      throw new Error(
        "timeoutMs debe ser un número positivo."
      );
    }
  }
}