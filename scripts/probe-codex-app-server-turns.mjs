#!/usr/bin/env node
/**
 * Real Codex app-server contract probe.
 *
 * This intentionally does not import YA provider/supervisor code. It speaks the
 * same JSON-RPC-over-stdio protocol YA uses, but isolates beliefs about Codex
 * turn/start, turn/steer, and turn/interrupt from YA integration behavior.
 *
 * Usage:
 *   node scripts/probe-codex-app-server-turns.mjs
 *   CODEX_PROBE_MODEL=gpt-5.4-mini node scripts/probe-codex-app-server-turns.mjs
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CODEX = process.env.CODEX_PROBE_CODEX_BIN || "codex";
const MODEL = process.env.CODEX_PROBE_MODEL || "gpt-5.4-mini";
const EFFORT = process.env.CODEX_PROBE_EFFORT || "low";
const REQUEST_TIMEOUT_MS = Number(process.env.CODEX_PROBE_TIMEOUT_MS || 15000);
const INTERRUPT_DELAY_MS = Number(
  process.env.CODEX_PROBE_INTERRUPT_DELAY_MS || 1200,
);

const cwd = mkdtempSync(join(tmpdir(), "ya-codex-turn-probe-"));
writeFileSync(
  join(cwd, "README.md"),
  "Temporary Codex app-server probe workspace. Do not modify.\n",
  "utf-8",
);

let nextId = 1;
const pending = new Map();
const notifications = [];
let stdoutBuffer = "";
let stderrBuffer = "";

const child = spawn(CODEX, ["app-server", "--listen", "stdio://"], {
  cwd,
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

function log(event, value) {
  console.log(`${event}: ${JSON.stringify(value, null, 2)}`);
}

function sendRaw(payload) {
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
  const id = nextId++;
  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
  });
  sendRaw({ jsonrpc: "2.0", id, method, params });
  return promise;
}

function notify(method, params) {
  sendRaw(
    params === undefined
      ? { jsonrpc: "2.0", method }
      : { jsonrpc: "2.0", method, params },
  );
}

function handleLine(line) {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.id !== undefined && !message.method) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) {
      const error = new Error(message.error.message || "JSON-RPC error");
      error.data = message.error.data;
      waiter.reject(error);
    } else {
      waiter.resolve(message.result);
    }
    return;
  }

  if (message.method && message.id !== undefined) {
    sendRaw({
      jsonrpc: "2.0",
      id: message.id,
      result: defaultServerRequestResponse(message.method),
    });
    return;
  }

  if (message.method) {
    notifications.push(message);
  }
}

function defaultServerRequestResponse(method) {
  const lower = method.toLowerCase();
  if (lower.includes("requestapproval")) {
    return { decision: "decline" };
  }
  if (lower.includes("toolrequest") || lower.includes("requestuserinput")) {
    return { answer: { type: "text", text: "Interrupt probe: no input." } };
  }
  return {};
}

function waitForNotification(predicate, timeoutMs = REQUEST_TIMEOUT_MS) {
  const existing = notifications.find(predicate);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      const notification = notifications.find(predicate);
      if (notification) {
        clearInterval(interval);
        resolve(notification);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(interval);
        reject(new Error("Timed out waiting for matching notification"));
      }
    }, 25);
  });
}

child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString("utf-8");
  const lines = stdoutBuffer.split("\n");
  stdoutBuffer = lines.pop() || "";
  for (const line of lines) handleLine(line);
});

child.stderr.on("data", (chunk) => {
  stderrBuffer += chunk.toString("utf-8");
});

child.on("exit", (code, signal) => {
  for (const [id, waiter] of pending) {
    pending.delete(id);
    waiter.reject(new Error(`codex exited code=${code} signal=${signal}`));
  }
});

try {
  const initialize = await request("initialize", {
    clientInfo: { name: "ya_codex_turn_probe", title: null, version: "dev" },
    capabilities: { experimentalApi: true },
  });
  log("initialize", initialize);
  notify("initialized");

  let model = MODEL;
  try {
    const modelList = await request("model/list", {});
    const models = Array.isArray(modelList?.models) ? modelList.models : [];
    const ids = models
      .map((entry) => entry?.id)
      .filter((id) => typeof id === "string");
    if (!ids.includes(model)) {
      const fallback =
        ids.find((id) => /mini|spark|fast|small/i.test(id)) ?? ids[0];
      if (fallback) model = fallback;
    }
    log("model/list-summary", { requested: MODEL, selected: model, ids });
  } catch (error) {
    log("model/list-error", { message: error.message });
  }

  const threadStart = await request("thread/start", {
    cwd,
    model,
    config: { model_reasoning_effort: EFFORT },
    approvalPolicy: "on-request",
    sandbox: "read-only",
    experimentalRawEvents: true,
    persistExtendedHistory: false,
  });
  const threadId = threadStart?.thread?.id;
  log("thread/start", {
    threadId,
    model: threadStart?.model,
    reasoningEffort: threadStart?.reasoningEffort,
  });
  if (!threadId) throw new Error("thread/start did not return thread.id");

  const turnStart = await request("turn/start", {
    threadId,
    model,
    effort: EFFORT,
    summary: "auto",
    input: [
      {
        type: "text",
        text:
          "Probe turn. Do not modify files. Think quietly for a few seconds, " +
          "then answer with the exact sentence: PROBE COMPLETE.",
        text_elements: [],
      },
    ],
  });
  const startedTurnId = turnStart?.turn?.id;
  log("turn/start", {
    turnId: startedTurnId,
    status: turnStart?.turn?.status,
  });
  if (!startedTurnId) throw new Error("turn/start did not return turn.id");

  await waitForNotification(
    (message) =>
      message.method === "turn/started" ||
      (message.method === "item/started" &&
        message.params?.turnId === startedTurnId),
    REQUEST_TIMEOUT_MS,
  ).catch(() => undefined);

  const steer = await request("turn/steer", {
    threadId,
    expectedTurnId: startedTurnId,
    input: [
      {
        type: "text",
        text: "Steer probe: keep the answer short.",
        text_elements: [],
      },
    ],
  });
  log("turn/steer", steer);

  const interruptTurnId =
    typeof steer?.turnId === "string" ? steer.turnId : startedTurnId;
  await new Promise((resolve) => setTimeout(resolve, INTERRUPT_DELAY_MS));
  const interrupt = await request("turn/interrupt", {
    threadId,
    turnId: interruptTurnId,
  });
  log("turn/interrupt", { paramsTurnId: interruptTurnId, result: interrupt });

  const completed = await waitForNotification(
    (message) =>
      message.method === "turn/completed" &&
      message.params?.turn?.id === interruptTurnId,
    REQUEST_TIMEOUT_MS * 2,
  );
  log("turn/completed", {
    turnId: completed.params?.turn?.id,
    status: completed.params?.turn?.status,
    error: completed.params?.turn?.error,
  });

  log("notification-methods", notifications.map((message) => message.method));
} catch (error) {
  log("probe-error", {
    message: error instanceof Error ? error.message : String(error),
    data: error?.data,
    stderr: stderrBuffer.slice(-2000),
  });
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  rmSync(cwd, { recursive: true, force: true });
}
