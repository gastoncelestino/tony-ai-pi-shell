import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Orchestrator, OrchestratorError } from "../kernel/orchestrator.ts";
import { KernelPolicy } from "../kernel/policy.ts";
import { PiRuntime } from "../kernel/runtime.ts";

const limits = {
  maxConcurrency: 1,
  maxDepth: 4,
  maxTasks: 10,
  maxRetries: 1,
  maxIterations: 10,
  timeoutMs: 1_000,
};

function makeOrchestrator(evaluateEvidence = async (task) => ({
  accepted: true,
  taskId: task.id,
  checks: [{ name: "smoke", status: "passed", evidence: "assertion passed" }],
})) {
  return new Orchestrator({ limits, evaluateEvidence });
}

function taskInput(id, dependencies = [], allowedFiles = ["src/example.txt"]) {
  return {
    id,
    objective: `Test task ${id}`,
    role: "worker",
    dependencies,
    allowedFiles,
    executionMode: "scoped-write",
    acceptanceCriteria: ["The test passes"],
  };
}

function successfulResult(taskId) {
  return {
    taskId,
    status: "success",
    output: {
      taskId,
      summary: "Completed",
      changedFiles: [],
      checks: [],
      errors: [],
    },
  };
}

test("dependencies must complete before a dependent task becomes ready", async () => {
  const orchestrator = makeOrchestrator();
  orchestrator.createTask(taskInput("parent"));
  orchestrator.createTask(taskInput("child", ["parent"]));

  assert.deepEqual(
    orchestrator.refreshReadyTasks().map((task) => task.id),
    ["parent"],
  );
  assert.equal(orchestrator.getTask("child").status, "planned");

  orchestrator.startTask("parent");
  orchestrator.recordAgentResult("parent", successfulResult("parent"));
  assert.equal(orchestrator.getTask("parent").status, "verifying");
  await orchestrator.evaluateTask("parent");

  assert.equal(orchestrator.getTask("parent").status, "completed");
  assert.deepEqual(
    orchestrator.refreshReadyTasks().map((task) => task.id),
    ["child"],
  );
  assert.equal(orchestrator.getTask("child").status, "ready");
});

test("a successful agent result cannot bypass the Evidence Gate", async () => {
  const orchestrator = makeOrchestrator();
  orchestrator.createTask(taskInput("evidence"));
  orchestrator.refreshReadyTasks();
  orchestrator.startTask("evidence");
  orchestrator.recordAgentResult("evidence", successfulResult("evidence"));

  assert.equal(orchestrator.getTask("evidence").status, "verifying");
  await orchestrator.evaluateTask("evidence");
  assert.equal(orchestrator.getTask("evidence").status, "completed");
});

test("the Evidence Gate rejects an empty set of checks", async () => {
  const orchestrator = makeOrchestrator(async (task) => ({
    accepted: true,
    taskId: task.id,
    checks: [],
  }));
  orchestrator.createTask(taskInput("empty-evidence"));
  orchestrator.refreshReadyTasks();
  orchestrator.startTask("empty-evidence");
  orchestrator.recordAgentResult("empty-evidence", successfulResult("empty-evidence"));

  await assert.rejects(
    () => orchestrator.evaluateTask("empty-evidence"),
    (error) => error instanceof OrchestratorError && error.code === "EMPTY_EVIDENCE",
  );
  assert.equal(orchestrator.getTask("empty-evidence").status, "verifying");
});

test("runtime fails closed when no kernel task is active", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tony-kernel-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "example.txt"), "original", "utf8");
    const policy = await KernelPolicy.create(root, {
      allowedRoles: ["worker"],
      allowedFiles: ["src"],
      executionMode: "scoped-write",
      limits,
    });
    const runtime = new PiRuntime(policy, { getActiveTask: () => undefined });

    const read = await runtime.readText("src/example.txt");
    const write = await runtime.writeText("src/example.txt", "modified");
    assert.equal(read.ok, false);
    if (!read.ok) assert.equal(read.code, "NO_ACTIVE_TASK");
    assert.equal(write.ok, false);
    if (!write.ok) assert.equal(write.code, "NO_ACTIVE_TASK");
    assert.equal(await readFile(path.join(root, "src", "example.txt"), "utf8"), "original");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime enforces task file scope and refuses symlink escapes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tony-kernel-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "tony-outside-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "allowed.txt"), "original", "utf8");
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "src", "link.txt"));

    const policy = await KernelPolicy.create(root, {
      allowedRoles: ["worker"],
      allowedFiles: ["src"],
      executionMode: "scoped-write",
      limits,
    });
    const activeTask = {
      ...taskInput("scoped", [], ["src/allowed.txt"]),
      status: "running",
      attempts: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const runtime = new PiRuntime(policy, { getActiveTask: () => activeTask });

    const allowed = await runtime.writeText("src/allowed.txt", "updated");
    const outOfScope = await runtime.writeText("src/other.txt", "blocked");
    const symlinkEscape = await runtime.readText("src/link.txt");

    assert.equal(allowed.ok, true);
    assert.equal(await readFile(path.join(root, "src", "allowed.txt"), "utf8"), "updated");
    assert.equal(outOfScope.ok, false);
    if (!outOfScope.ok) assert.equal(outOfScope.code, "OUTSIDE_TASK_SCOPE");
    assert.equal(symlinkEscape.ok, false);
    assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "secret");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
