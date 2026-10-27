import path from "node:path";
import {
  lstat,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";

import type { KernelPolicy, PolicyDecision } from "./policy.ts";
import type { ExecutionMode, Task } from "./types.ts";

export interface ActiveTaskContext {
  getActiveTask(): Task | undefined;
}

export type RuntimeResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; error: string };

export class PiRuntime {
  constructor(
    private readonly policy: KernelPolicy,
    private readonly taskContext: ActiveTaskContext,
  ) {}

  async readText(file: string): Promise<RuntimeResult<string>> {
    const task = this.taskContext.getActiveTask();

    if (!task) {
      return this.fail(
        "NO_ACTIVE_TASK",
        "No hay una tarea activa autorizada por el kernel.",
      );
    }

    const decision = await this.policy.authorizePath(
      file,
      "read",
      task.allowedFiles,
      task.executionMode,
    );

    if (!decision.allowed) {
      return this.policyFailure(decision);
    }

    try {
      const absolutePath = await this.resolveSafePath(file);

      return {
        ok: true,
        value: await readFile(absolutePath, "utf8"),
      };
    } catch (error) {
      return this.fail("READ_FAILED", this.errorMessage(error));
    }
  }

  async writeText(
    file: string,
    content: string,
  ): Promise<RuntimeResult<void>> {
    const task = this.taskContext.getActiveTask();

    if (!task) {
      return this.fail(
        "NO_ACTIVE_TASK",
        "No hay una tarea activa autorizada por el kernel.",
      );
    }

    const decision = await this.policy.authorizePath(
      file,
      "write",
      task.allowedFiles,
      task.executionMode,
    );

    if (!decision.allowed) {
      return this.policyFailure(decision);
    }

    try {
      const absolutePath = await this.resolveSafePath(file);

      // No crear directorios implícitamente.
      // El directorio padre debe existir.
      await writeFile(absolutePath, content, {
        encoding: "utf8",
        flag: "w",
      });

      return { ok: true, value: undefined };
    } catch (error) {
      return this.fail("WRITE_FAILED", this.errorMessage(error));
    }
  }

  private async resolveSafePath(file: string): Promise<string> {
    if (
      !file.trim() ||
      file.includes("\0") ||
      file.includes("\\") ||
      path.posix.isAbsolute(file) ||
      path.win32.isAbsolute(file)
    ) {
      throw new Error("La ruta debe ser relativa y segura.");
    }

    const root = this.policy.rootPath;
    const absolutePath = path.resolve(root, file);
    const relativePath = path.relative(root, absolutePath);

    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error("La ruta sale de la raíz del proyecto.");
    }

    // Exigir que el archivo exista al leer o sobrescribir.
    // Esto evita crear archivos nuevos accidentalmente.
    const info = await lstat(absolutePath);

    if (info.isSymbolicLink()) {
      throw new Error("No se permiten enlaces simbólicos como destino.");
    }

    if (!info.isFile()) {
      throw new Error("La ruta debe apuntar a un archivo regular.");
    }

    const realRoot = await realpath(root);
    const realFile = await realpath(absolutePath);
    const realRelative = path.relative(realRoot, realFile);

    if (
      realRelative === ".." ||
      realRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelative)
    ) {
      throw new Error("La ruta real sale de la raíz del proyecto.");
    }

    return realFile;
  }

  private policyFailure(
    decision: Extract<PolicyDecision, { allowed: false }>,
  ): RuntimeResult<never> {
    return {
      ok: false,
      code: decision.code,
      error: decision.reason,
    };
  }

  private fail(
    code: string,
    error: string,
  ): RuntimeResult<never> {
    return { ok: false, code, error };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}