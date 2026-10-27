import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import harnessExtension, { setKernelActiveTask } from "../.pi/extensions/harness.ts";
import kernelExtension from "../.pi/extensions/kernel.ts";
import eventsExtension from "../.pi/extensions/events.ts";
import { createKernelRuntime } from "../.pi/extensions/harness.ts";
import { KernelPolicy } from "../kernel/policy.ts";

const limits = {
  maxConcurrency: 1,
  maxDepth: 4,
  maxTasks: 10,
  maxRetries: 1,
  maxIterations: 10,
  timeoutMs: 1_000,
};

test("harness registers real tools and fails closed without an active task", async () => {
  const registered = new Map();
  const pi = {
    registerTool(tool) {
      registered.set(tool.name, tool);
    },
  };

  setKernelActiveTask(undefined);
  harnessExtension(pi);

  assert.deepEqual([...registered.keys()].sort(), [
    "kernel_read_file",
    "kernel_write_file",
  ]);

  let result;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    result = await registered.get("kernel_read_file").execute("call-1", {
      path: "package.json",
    });
    if (!String(result.content?.[0]?.text).includes("inicializándose")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /NO_ACTIVE_TASK/);
});

test("harness permits a scoped write only while the kernel task is active", async () => {
  const root = await mkdtemp(path.join(process.cwd(), "tests", ".pi-harness-"));
  try {
    const relativeRoot = path.relative(process.cwd(), root).split(path.sep).join("/");
    await mkdir(path.join(root, "src"));
    const file = path.join(root, "src", "fixture.txt");
    await writeFile(file, "before", "utf8");
    const relativeFile = `${relativeRoot}/src/fixture.txt`;

    const registered = new Map();
    harnessExtension({
      registerTool(tool) {
        registered.set(tool.name, tool);
      },
    });

    const task = {
      id: "pi-extension-write",
      objective: "Update the fixture through the registered kernel tool",
      status: "running",
      role: "worker",
      dependencies: [],
      allowedFiles: [relativeFile],
      executionMode: "scoped-write",
      acceptanceCriteria: ["The fixture contains after"],
      attempts: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    setKernelActiveTask(task);

    let result;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      result = await registered.get("kernel_write_file").execute("call-2", {
        path: relativeFile,
        content: "after",
      });
      if (!String(result.content?.[0]?.text).includes("inicializándose")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(result.isError, false, result.content?.[0]?.text);
    assert.equal(await readFile(file, "utf8"), "after");

    setKernelActiveTask(undefined);
    const denied = await registered.get("kernel_write_file").execute("call-3", {
      path: relativeFile,
      content: "must-not-write",
    });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /NO_ACTIVE_TASK/);
    assert.equal(await readFile(file, "utf8"), "after");
  } finally {
    setKernelActiveTask(undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("the configured project-root policy accepts safe relative paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tony-root-scope-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "fixture.txt"), "x", "utf8");
    const policy = await KernelPolicy.create(root, {
      allowedRoles: ["worker"],
      allowedFiles: ["."],
      executionMode: "scoped-write",
      limits,
    });
    const task = {
      id: "root-scope",
      objective: "Check project-root scope",
      status: "ready",
      role: "worker",
      dependencies: [],
      allowedFiles: ["src/fixture.txt"],
      executionMode: "scoped-write",
      acceptanceCriteria: ["Allowed"],
      attempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    assert.equal(policy.evaluateTask(task).allowed, true);
    const decision = await policy.authorizePath(
      "src/fixture.txt",
      "read",
      task.allowedFiles,
      task.executionMode,
    );
    assert.equal(decision.allowed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("all project extensions register hooks and tools through the Pi extension API", () => {
  const hooks = new Map();
  const commands = new Map();
  const tools = new Map();
  const pi = {
    on(name, handler) { hooks.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { tools.set(tool.name, tool); },
  };

  kernelExtension(pi);
  eventsExtension(pi);
  harnessExtension(pi);

  for (const hook of [
    "session_start", "before_agent_start", "tool_call", "session_shutdown",
    "agent_start", "agent_end", "input", "model_select", "turn_end",
  ]) {
    assert.equal(typeof hooks.get(hook), "function", `missing hook: ${hook}`);
  }
  assert.equal(typeof commands.get("sidebar")?.handler, "function");
  assert.ok(tools.has("kernel_read_file"));
  assert.ok(tools.has("kernel_write_file"));
});
