import { isAllowedTaskTransition, type AgentResult, type EvidenceGateResult, type SchedulerLimits, type Task, type TaskError, type TaskRecord, type TaskStatus } from "./types.ts";

export type EvidenceEvaluator = (task: Task, result: AgentResult) => Promise<EvidenceGateResult>;

export type OrchestratorOptions = {
  limits: SchedulerLimits;

  /**
   * Devuelve un mensaje si la tarea no está autorizada.
   * Devuelve undefined si está autorizada.
   */
  authorizeTask?: (task: Task) => string | undefined;

  /**
   * Evalúa evidencia verificable, no solo declaraciones del agente.
   */
  evaluateEvidence: EvidenceEvaluator;

  now?: () => number;
};

export type TaskTransition = {
  taskId: string;
  from: TaskStatus;
  to: TaskStatus;
  reason: string;
  timestamp: number;
};

export class OrchestratorError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = "OrchestratorError";
  }
}

export class Orchestrator {
  private readonly records = new Map<string, TaskRecord>();
  private readonly now: () => number;

  private activeCount = 0;
  private iterations = 0;

  constructor(private readonly options: OrchestratorOptions) {
    this.now = options.now ?? Date.now;
    this.validateLimits(options.limits);
  }

  // ─────────────────────────────────────────────
  // Consultas
  // ─────────────────────────────────────────────

  getTask(taskId: string): Task {
    return this.cloneTask(this.getRecordInternal(taskId).task);
  }

  getRecord(taskId: string): TaskRecord {
    return this.cloneRecord(this.getRecordInternal(taskId));
  }

  listTasks(): Task[] {
    return [...this.records.values()].map(({ task }) => this.cloneTask(task));
  }

  getActiveCount(): number {
    return this.activeCount;
  }

  getIterationCount(): number {
    return this.iterations;
  }

  // ─────────────────────────────────────────────
  // Creación
  // ─────────────────────────────────────────────

