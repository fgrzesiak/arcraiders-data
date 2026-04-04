#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_URL = "https://arctracker.io/api/map-events";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const targetPath = path.join(repoRoot, "map-events", "map-events.json");

async function run() {
  const response = await fetch(API_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${API_URL}: ${response.status} ${response.statusText}`
    );
  }

  const payload = await response.json();

  if (!Array.isArray(payload.fullRotation)) {
    throw new Error("API payload missing fullRotation array");
  }

  if (!payload.eventTypes || typeof payload.eventTypes !== "object") {
    throw new Error("API payload missing eventTypes object");
  }

  const existing = JSON.parse(await readFile(targetPath, "utf8"));

  const eventTypes = mergeEventTypes(existing.eventTypes, payload.eventTypes);
  const schedule = buildSchedule(payload.fullRotation, eventTypes);

  const nextData = {
    ...existing,
    eventTypes,
    schedule
  };

  await writeFile(targetPath, `${JSON.stringify(nextData, null, 2)}\n`);

  console.log(
    `Updated map-events.json with ${payload.fullRotation.length} schedule entries`
  );
}

function buildSchedule(fullRotation, eventTypes = {}) {
  const schedule = {};

  // Alle Maps aus der Rotation vorab anlegen
  for (const entry of fullRotation) {
    if (!entry?.maps || typeof entry.maps !== "object") continue;

    for (const mapId of Object.keys(entry.maps)) {
      if (!schedule[mapId]) {
        schedule[mapId] = { major: {}, minor: {} };
      }
    }
  }

  // displayName -> slug Lookup aus den API-eventTypes bauen
  const displayNameToSlug = new Map();

  for (const [slug, config] of Object.entries(eventTypes)) {
    const displayName =
      typeof config?.displayName === "string" ? config.displayName.trim() : "";

    if (displayName) {
      displayNameToSlug.set(normalizeName(displayName), slug);
    }
  }

  for (const entry of fullRotation) {
    const hour = entry?.hour;
    if (typeof hour !== "number") continue;

    const maps = entry?.maps;
    if (!maps || typeof maps !== "object") continue;

    for (const [mapId, mapEvents] of Object.entries(maps)) {
      if (!schedule[mapId]) {
        schedule[mapId] = { major: {}, minor: {} };
      }

      for (const tier of ["minor", "major"]) {
        const rawName = mapEvents?.[tier];
        const eventName =
          typeof rawName === "string" ? rawName.trim() : String(rawName ?? "");

        if (!eventName || eventName.toLowerCase() === "none") {
          continue;
        }

        const slug = resolveEventSlug(eventName, displayNameToSlug, eventTypes);

        if (!slug) {
          console.warn(
            `Skipping unknown event "${eventName}" for map "${mapId}" (${tier} @ ${hour})`
          );
          continue;
        }

        schedule[mapId][tier][String(hour)] = slug;
      }
    }
  }

  return schedule;
}

function resolveEventSlug(eventName, displayNameToSlug, eventTypes) {
  const normalized = normalizeName(eventName);

  // 1. sauber über displayName matchen
  const directMatch = displayNameToSlug.get(normalized);
  if (directMatch) {
    return directMatch;
  }

  // 2. fallback: alter slugify-Weg, falls lokal/remote doch klassisch ist
  const slugified = slugify(eventName);
  if (eventTypes[slugified]) {
    return slugified;
  }

  // 3. fallback: direkt als key vorhanden
  if (eventTypes[eventName]) {
    return eventName;
  }

  return null;
}

function mergeEventTypes(localEventTypes = {}, remoteEventTypes = {}) {
  const next = { ...localEventTypes };

  for (const [slug, remoteConfig] of Object.entries(remoteEventTypes)) {
    const localConfig = localEventTypes[slug] ?? {};

    next[slug] = {
      ...localConfig,
      ...remoteConfig,
      localizations:
        remoteConfig?.localizations &&
        typeof remoteConfig.localizations === "object"
          ? remoteConfig.localizations
          : localConfig.localizations ?? {}
    };
  }

  return next;
}

function normalizeName(name) {
  return String(name).trim().toLowerCase().replace(/\s+/g, " ");
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});