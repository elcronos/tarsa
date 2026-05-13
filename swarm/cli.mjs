#!/usr/bin/env node
// swarm — pipeline runner for swarm.yaml
// Reads swarm.yaml from cwd, runs pipelines, spawns `claude` per task.
// Hot-reloads swarm.yaml between iterations.
// Robust to claude hangs / missing finish events.

import { readFileSync, mkdirSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";

const CWD = process.cwd();
const YAML_PATH = resolve(CWD, "swarm.yaml");
const OUTPUT_ROOT = resolve(CWD, "swarm/output");

const args = process.argv.slice(2);
const pipelineName = args[0] ?? "main";
const HANG_TIMEOUT_MS = Number(process.env.SWARM_HANG_TIMEOUT_MS ?? 30 * 60 * 1000); // 30 min
const IDLE_TIMEOUT_MS = Number(process.env.SWARM_IDLE_TIMEOUT_MS ?? 5 * 60 * 1000); // 5 min no output

function loadConfig() {
  if (!existsSync(YAML_PATH)) {
    console.error(`swarm: no swarm.yaml at ${YAML_PATH}`);
    process.exit(1);
  }
  const raw = readFileSync(YAML_PATH, "utf8");
  return parseYaml(raw);
}

function tsSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function runClaudeTask(taskName, prompt, iterIdx) {
  return new Promise((resolveP) => {
    const runId = `${tsSlug()}__iter${iterIdx}__${taskName}`;
    const dir = join(OUTPUT_ROOT, runId);
    mkdirSync(dir, { recursive: true });

    const jsonlPath = join(dir, "stream.jsonl");
    const textPath = join(dir, "human.txt");
    const cfgPath = join(dir, "config.json");
    const errPath = join(dir, "stderr.log");

    const claudeArgs = [
      "--system-prompt",
      "You are an expert coding assistant operating inside Claude Code, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
      "--dangerously-skip-permissions",
      "--model",
      "opus",
      "--effort",
      "high",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
    ];

    writeFileSync(
      cfgPath,
      JSON.stringify(
        { taskName, iterIdx, prompt, claudeArgs, cwd: CWD, startedAt: new Date().toISOString() },
        null,
        2,
      ),
    );

    console.log(`\n[swarm] iter=${iterIdx} task=${taskName} → ${dir}`);

    const child = spawn("claude", claudeArgs, {
      cwd: CWD,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    child.stdin.write(prompt);
    child.stdin.end();

    let lastOutputAt = Date.now();
    let sawFinish = false;
    let killed = false;

    const idleCheck = setInterval(() => {
      const idle = Date.now() - lastOutputAt;
      if (idle > IDLE_TIMEOUT_MS && !killed) {
        console.error(`[swarm] task=${taskName} idle ${(idle / 1000).toFixed(0)}s → killing`);
        killed = true;
        child.kill("SIGKILL");
      }
    }, 15_000);

    const hangTimer = setTimeout(() => {
      if (!killed) {
        console.error(`[swarm] task=${taskName} hard timeout → killing`);
        killed = true;
        child.kill("SIGKILL");
      }
    }, HANG_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      lastOutputAt = Date.now();
      const text = chunk.toString();
      appendFileSync(jsonlPath, text);
      // Try to extract human-readable bits from stream-json
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "assistant" && ev.message?.content) {
            for (const block of ev.message.content) {
              if (block.type === "text") {
                appendFileSync(textPath, block.text + "\n");
              }
            }
          }
          if (ev.type === "result") sawFinish = true;
        } catch {
          // Not valid JSON line — ignore
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      lastOutputAt = Date.now();
      appendFileSync(errPath, chunk.toString());
    });

    child.on("close", (code) => {
      clearInterval(idleCheck);
      clearTimeout(hangTimer);
      const status = killed ? "killed" : sawFinish ? "ok" : "no_finish_event";
      appendFileSync(
        cfgPath.replace("config.json", "result.json"),
        JSON.stringify({ exitCode: code, status, finishedAt: new Date().toISOString() }, null, 2),
      );
      console.log(`[swarm] iter=${iterIdx} task=${taskName} done (${status}, exit=${code})`);
      resolveP({ status, exitCode: code });
    });

    child.on("error", (err) => {
      clearInterval(idleCheck);
      clearTimeout(hangTimer);
      console.error(`[swarm] task=${taskName} spawn error: ${err.message}`);
      resolveP({ status: "spawn_error", exitCode: -1 });
    });
  });
}

async function runPipeline() {
  let cfg = loadConfig();
  const pipeline = cfg.pipelines?.[pipelineName];
  if (!pipeline) {
    console.error(`swarm: no pipeline "${pipelineName}" in swarm.yaml`);
    process.exit(1);
  }

  const iterations = pipeline.iterations ?? 1;
  const parallelism = pipeline.parallelism ?? 1;
  const taskNames = pipeline.tasks ?? [];

  console.log(`swarm: pipeline=${pipelineName} iters=${iterations} parallelism=${parallelism}`);

  for (let i = 1; i <= iterations; i++) {
    // Hot reload yaml every iteration
    try {
      cfg = loadConfig();
    } catch (err) {
      console.error(`[swarm] yaml reload failed: ${err.message} — using last good config`);
    }

    for (const taskName of taskNames) {
      const task = cfg.tasks?.[taskName];
      if (!task) {
        console.error(`[swarm] unknown task "${taskName}" — skip`);
        continue;
      }
      const prompt = task["prompt-string"] ?? task.prompt ?? "";
      if (parallelism <= 1) {
        await runClaudeTask(taskName, prompt, i);
      } else {
        const fleet = Array.from({ length: parallelism }, () => runClaudeTask(taskName, prompt, i));
        await Promise.all(fleet);
      }
    }
  }
}

runPipeline().catch((err) => {
  console.error("[swarm] fatal:", err);
  process.exit(2);
});
