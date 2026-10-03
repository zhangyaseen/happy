/**
 * Generate temporary settings file with Claude hooks for session tracking
 *
 * Creates a settings.json file that configures Claude's SessionStart hook
 * to notify our HTTP server when sessions change (new session, resume, compact, etc).
 *
 * This implementation merges user settings from ~/.claude/settings.json with
 * Happy's hooks configuration, ensuring that user configurations (env vars,
 * permissions, model settings, etc.) are preserved while adding Happy's
 * session tracking hooks.
 */

import { join, resolve } from 'node:path';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { projectPath } from '@/projectPath';
import { readClaudeSettings, type ClaudeSettings } from './claudeSettings';

/**
 * Deep merge two settings objects.
 *
 * Merges user settings with Happy hooks configuration:
 * - Top-level fields: override replaces base
 * - hooks field: arrays are merged (base first, override second)
 * - Other nested objects: shallow copy
 *
 * @param base - Base settings (user settings from ~/.claude/settings.json)
 * @param override - Override settings (Happy hooks configuration)
 * @returns Merged settings object (new object, does not mutate inputs)
 */
function deepMergeSettings(
    base: ClaudeSettings,
    override: Partial<ClaudeSettings>
): ClaudeSettings {
    // Start with a shallow copy of base
    const result: ClaudeSettings = { ...base };

    // Merge each field from override
    for (const key in override) {
        if (key === 'hooks' && base.hooks && override.hooks) {
            // Special handling for hooks: merge arrays
            result.hooks = { ...base.hooks };

            for (const hookEvent in override.hooks) {
                const eventKey = hookEvent as keyof typeof override.hooks;

                if (base.hooks[eventKey] && override.hooks[eventKey]) {
                    // Both have this event: merge arrays
                    result.hooks[eventKey] = [
                        ...base.hooks[eventKey]!,
                        ...override.hooks[eventKey]!
                    ];
                } else if (override.hooks[eventKey]) {
                    // Only override has this event
                    result.hooks[eventKey] = override.hooks[eventKey];
                }
                // else: only base has this event, already in result.hooks
            }
        } else {
            // For all other fields: override replaces base
            result[key] = override[key] as any;
        }
    }

    return result;
}

/**
 * Generate a temporary settings file with SessionStart hook configuration
 *
 * This function:
 * 1. Reads user settings from ~/.claude/settings.json
 * 2. Generates Happy's SessionStart hook configuration
 * 3. Deep merges user settings with Happy hooks
 * 4. Writes the merged configuration to a temporary file
 *
 * @param port - The port where Happy server is listening
 * @returns Path to the generated settings file
 */
export function generateHookSettingsFile(port: number): string {
    const hooksDir = join(configuration.happyHomeDir, 'tmp', 'hooks');
    mkdirSync(hooksDir, { recursive: true });

    // Unique filename per process to avoid conflicts
    const filename = `session-hook-${process.pid}.json`;
    const filepath = join(hooksDir, filename);

    // Path to the hook forwarder script
    const forwarderScript = resolve(projectPath(), 'scripts', 'session_hook_forwarder.cjs');
    const hookCommand = `node "${forwarderScript}" ${port}`;

    // 1. Read user settings from ~/.claude/settings.json
    const userSettings = readClaudeSettings();
    if (userSettings) {
        logger.debug(`[generateHookSettings] User settings loaded: ${Object.keys(userSettings).join(', ')}`);
        if (userSettings.env) {
            logger.debug(`[generateHookSettings] User env vars: ${Object.keys(userSettings.env).join(', ')}`);
        }
    } else {
        logger.debug('[generateHookSettings] No user settings found, using empty config');
    }

    // 2. Generate Happy hooks configuration
    const happyHooks: Partial<ClaudeSettings> = {
        hooks: {
            SessionStart: [
                {
                    matcher: "*",
                    hooks: [
                        {
                            type: "command",
                            command: hookCommand
                        }
                    ]
                }
            ]
        }
    };

    // 3. Merge user settings with Happy hooks
    const mergedSettings = userSettings
        ? deepMergeSettings(userSettings, happyHooks)
        : happyHooks;

    logger.debug(`[generateHookSettings] Merged settings keys: ${Object.keys(mergedSettings).join(', ')}`);

    // 4. Write merged settings to temporary file
    try {
        writeFileSync(filepath, JSON.stringify(mergedSettings, null, 2));
        logger.debug(`[generateHookSettings] Created merged settings file: ${filepath}`);
    } catch (error) {
        logger.warn(`[generateHookSettings] Failed to write merged settings file: ${error}`);
        // Fallback: write only Happy hooks
        writeFileSync(filepath, JSON.stringify(happyHooks, null, 2));
        logger.warn('[generateHookSettings] Fallback: wrote only Happy hooks');
    }

    return filepath;
}

/**
 * Clean up the temporary hook settings file
 *
 * @param filepath - Path to the settings file to remove
 */
export function cleanupHookSettingsFile(filepath: string): void {
    try {
        if (existsSync(filepath)) {
            unlinkSync(filepath);
            logger.debug(`[generateHookSettings] Cleaned up hook settings file: ${filepath}`);
        }
    } catch (error) {
        logger.debug(`[generateHookSettings] Failed to cleanup hook settings file: ${error}`);
    }
}
