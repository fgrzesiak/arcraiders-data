#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_URL = "https://arctracker.io/api/projects";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const targetPath = path.join(repoRoot, "projects.json");

async function run() {
  const response = await fetch(API_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${API_URL}: ${response.status} ${response.statusText}`
    );
  }

  const payload = await response.json();

  if (!payload.projects || typeof payload.projects !== "object") {
    throw new Error("API payload missing projects object");
  }

  const existing = JSON.parse(await readFile(targetPath, "utf8"));
  if (!Array.isArray(existing)) {
    throw new Error("projects.json is expected to contain an array");
  }

  const indexById = new Map(
    existing.map((project, index) => [project.id, index])
  );

  let updated = 0;
  let added = 0;
  const next = [...existing];

  for (const [id, remoteProject] of Object.entries(payload.projects)) {
    const index = indexById.get(id);

    if (index === undefined) {
      // Neues Projekt, das lokal noch nicht existiert
      next.push(remoteProject);
      indexById.set(id, next.length - 1);
      added += 1;
      continue;
    }

    const localProject = next[index];
    const merged = { ...localProject, ...remoteProject };

    if (JSON.stringify(merged) !== JSON.stringify(localProject)) {
      next[index] = merged;
      updated += 1;
    }
  }

  // Projects the API no longer lists are past seasonal projects. Keep them
  // (history, existing pages) but make sure they are marked as disabled.
  // Nothing is deleted here, so only guard against an empty API response.
  if (Object.keys(payload.projects).length === 0) {
    throw new Error(
      "API returned no projects; refusing to disable all of them"
    );
  }
  let disabled = 0;
  for (let i = 0; i < next.length; i += 1) {
    const project = next[i];
    if (!project?.id || project.id in payload.projects) continue;
    if (project.disabled !== true) {
      next[i] = { ...project, disabled: true };
      disabled += 1;
    }
  }

  if (updated === 0 && added === 0 && disabled === 0) {
    console.log("No project changes detected");
    return;
  }

  await writeFile(targetPath, `${JSON.stringify(next, null, 2)}\n`);

  console.log(
    `Updated projects.json: ${updated} project(s) changed, ${added} project(s) added, ${disabled} project(s) disabled`
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
