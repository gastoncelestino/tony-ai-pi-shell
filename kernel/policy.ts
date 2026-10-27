import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import type { ExecutionMode, Task, TaskExecutionPolicy } from "./types.ts";

export type PolicyDecision = { allowed: true; reason: string } | { allowed: false; code: string; reason: string };

export class KernelPolicy {
  private constructor(
    private readonly projectRoot: string,
    private readonly config: TaskExecutionPolicy
  ) {}

  static async create(projectRoot: string, config: TaskExecutionPolicy): Promise<KernelPolicy> {
    const root = await realpath(projectRoot);
    const info = await stat(root);

    if (!info.isDirectory()) {
      throw new Error("projectRoot debe ser un directorio.");
    }

    return new KernelPolicy(root, config);
  }

  get rootPath(): string {
    return this.projectRoot;
  }

  authorizeTask(task: Task): string | undefined {
    const decision = this.evaluateTask(task);
    return decision.allowed ? undefined : decision.reason;
  }

  evaluateTask(task: Task): PolicyDecision {
    if (!task.id.trim() || !task.objective.trim()) {
      return this.deny("INVALID_TASK", "Faltan id u objective.");
    }

    if (!this.config.allowedRoles.includes(task.role)) {
      return this.deny("ROLE_NOT_ALLOWED", `Rol no autorizado: ${task.role}`);
    }

    if (!this.modeAllowed(task.executionMode)) {
      return this.deny("MODE_NOT_ALLOWED", `Modo de ejecución no autorizado: ${task.executionMode}`);
    }

    for (const file of task.allowedFiles) {
      if (!this.isSafeRelativePath(file)) {
        return this.deny("UNSAFE_PATH", `Ruta relativa insegura: ${file}`);
      }

      if (!this.isWithinConfiguredRoots(file)) {
        return this.deny("PATH_NOT_ALLOWED", `La ruta no está dentro de las raíces permitidas: ${file}`);
      }
    }

    return { allowed: true, reason: "Tarea autorizada." };
  }

  /**
   * Comprueba una ruta en el momento de la operación.
   * taskAllowedFiles debe ser el alcance concreto de la tarea.
   */
  async authorizePath(file: string, operation: "read" | "write", taskAllowedFiles: string[], taskMode: ExecutionMode): Promise<PolicyDecision> {
    if (!this.isSafeRelativePath(file)) {
      return this.deny("UNSAFE_PATH", `Ruta insegura: ${file}`);
    }

    if (operation === "write" && taskMode === "read-only") {
      return this.deny("READ_ONLY", "La tarea es de solo lectura.");
    }

    if (!this.modeAllowed(taskMode)) {
      return this.deny("MODE_NOT_ALLOWED", "El modo de la tarea excede la política.");
    }

    const inTaskScope = taskAllowedFiles.some((scope) => this.matchesScope(file, scope));

    if (!inTaskScope) {
      return this.deny("OUTSIDE_TASK_SCOPE", `La tarea no tiene alcance sobre ${file}.`);
    }

    if (!this.isWithinConfiguredRoots(file)) {
      return this.deny("PATH_NOT_ALLOWED", `La política no permite ${file}.`);
    }

    try {
      const resolved = await this.resolveAgainstProject(file);

      if (!this.isInsideRoot(resolved)) {
        return this.deny("SYMLINK_ESCAPE", "La ruta real sale del directorio del proyecto.");
      }

      for (const scope of taskAllowedFiles) {
        const resolvedScope = await this.resolveScope(scope);

        if (this.matchesResolvedScope(resolved, resolvedScope)) {
          return { allowed: true, reason: "Ruta validada dentro del alcance de la tarea." };
        }
      }

      return this.deny("RESOLVED_PATH_OUTSIDE_SCOPE", "La ruta real queda fuera del alcance de la tarea.");
    } catch (error) {
      return this.deny("PATH_RESOLUTION_FAILED", `No se pudo validar la ruta: ${this.errorMessage(error)}`);
    }
  }

  private modeAllowed(mode: ExecutionMode): boolean {
    if (mode === "read-only") return true;

    if (mode === "scoped-write") {
      return this.config.executionMode === "scoped-write" || this.config.executionMode === "isolated-write";
    }

    // isolated-write requiere soporte real de aislamiento del runtime.
    return this.config.executionMode === "isolated-write";
  }

  private isSafeRelativePath(file: string): boolean {
    if (!file.trim() || file.includes("\0") || file.includes("\\") || path.posix.isAbsolute(file) || path.win32.isAbsolute(file)) {
      return false;
    }

    const parts = file.split("/");
    return parts.every((part) => part !== ".." && part !== "");
  }

  private isWithinConfiguredRoots(file: string): boolean {
    return this.config.allowedFiles.some((root) => this.matchesScope(file, root));
  }

  private matchesScope(file: string, scope: string): boolean {
    if (!this.isSafeRelativePath(scope)) return false;

    const candidate = path.posix.normalize(file);
    const normalizedScope = path.posix.normalize(scope);

    return candidate === normalizedScope || candidate.startsWith(`${normalizedScope}/`);
  }

  private async resolveAgainstProject(file: string): Promise<string> {
    const absolute = path.resolve(this.projectRoot, file);

    if (!this.isInsideRoot(absolute)) {
      throw new Error("La ruta lexical sale del proyecto.");
    }

    // Si el archivo no existe, resolver el ancestro existente más cercano.
    let ancestor = absolute;
    const missing: string[] = [];

    while (true) {
      try {
        const realAncestor = await realpath(ancestor);
        return path.resolve(realAncestor, ...missing.reverse());
      } catch {
        const parent = path.dirname(ancestor);

        if (parent === ancestor) {
          throw new Error("No se pudo resolver un ancestro existente.");
        }

        missing.push(path.basename(ancestor));
        ancestor = parent;
      }
    }
  }

  private async resolveScope(scope: string): Promise<string> {
    return this.resolveAgainstProject(scope);
  }

  private matchesResolvedScope(resolvedFile: string, resolvedScope: string): boolean {
    const relative = path.relative(resolvedScope, resolvedFile);

    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  }

  private isInsideRoot(candidate: string): boolean {
    const relative = path.relative(this.projectRoot, candidate);

    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  }

  private deny(code: string, reason: string): PolicyDecision {
    return { allowed: false, code, reason };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