  createTask(input: Omit<Task, "status" | "attempts" | "createdAt" | "updatedAt">): Task {
    if (this.records.has(input.id)) {
      throw new OrchestratorError(
        `La tarea '${input.id}' ya existe.`,
        "DUPLICATE_TASK"
      );
    }

    if (this.records.size >= this.options.limits.maxTasks) {
      throw new OrchestratorError(
        "Se alcanzó el límite máximo de tareas.",
        "MAX_TASKS"
      );
    }

    if (!input.id.trim() || !input.objective.trim()) {
      throw new OrchestratorError(
        "La tarea requiere id y objective.",
        "INVALID_TASK"
      );
    }

    if (input.dependencies.includes(input.id)) {
      throw new OrchestratorError(
        "Una tarea no puede depender de sí misma.",
        "SELF_DEPENDENCY"
      );
    }

    for (const dependencyId of input.dependencies) {
      if (!this.records.has(dependencyId)) {
        throw new OrchestratorError(
          `La dependencia '${dependencyId}' no existe.`,
          "UNKNOWN_DEPENDENCY"
        );
      }
    }

    let depth = 0;

    if (input.parentTaskId) {
      if (input.parentTaskId === input.id) {
        throw new OrchestratorError(
          "Una tarea no puede ser su propio padre.",
          "SELF_PARENT"
        );
      }

      if (!this.records.has(input.parentTaskId)) {
        throw new OrchestratorError(
          `El padre '${input.parentTaskId}' no existe.`,
          "UNKNOWN_PARENT"
        );
      }

      depth = this.getTaskDepth(input.parentTaskId) + 1;
    }

    if (depth > this.options.limits.maxDepth) {
      throw new OrchestratorError(
        `La profundidad ${depth} supera maxDepth (${this.options.limits.maxDepth}).`,
        "MAX_DEPTH"
      );
    }

    const timestamp = this.now();

    const task: Task = {
      ...input,
      dependencies: [...input.dependencies],
      allowedFiles: [...input.allowedFiles],
      acceptanceCriteria: [...input.acceptanceCriteria],
      status: "planned",
      attempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    this.records.set(task.id, {
      task,
      transitions: []
    });

    return this.cloneTask(task);
  }

  // ─────────────────────────────────────────────
  // Preparación y autorización
  // ─────────────────────────────────────────────

  /**
   * Habilita únicamente las tareas planned cuyas dependencias
   * finalizaron correctamente y que están autorizadas.
   *
   * Las tareas blocked requieren una reactivación explícita.
   * Este método no ejecuta agentes.
   */
  refreshReadyTasks(): Task[] {
    const ready: Task[] = [];

    for (const record of this.records.values()) {
      const task = record.task;

      if (task.status !== "planned") {
        continue;
      }

      const dependenciesCompleted = task.dependencies.every(
        (id) => this.records.get(id)?.task.status === "completed"
      );

      if (!dependenciesCompleted) {
        continue;
      }

      const denial = this.options.authorizeTask?.(this.cloneTask(task));

      if (denial) {
        this.applyTransition(task.id, "blocked", denial);
        continue;
      }

      ready.push(
        this.applyTransition(
          task.id,
          "ready",
          "Dependencias completadas y política validada."
        )
      );
    }

    return ready;
  }

  /**
   * Autoriza el inicio de una tarea.
   * El scheduler debe llamar a este método antes de invocar al runtime.
   */
  startTask(taskId: string): Task {
    const task = this.getRecordInternal(taskId).task;

    if (task.status !== "ready") {
      throw new OrchestratorError(
        "Solo se pueden iniciar tareas ready.",
        "TASK_NOT_READY"
      );
    }

    if (this.activeCount >= this.options.limits.maxConcurrency) {
      throw new OrchestratorError(
        "Se alcanzó maxConcurrency.",
        "MAX_CONCURRENCY"
      );
    }

    if (this.iterations >= this.options.limits.maxIterations) {
      throw new OrchestratorError(
        "Se alcanzó maxIterations.",
        "MAX_ITERATIONS"
      );
    }

    if (task.attempts >= 1 + this.options.limits.maxRetries) {
      throw new OrchestratorError(
        "Se alcanzó maxRetries.",
        "MAX_RETRIES"
      );
    }

    this.assertDependenciesCompleted(task);

    const denial = this.options.authorizeTask?.(this.cloneTask(task));

    if (denial) {
      this.applyTransition(taskId, "blocked", denial);

      throw new OrchestratorError(
        denial,
        "TASK_NOT_AUTHORIZED"
      );
    }

    return this.applyTransition(
      taskId,
      "running",
      "Scheduler autorizado para ejecutar la tarea."
    );
  }

  // ─────────────────────────────────────────────
  // Resultados del runtime
  // ─────────────────────────────────────────────

  /**
   * Un resultado exitoso pasa a verifying, nunca directamente
   * a completed. Los errores del runtime se registran como failed.
   */
  recordAgentResult(taskId: string, result: AgentResult): TaskRecord {
    const record = this.getRecordInternal(taskId);

    if (record.task.status !== "running") {
      throw new OrchestratorError(
        "La tarea no está running.",
        "TASK_NOT_RUNNING"
      );
    }

    if (result.taskId !== taskId) {
      throw new OrchestratorError(
        "El taskId del resultado no coincide.",
        "TASK_ID_MISMATCH"
      );
    }

    if (result.status === "success" && result.output.taskId !== taskId) {
      throw new OrchestratorError(
        "El taskId del output no coincide.",
        "OUTPUT_TASK_ID_MISMATCH"
      );
    }

    if (
      result.status === "error" &&
      result.partialOutput &&
      result.partialOutput.taskId !== taskId
    ) {
      throw new OrchestratorError(
        "El taskId del resultado parcial no coincide.",
        "PARTIAL_OUTPUT_TASK_ID_MISMATCH"
      );
    }

    record.result = this.cloneResult(result);

    if (result.status === "error") {
      this.applyTransition(
        taskId,
        "failed",
        `Error del runtime: ${result.error.message}`
      );

      this.blockDependents(taskId);

      return this.cloneRecord(record);
    }

    this.applyTransition(
      taskId,
      "verifying",
      "Resultado recibido; pendiente de verificación."
    );

    return this.cloneRecord(record);
  }

  // ─────────────────────────────────────────────
  // Evidence Gate
  // ─────────────────────────────────────────────

  async evaluateTask(taskId: string): Promise<TaskRecord> {
    const record = this.getRecordInternal(taskId);

    if (
      record.task.status !== "verifying" ||
      !record.result ||
      record.result.status !== "success"
    ) {
      throw new OrchestratorError(
        "La tarea debe estar verifying y tener un resultado exitoso.",
        "TASK_NOT_VERIFYING"
      );
    }

    const gate = await this.options.evaluateEvidence(
      this.cloneTask(record.task),
      this.cloneResult(record.result)
    );

    if (gate.taskId !== taskId) {
      throw new OrchestratorError(
        "El taskId del Evidence Gate no coincide.",
        "EVIDENCE_TASK_ID_MISMATCH"
      );
    }

    if (!Array.isArray(gate.checks)) {
      throw new OrchestratorError(
        "Evidence Gate devolvió una lista de checks inválida.",
        "INVALID_EVIDENCE_CHECKS"
      );
    }

    if (gate.accepted) {
      if (gate.checks.length === 0) {
        throw new OrchestratorError(
          "Evidence Gate no puede aprobar sin checks verificables.",
          "EMPTY_EVIDENCE"
        );
      }

      const failedChecks = gate.checks.filter(
        (check) => check.status === "failed"
      );

      if (failedChecks.length > 0) {
        throw new OrchestratorError(
          "Evidence Gate contradictorio: hay checks fallidos.",
          "CONTRADICTORY_EVIDENCE"
        );
      }

      const incompleteChecks = gate.checks.filter(
        (check) => check.status !== "passed"
      );

      if (incompleteChecks.length > 0) {
        throw new OrchestratorError(
          "Evidence Gate no puede aprobar si hay checks omitidos o no aprobados.",
          "INCOMPLETE_EVIDENCE"
        );
      }

      this.applyTransition(
        taskId,
        "completed",
        "Evidence Gate aprobado."
      );

      return this.cloneRecord(record);
    }

    const retriesUsed = Math.max(0, record.task.attempts - 1);

    const canRetry =
      gate.retryable &&
      retriesUsed < this.options.limits.maxRetries &&
      this.iterations < this.options.limits.maxIterations;

    if (canRetry) {
      this.applyTransition(
        taskId,
        "ready",
        `Evidence Gate requiere correcciones: ${gate.reason}`
      );
    } else {
      this.applyTransition(
        taskId,
        "failed",
        `Evidence Gate rechazó la tarea: ${gate.reason}`
      );

      this.blockDependents(taskId);
    }

    return this.cloneRecord(record);
  }

  // ─────────────────────────────────────────────
  // Cancelación y reintentos
  // ─────────────────────────────────────────────

  cancelTask(taskId: string, reason: string): Task {
    const task = this.getRecordInternal(taskId).task;

    if (task.status === "completed" || task.status === "cancelled") {
      throw new OrchestratorError(
        `No se puede cancelar una tarea ${task.status}.`,
        "TERMINAL_TASK"
      );
    }

    const cancelled = this.applyTransition(
      taskId,
      "cancelled",
      reason
    );

    this.blockDependents(taskId);

    return cancelled;
  }

  retryFailedTask(taskId: string, reason: string): Task {
    const record = this.getRecordInternal(taskId);
    const task = record.task;

    if (task.status !== "failed") {
      throw new OrchestratorError(
        "Solo se pueden reintentar tareas failed.",
        "TASK_NOT_FAILED"
      );
    }

    // Los errores explícitamente no reintentables bloquean el reintento manual.
    if (
      record.result?.status === "error" &&
      !record.result.error.retryable
    ) {
      throw new OrchestratorError(
        "El error de la tarea no admite reintentos.",
        "NON_RETRYABLE_ERROR"
      );
    }

    if (task.attempts >= 1 + this.options.limits.maxRetries) {
      throw new OrchestratorError(
        "Se alcanzó maxRetries.",
        "MAX_RETRIES"
      );
    }

    if (this.iterations >= this.options.limits.maxIterations) {
      throw new OrchestratorError(
        "Se alcanzó maxIterations.",
        "MAX_ITERATIONS"
      );
    }

    this.assertDependenciesCompleted(task);

    record.result = undefined;

    return this.applyTransition(taskId, "planned", reason);
  }

  /**
   * Registra un fallo del runtime, del scheduler o del proceso
   * de verificación. Permite clasificar el error para los reintentos.
   */
  failTask(
    taskId: string,
    reason: string,
    error: Partial<TaskError> = {}
  ): TaskRecord {
    const record = this.getRecordInternal(taskId);
    const status = record.task.status;

    if (status === "failed") {
      return this.cloneRecord(record);
    }

    if (status !== "running" && status !== "verifying") {
      throw new OrchestratorError(
        `No se puede marcar como fallida una tarea ${status}.`,
        "TASK_NOT_FAILABLE"
      );
    }

    if (!reason.trim()) {
      throw new OrchestratorError(
        "Toda falla requiere un motivo.",
        "MISSING_REASON"
      );
    }

    record.result = {
      taskId,
      status: "error",
      error: {
        code: error.code ?? "EXECUTION_FAILED",
        message: error.message ?? reason,
        retryable: error.retryable ?? true
      }
    };

    this.applyTransition(taskId, "failed", reason);
    this.blockDependents(taskId);

    return this.cloneRecord(record);
  }

  // ─────────────────────────────────────────────
  // Máquina de estados privada
  // ─────────────────────────────────────────────

  private applyTransition(
    taskId: string,
    to: TaskStatus,
    reason: string
  ): Task {
    const record = this.getRecordInternal(taskId);
    const task = record.task;
    const from = task.status;

    if (!reason.trim()) {
      throw new OrchestratorError(
        "Toda transición requiere un motivo.",
        "MISSING_REASON"
      );
    }

    if (!isAllowedTaskTransition(from, to)) {
      throw new OrchestratorError(
        `Transición inválida: ${from} -> ${to}.`,
        "INVALID_TRANSITION"
      );
    }

    if (to === "completed") {
      if (
        from !== "verifying" ||
        !record.result ||
        record.result.status !== "success"
      ) {
        throw new OrchestratorError(
          "No se puede completar sin un resultado exitoso verificado.",
          "EVIDENCE_GATE_REQUIRED"
        );
      }
    }

    if (to === "ready") {
      this.assertDependenciesCompleted(task);
    }

    if (from === "running") {
      this.activeCount = Math.max(0, this.activeCount - 1);
    }

    task.status = to;
    task.updatedAt = this.now();

    if (to === "running") {
      task.attempts += 1;
      this.iterations += 1;
      this.activeCount += 1;
    }

    record.transitions.push({
      taskId,
      from,
      to,
      reason,
      timestamp: this.now()
    });

    return this.cloneTask(task);
  }

  private blockDependents(taskId: string): void {
    const queue = [taskId];
    const visited = new Set(queue);

    while (queue.length > 0) {
      const dependencyId = queue.shift()!;

      for (const { task } of this.records.values()) {
        if (
          !task.dependencies.includes(dependencyId) ||
          visited.has(task.id)
        ) {
          continue;
        }

        visited.add(task.id);

        if (task.status === "planned" || task.status === "ready") {
          this.applyTransition(
            task.id,
            "blocked",
            `Dependencia '${dependencyId}' no completada.`
          );
        }

        queue.push(task.id);
      }
    }
  }

  private assertDependenciesCompleted(task: Task): void {
    const incomplete = task.dependencies.filter(
      (id) => this.records.get(id)?.task.status !== "completed"
    );

    if (incomplete.length > 0) {
      throw new OrchestratorError(
        `Dependencias incompletas: ${incomplete.join(", ")}`,
        "DEPENDENCIES_NOT_COMPLETED"
      );
    }
  }

  private getRecordInternal(taskId: string): TaskRecord {
    const record = this.records.get(taskId);

    if (!record) {
      throw new OrchestratorError(
        `No existe la tarea '${taskId}'.`,
        "TASK_NOT_FOUND"
      );
    }

    return record;
  }

  private validateLimits(limits: SchedulerLimits): void {
    const integerLimits = [
      "maxConcurrency",
      "maxDepth",
      "maxTasks",
      "maxRetries",
      "maxIterations"
    ] as const;

    for (const name of integerLimits) {
      const value = limits[name];

      if (!Number.isSafeInteger(value) || value < 0) {
        throw new OrchestratorError(
          `Límite inválido: ${name}. Debe ser un entero no negativo.`,
          "INVALID_LIMIT"
        );
      }
    }

    if (!Number.isFinite(limits.timeoutMs) || limits.timeoutMs <= 0) {
      throw new OrchestratorError(
        "timeoutMs debe ser un número positivo.",
        "INVALID_LIMIT"
      );
    }

    if (
      limits.maxConcurrency < 1 ||
      limits.maxTasks < 1 ||
      limits.maxIterations < 1
    ) {
      throw new OrchestratorError(
        "maxConcurrency, maxTasks y maxIterations deben ser >= 1.",
        "INVALID_LIMIT"
      );
    }
  }

  private cloneTask(task: Task): Task {
    return {
      ...task,
      dependencies: [...task.dependencies],
      allowedFiles: [...task.allowedFiles],
      acceptanceCriteria: [...task.acceptanceCriteria]
    };
  }

  private cloneResult(result: AgentResult): AgentResult {
    if (result.status === "success") {
      return {
        taskId: result.taskId,
        status: "success",
        output: {
          ...result.output,
          changedFiles: [...result.output.changedFiles],
          checks: result.output.checks.map((check) => ({ ...check })),
          errors: result.output.errors.map((error) => ({ ...error }))
        }
      };
    }

    return {
      ...result,
      error: { ...result.error },
      partialOutput: result.partialOutput
        ? {
            ...result.partialOutput,
            changedFiles: [...result.partialOutput.changedFiles],
            checks: result.partialOutput.checks.map((check) => ({ ...check })),
            errors: result.partialOutput.errors.map((error) => ({ ...error }))
          }
        : undefined
    };
  }

  private cloneRecord(record: TaskRecord): TaskRecord {
    return {
      task: this.cloneTask(record.task),
      transitions: record.transitions.map((transition) => ({ ...transition })),
      result: record.result ? this.cloneResult(record.result) : undefined
    };
  }

  private getTaskDepth(taskId: string): number {
    let depth = 0;
    let currentId: string | undefined = taskId;
    const visited = new Set<string>();

    while (currentId) {
      if (visited.has(currentId)) {
        throw new OrchestratorError(
          `Se detectó un ciclo en la jerarquía de tareas: '${currentId}'.`,
          "TASK_HIERARCHY_CYCLE"
        );
      }

      visited.add(currentId);

      const record = this.records.get(currentId);

      if (!record) {
        throw new OrchestratorError(
          `No existe la tarea '${currentId}'.`,
          "UNKNOWN_PARENT"
        );
      }

      currentId = record.task.parentTaskId;

      if (currentId) {
        depth += 1;
      }
    }

    return depth;
  }
}