/**
 * Contratos canónicos de Tony Ai Harness.
 *
 * Este archivo contiene tipos y políticas independientes del proveedor de IA.
 * Los tipos TypeScript no validan datos externos en runtime: las salidas del
 * modelo deben validarse antes de aceptarlas o ejecutar acciones.
 */

export type TaskStatus =
  | "planned"
  | "ready"
  | "running"
  | "verifying"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";

export type AgentRole =
  | "orchestrator"
  | "explore"
  | "worker"
  | "verify"
  | "review";

export type ExecutionMode =
  | "read-only"
  | "scoped-write"
  | "isolated-write";

export type CheckStatus = "passed" | "failed" | "skipped";

export type TaskError = {
  code: string;
  message: string;
  retryable: boolean;
};

export type CheckResult = {
  name: string;
  status: CheckStatus;
  /** Evidencia verificable, por ejemplo un comando ejecutado y su resultado. */
  evidence?: string;
};

export type Task = {
  id: string;
  parentTaskId?: string;
  objective: string;
  status: TaskStatus;
  role: AgentRole;
  dependencies: string[];
  /** Archivos que esta tarea puede leer o modificar, según executionMode. */
  allowedFiles: string[];
  executionMode: ExecutionMode;
  acceptanceCriteria: string[];
  attempts: number;
  createdAt: number;
  updatedAt: number;
};

export type TaskTransition = {
  taskId: string;
  from: TaskStatus;
  to: TaskStatus;
  reason: string;
  timestamp: number;
};

export type AgentInput = {
  taskId: string;
  role: Exclude<AgentRole, "orchestrator">;
  objective: string;
  context: string[];
  allowedFiles: string[];
  executionMode: ExecutionMode;
  acceptanceCriteria: string[];
};

export type AgentOutput = {
  taskId: string;
  summary: string;
  changedFiles: string[];
  checks: CheckResult[];
  errors: TaskError[];
};

/**
 * Unión discriminada: un resultado exitoso debe contener output; un error,
 * error. Un fallo puede conservar una salida parcial validable.
 */
export type AgentResult =
  | {
      taskId: string;
      status: "success";
      output: AgentOutput;
    }
  | {
      taskId: string;
      status: "error";
      error: TaskError;
      partialOutput?: AgentOutput;
    };

export type TaskRecord = {
  task: Task;
  transitions: TaskTransition[];
  result?: AgentResult;
};

export type SchedulerLimits = {
  maxConcurrency: number;
  maxDepth: number;
  maxTasks: number;
  maxRetries: number;
  maxIterations: number;
  timeoutMs: number;
};

export type TaskExecutionPolicy = {
  allowedRoles: AgentRole[];
  /** Lista global permitida; el alcance efectivo también debe respetar Task.allowedFiles. */
  allowedFiles: string[];
  executionMode: ExecutionMode;
  limits: SchedulerLimits;
};

/** Una propuesta del modelo no es una autorización ejecutable. */
export type ModelProposal<T> = {
  taskId: string;
  data: T;
};

/** Decisión creada por el kernel, nunca por el modelo. */
export type KernelDecision =
  | {
      allowed: true;
      decisionId: string;
      taskId: string;
    }
  | {
      allowed: false;
      taskId: string;
      reason: string;
    };

/** Operación que el runtime solo puede ejecutar tras validar la decisión. */
export type AuthorizedOperation<T> = {
  taskId: string;
  decisionId: string;
  operation: T;
};

export type EvidenceGateResult =
  | {
      accepted: true;
      taskId: string;
      checks: CheckResult[];
    }
  | {
      accepted: false;
      taskId: string;
      reason: string;
      checks: CheckResult[];
      retryable: boolean;
    };

/** Contrato neutral del ejecutor: no presupone OpenAI, Qwen ni otro proveedor. */
export interface AgentRuntime {
  execute(input: AgentInput, signal?: AbortSignal): Promise<AgentResult>;
}

/**
 * Grafo de transiciones permitidas. La existencia de una transición en este
 * mapa no la autoriza por sí sola: el kernel también valida dependencias,
 * permisos, límites y motivo de la transición.
 */
export const ALLOWED_TASK_TRANSITIONS: Readonly<
  Record<TaskStatus, readonly TaskStatus[]>
> = {
  planned: ["ready", "blocked", "cancelled"],
  ready: ["running", "blocked", "cancelled"],
  running: ["verifying", "failed", "blocked", "cancelled"],
  verifying: ["completed", "ready", "failed", "blocked", "cancelled"],
  blocked: ["planned", "ready", "cancelled"],
  failed: ["planned", "cancelled"],
  completed: [],
  cancelled: [],
};

export function isAllowedTaskTransition(
  from: TaskStatus,
  to: TaskStatus,
): boolean {
  return ALLOWED_TASK_TRANSITIONS[from].includes(to);
}
