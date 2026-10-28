import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(
  projectRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js",
);

const child = spawn(
  process.execPath,
  [cliPath, "--mode", "rpc", "--no-session", "--approve"],
  {
    cwd: projectRoot,
    env: { ...process.env, PI_OFFLINE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  },
);

let stdout = "";
let stderr = "";
let timedOut = false;

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });

const timeout = setTimeout(() => {
  timedOut = true;
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
}, 20_000);

child.stdin.end(JSON.stringify({ id: "extension-smoke", type: "get_commands" }) + "\n");

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code) => resolve(code));
}).finally(() => clearTimeout(timeout));

assert.equal(timedOut, false, "Pi RPC startup timed out");
assert.equal(exitCode, 0, `Pi RPC exited with code ${exitCode}. stderr:\n${stderr}`);

const records = stdout
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Pi RPC emitted non-JSON stdout: ${line}\n${String(error)}\nstderr:\n${stderr}`);
    }
  });

const response = records.find((record) =>
  record.type === "response" && record.id === "extension-smoke",
);

assert.ok(response, `Pi RPC did not answer get_commands. stdout:\n${stdout}\nstderr:\n${stderr}`);
assert.equal(response.success, true, `Pi RPC get_commands failed: ${JSON.stringify(response)}`);

const commands = response.data?.commands ?? [];
const sidebar = commands.find((command) => command.name === "sidebar");

assert.ok(
  sidebar,
  `Expected the project-local .pi/extensions/events.ts command "sidebar" to be loaded by the real Pi runtime. Commands: ${commands.map((command) => command.name).join(", ")}. stderr:\n${stderr}`,
);
assert.equal(sidebar.source, "extension");

console.log("Pi RPC integration smoke test passed: project extension loaded and /sidebar registered.");
