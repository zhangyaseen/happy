# 需求文档：settings.json 环境变量被覆盖问题

> **状态**: 待实施
> **优先级**: 高
> **创建日期**: 2026-10-03
> **发现来源**: 模型选择器第三方模型支持功能验证过程中发现

---

## 1. 问题背景

### 1.1 用户场景

用户在 `~/.claude/settings.json` 中配置了多个环境变量来控制 Claude Code 的行为：

```json
{
  "env": {
    "ANTHROPIC_MODEL": "qwen3.7-plus",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000",
    "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT": "1",
    "API_TIMEOUT_MS": "1800000",
    "CLAUDE_CODE_EFFORT_LEVEL": "max"
  }
}
```

**期望行为**：通过 Happy App 创建的会话应该 respect 这些配置，特别是：
- 100 万 token 的上下文窗口
- 自定义 API 超时时间
- 模型努力级别

**实际行为**：这些配置**不生效**，实际 contextWindow 只有 200K（模型默认值）。

### 1.2 发现过程

在验证"模型选择器第三方模型支持"功能时，发现：
1. 模型选择器能正确显示 settings.json 中配置的模型 ✅
2. 但会话日志显示 `contextWindow: 200000`，而非配置的 1000000 ❌
3. 进一步调查发现 settings.json 的 `env` 字段完全没有被应用

---

## 2. 根因分析

### 2.1 技术根因

Happy CLI 在启动 Claude 会话时，会生成一个临时的 settings 文件用于配置 SessionStart hook：

**文件**: `packages/happy-cli/src/claude/utils/generateHookSettings.ts`

```typescript
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
// 写入临时文件
writeFileSync(filepath, JSON.stringify(settings, null, 2));
```

**问题**：这个临时文件**只包含 hooks 配置**，不包含用户 settings.json 的其他内容。

### 2.2 调用链路

```
1. Happy daemon spawn session
   ↓
2. generateHookSettingsFile() → 生成临时 settings 文件（只有 hooks）
   ↓
3. claudeRemote.ts → settingsPath: opts.hookSettingsPath
   ↓
4. SDK query.ts → settings: opts.settingsPath
   ↓
5. Claude Agent SDK → 使用临时 settings 文件，**替代** ~/.claude/settings.json
   ↓
6. Claude 子进程 → 读取临时文件，**没有 env 字段**
   ↓
7. CLAUDE_CODE_MAX_CONTEXT_TOKENS 等配置不生效
```

### 2.3 代码证据

**日志证据**：
```json
{
  "contextWindow": 200000,  // ❌ 应该是 1000000
  "maxOutputTokens": 32000,
  "canonicalModel": "qwen3.7-plus",
  "provider": "firstParty"
}
```

**代码证据**：
- `generateHookSettings.ts:32-46` — 只写入 hooks，不读取用户 settings
- `query.ts:44` — `settings: opts?.settingsPath` 传递临时文件
- `claudeRemote.ts:144` — `settingsPath: opts.hookSettingsPath`

---

## 3. 影响范围

### 3.1 受影响的配置

以下 settings.json `env` 字段的配置**全部不生效**：

| 环境变量 | 用途 | 影响 |
|---------|------|------|
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | 设置上下文窗口大小 | ❌ 使用模型默认值（200K） |
| `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT` | 禁用未知模型的窗口限制 | ❌ 不生效 |
| `API_TIMEOUT_MS` | API 请求超时时间 | ❌ 使用默认超时 |
| `CLAUDE_CODE_EFFORT_LEVEL` | 模型努力级别 | ❌ 不生效 |
| `ANTHROPIC_BASE_URL` | 自定义 API 端点 | ⚠️ 可能生效（需验证） |
| `ANTHROPIC_AUTH_TOKEN` | 认证 token | ⚠️ 可能生效（需验证） |
| 其他自定义环境变量 | 用户自定义配置 | ❌ 不生效 |

### 3.2 不受影响的配置

- **模型名称**：通过 `extractModelsFromSettings()` 单独处理，已修复 ✅
- **permissions**：通过其他方式传递
- **enabledPlugins**：可能受影响（需验证）

### 3.3 用户影响

1. **无法使用 100 万上下文**：用户配置了 1M 上下文但实际只有 200K，长对话会被截断
2. **API 超时问题**：复杂任务可能因超时而失败
3. **模型努力级别不生效**：无法控制模型的推理深度
4. **自定义配置失效**：用户的所有 settings.json env 配置都被忽略

---

## 4. 期望行为

### 4.1 功能需求

**FR-1**: Happy 应该读取用户的 `~/.claude/settings.json` 并合并到临时 hook settings 文件中

**FR-2**: 合并后的 settings 文件应该包含：
- 用户 settings.json 的所有内容（env、modelSettings、permissions 等）
- Happy 的 SessionStart hook 配置

**FR-3**: Claude 子进程应该能够读取并应用所有 settings.json 配置

### 4.2 验收标准

**AC-1**: 配置 `CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000"` 后，会话日志应显示 `contextWindow: 1000000`

