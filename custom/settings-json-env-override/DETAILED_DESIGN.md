# 详细设计文档：settings.json 配置合并实现

> **状态**: 待实施
> **日期**: 2026-10-03
> **关联**: [SUMMARY_DESIGN.md](./SUMMARY_DESIGN.md) · [TECHNICAL_ANALYSIS.md](./TECHNICAL_ANALYSIS.md) · [PRD.md](./PRD.md)

---

## 1. 实现概述

### 1.1 修改范围

**只修改 1 个文件**：
- `packages/happy-cli/src/claude/utils/generateHookSettings.ts`

**新增函数**：
- `deepMergeSettings()` — 深合并配置

**修改函数**：
- `generateHookSettingsFile()` — 读取用户配置并合并

### 1.2 实施步骤

1. 在 `generateHookSettings.ts` 中导入 `readClaudeSettings`
2. 实现 `deepMergeSettings()` 函数
3. 修改 `generateHookSettingsFile()` 函数
4. 添加调试日志
5. 测试验证

---

## 2. 详细实现

### 2.1 文件：`generateHookSettings.ts`

#### 2.1.1 新增导入

**位置**: 文件顶部，现有导入之后

```typescript
// 现有导入
import { join, resolve } from 'node:path';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { projectPath } from '@/projectPath';

// 新增导入
import { readClaudeSettings, type ClaudeSettings } from './claudeSettings';
```

**说明**: 
- 导入 `readClaudeSettings` 函数
- 导入 `ClaudeSettings` 类型（如果 claudeSettings.ts 导出了该类型）

#### 2.1.2 新增函数：`deepMergeSettings()`

**位置**: `generateHookSettingsFile()` 函数之前

```typescript
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
 * 
 * @example
 * ```typescript
 * const userSettings = {
 *   env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000" },
 *   hooks: {
 *     SessionStart: [{ matcher: "*.ts", hooks: [...] }]
 *   }
 * };
 * 
 * const happyHooks = {
 *   hooks: {
 *     SessionStart: [{ matcher: "*", hooks: [...] }]
 *   }
 * };
 * 
 * const merged = deepMergeSettings(userSettings, happyHooks);
 * // Result:
 * // {
 * //   env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000" },
 * //   hooks: {
 * //     SessionStart: [
 * //       { matcher: "*.ts", hooks: [...] },  // user hook
 * //       { matcher: "*", hooks: [...] }       // Happy hook
 * //     ]
 * //   }
 * // }
 * ```
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
```

**实现细节**:

1. **浅拷贝 base**: 使用 `{ ...base }` 创建新对象，不修改原对象
2. **特殊处理 hooks**: 
   - 检查 `key === 'hooks'` 且两者都有 hooks 字段
   - 创建 hooks 的浅拷贝：`{ ...base.hooks }`
   - 遍历 override.hooks 的每个事件（SessionStart, SessionEnd 等）
   - 如果两者都有同一事件：合并数组（base 在前，override 在后）
   - 如果只有 override 有：直接赋值
   - 如果只有 base 有：已经在 result.hooks 中
3. **其他字段**: override 直接替换 base
4. **类型安全**: 使用 TypeScript 类型注解确保类型正确

#### 2.1.3 修改函数：`generateHookSettingsFile()`

**位置**: 替换现有实现

**修改前**（当前代码）:
```typescript
export function generateHookSettingsFile(port: number): string {
    const hooksDir = join(configuration.happyHomeDir, 'tmp', 'hooks');
    mkdirSync(hooksDir, { recursive: true });

    const filename = `session-hook-${process.pid}.json`;
    const filepath = join(hooksDir, filename);

    const forwarderScript = resolve(projectPath(), 'scripts', 'session_hook_forwarder.cjs');
    const hookCommand = `node "${forwarderScript}" ${port}`;

    const settings = {
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

    writeFileSync(filepath, JSON.stringify(settings, null, 2));
    logger.debug(`[generateHookSettings] Created hook setting file: ${filepath}`);

    return filepath;
}
```

