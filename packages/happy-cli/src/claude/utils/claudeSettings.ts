/**
 * Utilities for reading Claude's settings.json configuration
 * 
 * Handles reading Claude's settings.json file to respect user preferences
 * like includeCoAuthoredBy setting for commit message generation.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '@/ui/logger';

export interface ClaudeSettings {
  includeCoAuthoredBy?: boolean;
  [key: string]: any;
}

/**
 * Get the path to Claude's settings.json file
 */
function getClaudeSettingsPath(): string {
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(claudeConfigDir, 'settings.json');
}

/**
 * Read Claude's settings.json file from the default location
 * 
 * @returns Claude settings object or null if file doesn't exist or can't be read
 */
export function readClaudeSettings(): ClaudeSettings | null {
  try {
    const settingsPath = getClaudeSettingsPath();
    
    if (!existsSync(settingsPath)) {
      logger.debug(`[ClaudeSettings] No Claude settings file found at ${settingsPath}`);
      return null;
    }
    
    const settingsContent = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(settingsContent) as ClaudeSettings;
    
    logger.debug(`[ClaudeSettings] Successfully read Claude settings from ${settingsPath}`);
    logger.debug(`[ClaudeSettings] includeCoAuthoredBy: ${settings.includeCoAuthoredBy}`);
    
    return settings;
  } catch (error) {
    logger.debug(`[ClaudeSettings] Error reading Claude settings: ${error}`);
    return null;
  }
}

/**
 * Check if Co-Authored-By lines should be included in commit messages
 * based on Claude's settings
 * 
 * @returns true if Co-Authored-By should be included, false otherwise
 */
export function shouldIncludeCoAuthoredBy(): boolean {
  const settings = readClaudeSettings();
  
  // If no settings file or includeCoAuthoredBy is not explicitly set,
  // default to true to maintain backward compatibility
  if (!settings || settings.includeCoAuthoredBy === undefined) {
    return true;
  }
  
  return settings.includeCoAuthoredBy;
}

/**
 * Environment variables that can configure model tiers in Claude's settings.json.
 * Order: default first, then specific tiers, then subagent.
 */
const MODEL_ENV_VARS = [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
] as const;

/**
 * Extract model configuration from Claude's settings.json.
 *
 * Reads the `env` field and collects all model-related environment
 * variables (ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL, etc.),
 * deduplicates them, and returns the unique list.
 *
 * @returns Unique model names and the current model (ANTHROPIC_MODEL or first).
 */
export function extractModelsFromSettings(): { models: string[]; currentModel: string | null } {
    const settings = readClaudeSettings();
    if (!settings?.env || typeof settings.env !== 'object') {
        return { models: [], currentModel: null };
    }
    const env = settings.env as Record<string, unknown>;
    const configuredModels: string[] = [];
    for (const key of MODEL_ENV_VARS) {
        const value = env[key];
        if (typeof value === 'string' && value.length > 0) {
            configuredModels.push(value);
        }
    }
    const uniqueModels = [...new Set(configuredModels)];
    const currentModel =
        typeof env.ANTHROPIC_MODEL === 'string' && env.ANTHROPIC_MODEL.length > 0
            ? (env.ANTHROPIC_MODEL as string)
            : (uniqueModels[0] ?? null);
    return { models: uniqueModels, currentModel };
}