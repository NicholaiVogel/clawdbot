import fs from "node:fs";

import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadClawdbotPlugins } from "../plugins/loader.js";
import { resolveUserPath } from "../utils.js";
import { findDuplicateAgentDirs, formatDuplicateAgentDirError } from "./agent-dirs.js";
import { applyModelDefaults, applySessionDefaults } from "./defaults.js";
import { findLegacyConfigIssues } from "./legacy.js";
import type { ClawdbotConfig, ConfigValidationIssue } from "./types.js";
import { ClawdbotSchema } from "./zod-schema.js";

export function validateConfigObject(
  raw: unknown,
): { ok: true; config: ClawdbotConfig } | { ok: false; issues: ConfigValidationIssue[] } {
  const legacyIssues = findLegacyConfigIssues(raw);
  if (legacyIssues.length > 0) {
    return {
      ok: false,
      issues: legacyIssues.map((iss) => ({
        path: iss.path,
        message: iss.message,
      })),
    };
  }
  const validated = ClawdbotSchema.safeParse(raw);
  if (!validated.success) {
    return {
      ok: false,
      issues: validated.error.issues.map((iss) => ({
        path: iss.path.join("."),
        message: iss.message,
      })),
    };
  }
  const duplicates = findDuplicateAgentDirs(validated.data as ClawdbotConfig);
  if (duplicates.length > 0) {
    return {
      ok: false,
      issues: [
        {
          path: "agents.list",
          message: formatDuplicateAgentDirError(duplicates),
        },
      ],
    };
  }
  return {
    ok: true,
    config: applyModelDefaults(applySessionDefaults(validated.data as ClawdbotConfig)),
  };
}

export function validateConfigObjectWithPlugins(
  raw: unknown,
): { ok: true; config: ClawdbotConfig } | { ok: false; issues: ConfigValidationIssue[] } {
  const base = validateConfigObject(raw);
  if (!base.ok) return base;

  const config = base.config;
  const issues: ConfigValidationIssue[] = [];
  const pluginsConfig = config.plugins;

  const loadPaths = pluginsConfig?.load?.paths ?? [];
  for (const loadPath of loadPaths) {
    if (typeof loadPath !== "string") continue;
    const trimmed = loadPath.trim();
    if (!trimmed) continue;
    const resolved = resolveUserPath(trimmed);
    if (!fs.existsSync(resolved)) {
      issues.push({
        path: "plugins.load.paths",
        message: `plugin path not found: ${resolved}`,
      });
    }
  }

  const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  const registry = loadClawdbotPlugins({
    config,
    workspaceDir: workspaceDir ?? undefined,
    cache: false,
    mode: "validate",
  });

  const knownIds = new Set(registry.plugins.map((record) => record.id));
  const entries = pluginsConfig?.entries ?? {};
  if (entries && typeof entries === "object" && !Array.isArray(entries)) {
    for (const pluginId of Object.keys(entries)) {
      if (!knownIds.has(pluginId)) {
        issues.push({
          path: `plugins.entries.${pluginId}`,
          message: `plugin not found: ${pluginId}`,
        });
      }
    }
  }

  const allow = pluginsConfig?.allow ?? [];
  for (const pluginId of allow) {
    if (typeof pluginId !== "string" || !pluginId.trim()) continue;
    if (!knownIds.has(pluginId)) {
      issues.push({
        path: "plugins.allow",
        message: `plugin not found: ${pluginId}`,
      });
    }
  }

  const deny = pluginsConfig?.deny ?? [];
  for (const pluginId of deny) {
    if (typeof pluginId !== "string" || !pluginId.trim()) continue;
    if (!knownIds.has(pluginId)) {
      issues.push({
        path: "plugins.deny",
        message: `plugin not found: ${pluginId}`,
      });
    }
  }

  const memorySlot = pluginsConfig?.slots?.memory;
  if (typeof memorySlot === "string" && memorySlot.trim() && !knownIds.has(memorySlot)) {
    issues.push({
      path: "plugins.slots.memory",
      message: `plugin not found: ${memorySlot}`,
    });
  }

  for (const diag of registry.diagnostics) {
    if (diag.level !== "error") continue;
    const path = diag.pluginId ? `plugins.entries.${diag.pluginId}` : "plugins";
    const pluginLabel = diag.pluginId ? `plugin ${diag.pluginId}` : "plugin";
    issues.push({
      path,
      message: `${pluginLabel}: ${diag.message}`,
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return base;
}