**修改后**（新实现）:
```typescript
export function generateHookSettingsFile(port: number): string {
    const hooksDir = join(configuration.happyHomeDir, 'tmp', 'hooks');
    mkdirSync(hooksDir, { recursive: true });

    const filename = `session-hook-${process.pid}.json`;
    const filepath = join(hooksDir, filename);

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
        logger.error('[generateHookSettings] Failed to write merged settings file:', error);
        // Fallback: write only Happy hooks
        writeFileSync(filepath, JSON.stringify(happyHooks, null, 2));
        logger.warn('[generateHookSettings] Fallback: wrote only Happy hooks');
    }

    return filepath;
}
```

**修改说明**:

1. **读取用户配置**（新增）:
   - 调用 `readClaudeSettings()` 读取 `~/.claude/settings.json`
   - 记录调试日志：用户配置的字段名、env 变量名
   - 如果没有用户配置，使用空对象

2. **生成 Happy hooks**（修改）:
   - 将 `settings` 重命名为 `happyHooks`
   - 添加类型注解：`Partial<ClaudeSettings>`

3. **合并配置**（新增）:
   - 如果有用户配置：调用 `deepMergeSettings(userSettings, happyHooks)`
   - 如果没有用户配置：直接使用 `happyHooks`

4. **写入文件**（修改）:
   - 添加 try-catch 错误处理
   - 写入失败时降级：只写入 Happy hooks
   - 记录详细的调试日志

5. **日志增强**（新增）:
   - 记录用户配置的字段
   - 记录用户 env 变量
   - 记录合并后的配置字段
   - 记录错误和降级信息

---

## 3. 类型定义

### 3.1 ClaudeSettings 类型

**位置**: `packages/happy-cli/src/claude/utils/claudeSettings.ts`

**需要添加**（如果尚未定义）:

```typescript
export interface ClaudeSettings {
    // Environment variables
    env?: Record<string, string>;
    
    // Permissions configuration
    permissions?: {
        allow?: string[];
        deny?: string[];
        defaultMode?: 'auto' | 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    };
    
    // Model-specific settings
    modelSettings?: Record<string, {
        effortLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    }>;
    
    // Hooks configuration
    hooks?: {
        SessionStart?: HookEvent[];
        SessionEnd?: HookEvent[];
        PreToolUse?: HookEvent[];
        PostToolUse?: HookEvent[];
        [key: string]: HookEvent[] | undefined;
    };
    
    // Other settings
    includeCoAuthoredBy?: boolean;
    [key: string]: any;
}

export interface HookEvent {
    matcher: string;
    hooks: Array<{
        type: 'command';
        command: string;
    }>;
}
```

**说明**: 
- 如果 `claudeSettings.ts` 已经导出了 `ClaudeSettings` 类型，直接使用
- 如果没有，需要添加上述类型定义

---

## 4. 错误处理

### 4.1 配置读取失败

**场景**: `~/.claude/settings.json` 不存在或格式错误

**处理**:
```typescript
const userSettings = readClaudeSettings();
if (!userSettings) {
    logger.debug('[generateHookSettings] No user settings found, using empty config');
    // userSettings 为 null，后续使用 happyHooks 作为 mergedSettings
}
```

**行为**: 降级为空配置，继续生成只包含 Happy hooks 的临时文件。

### 4.2 配置写入失败

**场景**: 临时文件写入失败（磁盘空间不足、权限问题等）

**处理**:
```typescript
try {
    writeFileSync(filepath, JSON.stringify(mergedSettings, null, 2));
    logger.debug(`[generateHookSettings] Created merged settings file: ${filepath}`);
} catch (error) {
    logger.error('[generateHookSettings] Failed to write merged settings file:', error);
    // Fallback: write only Happy hooks
    writeFileSync(filepath, JSON.stringify(happyHooks, null, 2));
    logger.warn('[generateHookSettings] Fallback: wrote only Happy hooks');
}
```

**行为**: 写入失败时降级为只写入 Happy hooks，确保会话追踪功能正常。

### 4.3 深合并异常

**场景**: 配置对象结构异常导致合并失败

**处理**: 深合并函数本身不会抛出异常（只是对象操作），但如果出现意外错误，会被外层的 try-catch 捕获。

---

## 5. 测试用例

### 5.1 单元测试

#### 测试 1: 读取用户配置

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateHookSettingsFile } from './generateHookSettings';
import { readClaudeSettings } from './claudeSettings';
import { readFileSync, unlinkSync } from 'node:fs';

vi.mock('./claudeSettings');

