#!/usr/bin/env node
/**
 * Generate logo SVG variations via Replicate (recraft-20b-svg).
 * Usage: REPLICATE_API_TOKEN=xxx node scripts/gen-logo.mjs
 * Output: frontend/src/assets/logo-v{1..5}.svg
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN = process.env.REPLICATE_API_TOKEN;
if (!TOKEN) {
  console.error("Missing REPLICATE_API_TOKEN");
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = `${__dirname}/../frontend/src/assets`;

const PROMPTS = [
  {
    id: "v1-lens-dag",
    prompt:
      "minimalist logo, magnifying glass with a small directed acyclic graph of 3 connected dots inside the lens, single line weight, monochrome teal, transparent background, vector icon",
  },
  {
    id: "v2-eye-brackets",
    prompt:
      "minimalist logo, geometric eye composed of nested square brackets containing a single horizontal node-graph, two-color palette teal and warm amber, flat vector style, transparent background",
  },
  {
    id: "v3-brackets-flow",
    prompt:
      "minimalist tech logo, two square brackets with a small dotted flow line passing between them ending in a circle, single weight strokes, teal accent, vector icon, transparent background",
  },
  {
    id: "v4-terminal-frame",
    prompt:
      "minimalist developer tool logo, rounded square frame with a notched top-right corner and three small dots in a triangle inside, monochrome with one teal accent dot, flat vector, transparent background",
  },
  {
    id: "v5-dag-l",
    prompt:
      "minimalist logo, abstract directed acyclic graph forming the letter L, three connected nodes, geometric sans, single line weight, two-color teal and dark navy, flat vector, transparent background",
  },
];

const MODEL = "recraft-ai/recraft-20b-svg";

async function getLatestVersion(model) {
  const r = await fetch(`https://api.replicate.com/v1/models/${model}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!r.ok) throw new Error(`Model lookup failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  return data.latest_version.id;
}

async function generate(version, prompt) {
  const create = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Prefer: "wait",
    },
    body: JSON.stringify({
      version,
      input: { prompt, size: "1024x1024", style: "vector_illustration" },
    }),
  });
  if (!create.ok) throw new Error(`Predict failed: ${create.status} ${await create.text()}`);
  const pred = await create.json();

  let final = pred;
  while (final.status !== "succeeded" && final.status !== "failed" && final.status !== "canceled") {
    await new Promise((r) => setTimeout(r, 1500));
    const poll = await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    final = await poll.json();
  }
  if (final.status !== "succeeded") throw new Error(`Failed: ${JSON.stringify(final.error)}`);

  const url = Array.isArray(final.output) ? final.output[0] : final.output;
  const svg = await fetch(url).then((r) => r.text());
  return svg;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const version = await getLatestVersion(MODEL);
  console.log(`Model version: ${version}`);

  for (const { id, prompt } of PROMPTS) {
    process.stdout.write(`Generating ${id}... `);
    try {
      const svg = await generate(version, prompt);
      const path = `${OUT_DIR}/logo-${id}.svg`;
      await writeFile(path, svg);
      console.log(`saved → ${path}`);
    } catch (e) {
      console.log(`failed: ${e.message}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