**AC-2**: 配置 `API_TIMEOUT_MS: "1800000"` 后，API 请求应使用 30 分钟超时

**AC-3**: 配置 `CLAUDE_CODE_EFFORT_LEVEL: "max"` 后，模型应使用最高努力级别

**AC-4**: Happy 的 SessionStart hook 仍然正常工作（用于会话追踪）

---

## 5. 技术方案（初步）

### 5.1 方案 A：合并 settings 文件

修改 `generateHookSettingsFile()` 函数：

```typescript
export function generateHookSettingsFile(port: number): string {
    // 1. 读取用户 settings.json
    const userSettings = readClaudeSettings();
    
    // 2. 生成 hook 配置
    const hookSettings = {
        hooks: {
            SessionStart: [...]
        }
    };
    
    // 3. 合并（用户配置 + hook 配置）
    const mergedSettings = {
        ...userSettings,
        ...hookSettings,
        // hooks 需要特殊处理，确保不覆盖用户的 hooks
        hooks: {
            ...userSettings?.hooks,
            ...hookSettings.hooks
        }
    };
    
    // 4. 写入临时文件
    writeFileSync(filepath, JSON.stringify(mergedSettings, null, 2));
}
```

**优点**：
- 简单直接
- 保留所有用户配置
- 向后兼容

**缺点**：
- 需要处理 hooks 合并逻辑
- 可能引入用户配置冲突

### 5.2 方案 B：使用 --append-settings

Claude SDK 可能支持 `--append-settings` 参数，可以追加配置而不是替换。

**需要验证**：Claude Agent SDK 是否支持此功能。

### 5.3 方案 C：通过环境变量传递

不修改 settings 文件，而是在启动 Claude 时将 settings.json 的 env 字段提取并作为环境变量传递：

```typescript
// 在 daemon spawn session 时
const userSettings = readClaudeSettings();
const envVars = {
    ...process.env,
    ...userSettings?.env
};
// 传递给 Claude 子进程
```

**优点**：
- 不需要修改 settings 文件
- 简单清晰

**缺点**：
- 只能传递 env 字段，其他配置（modelSettings）仍需要处理
- 环境变量可能被覆盖

---

## 6. 测试计划

### 6.1 单元测试

- 测试 `generateHookSettingsFile()` 正确合并用户 settings
- 测试 hooks 合并逻辑不冲突

### 6.2 集成测试

1. **单模型场景**：
   - 配置 `CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000"`
   - 创建 Happy 会话
   - 验证日志显示 `contextWindow: 1000000`

2. **多配置场景**：
   - 配置多个 env 变量
   - 创建 Happy 会话
   - 验证所有配置生效

3. **Hook 功能验证**：
   - 验证 SessionStart hook 仍然正常工作
   - 验证会话追踪功能正常

### 6.3 端到端测试

- 在 Happy App 中创建会话
- 进行长对话（超过 200K token）
- 验证不会被截断

---

## 7. 风险和缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| Hooks 合并冲突 | 中 | 中 | 使用深度合并，确保不覆盖用户的 hooks |
| 用户配置格式错误 | 低 | 低 | 添加 try-catch，失败时回退到原始行为 |
| 向后兼容问题 | 低 | 高 | 保留原有逻辑作为 fallback |
| 性能影响 | 低 | 低 | 只在 session 启动时读取一次 |

---

## 8. 相关文件

- `packages/happy-cli/src/claude/utils/generateHookSettings.ts` — 需要修改
- `packages/happy-cli/src/claude/utils/claudeSettings.ts` — 已有 `readClaudeSettings()` 函数
- `packages/happy-cli/src/claude/sdk/query.ts` — 传递 settings 参数
- `packages/happy-cli/src/claude/claudeRemote.ts` — 传递 hookSettingsPath

---

## 9. 优先级和排期

**优先级**: 高

**原因**：
1. 影响核心功能（上下文窗口、API 超时）
2. 用户配置被静默忽略，难以诊断
3. 阻碍长对话和复杂任务场景

**建议排期**：下一个 sprint

---

## 10. 附录

### 10.1 相关发现

在验证"模型选择器第三方模型支持"功能时发现此问题。相关文档：
- `custom/model-selector-third-party-support/` — 模型选择器修复

### 10.2 日志样例

**当前日志**（contextWindow 200K）：
```json
{
  "outputTokens": 386,
  "cacheReadInputTokens": 0,
  "cacheCreationInputTokens": 38067,
  "contextWindow": 200000,
  "maxOutputTokens": 32000,
  "canonicalModel": "qwen3.7-plus",
  "provider": "firstParty"
}
```

**期望日志**（contextWindow 1M）：
```json
{
  "outputTokens": 386,
  "cacheReadInputTokens": 0,
  "cacheCreationInputTokens": 38067,
  "contextWindow": 1000000,
  "maxOutputTokens": 32000,
  "canonicalModel": "qwen3.7-plus",
  "provider": "firstParty"
}
```