describe('generateHookSettingsFile', () => {
    const createdFiles: string[] = [];
    
    afterEach(() => {
        // Clean up created files
        createdFiles.forEach(file => {
            try { unlinkSync(file); } catch {}
        });
        createdFiles.length = 0;
    });
    
    it('should merge user settings with Happy hooks', () => {
        // Mock user settings
        vi.mocked(readClaudeSettings).mockReturnValue({
            env: {
                CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
                API_TIMEOUT_MS: '1800000'
            },
            permissions: {
                allow: ['Bash(git *)']
            }
        });
        
        const filepath = generateHookSettingsFile(8080);
        createdFiles.push(filepath);
        
        const content = JSON.parse(readFileSync(filepath, 'utf-8'));
        
        // Verify user settings are present
        expect(content.env).toBeDefined();
        expect(content.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1000000');
        expect(content.env.API_TIMEOUT_MS).toBe('1800000');
        expect(content.permissions).toBeDefined();
        expect(content.permissions.allow).toContain('Bash(git *)');
        
        // Verify Happy hooks are present
        expect(content.hooks).toBeDefined();
        expect(content.hooks.SessionStart).toBeDefined();
        expect(content.hooks.SessionStart.length).toBeGreaterThan(0);
        expect(content.hooks.SessionStart[0].hooks[0].command).toContain('session_hook_forwarder.cjs');
    });
    
    it('should fallback to Happy hooks when user settings missing', () => {
        // Mock no user settings
        vi.mocked(readClaudeSettings).mockReturnValue(null);
        
        const filepath = generateHookSettingsFile(8080);
        createdFiles.push(filepath);
        
        const content = JSON.parse(readFileSync(filepath, 'utf-8'));
        
        // Verify only Happy hooks are present
        expect(content.hooks).toBeDefined();
        expect(content.hooks.SessionStart).toBeDefined();
        expect(content.hooks.SessionStart.length).toBe(1);
    });
    
    it('should merge user hooks with Happy hooks', () => {
        // Mock user settings with hooks
        vi.mocked(readClaudeSettings).mockReturnValue({
            hooks: {
                SessionStart: [
                    {
                        matcher: '*.ts',
                        hooks: [{ type: 'command', command: 'echo user hook' }]
                    }
                ]
            }
        });
        
        const filepath = generateHookSettingsFile(8080);
        createdFiles.push(filepath);
        
        const content = JSON.parse(readFileSync(filepath, 'utf-8'));
        
        // Verify both user and Happy hooks are present
        expect(content.hooks.SessionStart).toBeDefined();
        expect(content.hooks.SessionStart.length).toBe(2);
        
        // User hook should be first
        expect(content.hooks.SessionStart[0].matcher).toBe('*.ts');
        expect(content.hooks.SessionStart[0].hooks[0].command).toBe('echo user hook');
        
        // Happy hook should be second
        expect(content.hooks.SessionStart[1].matcher).toBe('*');
        expect(content.hooks.SessionStart[1].hooks[0].command).toContain('session_hook_forwarder.cjs');
    });
});
```

### 5.2 集成测试

#### 测试场景 1: 单模型配置

```bash
#!/bin/bash

# 配置
cat > ~/.claude/settings.json << 'EOF'
{
  "env": {
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000"
  }
}
EOF

# 启动会话
happy claude --happy-starting-mode remote

# 验证
sleep 5
grep "contextWindow" ~/.happy/logs/*.log | tail -1
# 期望输出: "contextWindow": 1000000

# 清理
rm ~/.claude/settings.json
```

#### 测试场景 2: 多配置场景

```bash
#!/bin/bash

# 配置
cat > ~/.claude/settings.json << 'EOF'
{
  "env": {
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000",
    "API_TIMEOUT_MS": "1800000",
    "CLAUDE_CODE_EFFORT_LEVEL": "max"
  },
  "permissions": {
    "allow": ["Bash(git *)"],
    "deny": ["Read(./.env)"]
  },
  "modelSettings": {
    "qwen3.7-plus": {
      "effortLevel": "max"
    }
  }
}
EOF

# 启动会话
happy claude --happy-starting-mode remote

# 验证
sleep 5

# 1. 检查 contextWindow
echo "=== Context Window ==="
grep "contextWindow" ~/.happy/logs/*.log | tail -1
# 期望: "contextWindow": 1000000

# 2. 检查合并的 settings 文件
echo "=== Merged Settings File ==="
SETTINGS_FILE=$(ls -t ~/.happy/tmp/hooks/session-hook-*.json | head -1)
cat "$SETTINGS_FILE" | jq .
# 期望: 包含 env, permissions, modelSettings, hooks

# 清理
rm ~/.claude/settings.json
rm "$SETTINGS_FILE"
```

#### 测试场景 3: 用户 hooks 共存

```bash
#!/bin/bash

# 配置
cat > ~/.claude/settings.json << 'EOF'
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "echo 'User hook executed'" }]
      }
    ]
  }
}
EOF

# 启动会话
happy claude --happy-starting-mode remote

# 验证
sleep 5

# 检查合并的 settings 文件
SETTINGS_FILE=$(ls -t ~/.happy/tmp/hooks/session-hook-*.json | head -1)
echo "=== Merged Hooks ==="
cat "$SETTINGS_FILE" | jq '.hooks.SessionStart'
# 期望: 数组长度为 2（用户 hook + Happy hook）

# 清理
rm ~/.claude/settings.json
rm "$SETTINGS_FILE"
```

---

## 6. 实施清单

### 6.1 代码修改

- [ ] 在 `claudeSettings.ts` 中导出 `ClaudeSettings` 类型（如果尚未导出）
- [ ] 在 `generateHookSettings.ts` 中导入 `readClaudeSettings` 和 `ClaudeSettings`
- [ ] 实现 `deepMergeSettings()` 函数
- [ ] 修改 `generateHookSettingsFile()` 函数
- [ ] 添加调试日志
- [ ] 添加错误处理

### 6.2 测试验证

- [ ] 运行单元测试
- [ ] 运行集成测试场景 1（单模型配置）
- [ ] 运行集成测试场景 2（多配置场景）
- [ ] 运行集成测试场景 3（用户 hooks 共存）
- [ ] 验证 contextWindow 变为 1000000
- [ ] 验证会话追踪功能正常

### 6.3 文档更新

- [ ] 更新 PRD.md 的实施状态
- [ ] 更新 SUMMARY_DESIGN.md 的实施状态
- [ ] 添加测试报告

---

## 7. 预期结果

### 7.1 日志输出

**配置**:
```json
{
  "env": {
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000"
  }
}
```

**调试日志**:
```
[generateHookSettings] User settings loaded: env
[generateHookSettings] User env vars: CLAUDE_CODE_MAX_CONTEXT_TOKENS
[generateHookSettings] Merged settings keys: env, hooks
[generateHookSettings] Created merged settings file: /Users/zhangyixiang/.happy/tmp/hooks/session-hook-12345.json
```

**会话日志**:
```json
{
  "contextWindow": 1000000,
  "maxOutputTokens": 32000,
  "canonicalModel": "qwen3.7-plus",
  "provider": "firstParty"
}
```

### 7.2 合并后的 Settings 文件

```json
{
  "env": {
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000",
    "API_TIMEOUT_MS": "1800000"
  },
  "permissions": {
    "allow": ["Bash(git *)"]
  },
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "echo user hook" }]
      },
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "node session_hook_forwarder.cjs 8080" }]
      }
    ]
  }
}
```

---

## 8. 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| `ClaudeSettings` 类型未导出 | 低 | 低 | 检查 claudeSettings.ts，必要时添加导出 |
| 深合并逻辑错误 | 低 | 中 | 充分的单元测试覆盖 |
| 用户配置格式异常 | 低 | 低 | try-catch 降级处理 |
| Hooks 合并顺序问题 | 中 | 低 | 文档说明：用户 hooks 先执行 |

---

## 9. 附录

### 9.1 完整代码清单

**文件**: `packages/happy-cli/src/claude/utils/generateHookSettings.ts`

```typescript
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
        logger.error('[generateHookSettings] Failed to write merged settings file:', error);
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
```

### 9.2 相关文档

- [PRD.md](./PRD.md) — 需求文档
- [TECHNICAL_ANALYSIS.md](./TECHNICAL_ANALYSIS.md) — 深度代码分析
- [SUMMARY_DESIGN.md](./SUMMARY_DESIGN.md) — 概要设计
