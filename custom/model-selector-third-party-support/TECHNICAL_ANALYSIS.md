# 技术分析: 模型选择器第三方模型支持

## 架构概览

### 三层数据流

```
┌─────────────────────────────────────────────────────────────────┐
│ Tier 1: ACP Agent (Claude Code)                                │
│   读取 ~/.claude/settings.json                                  │
│   通过 ACP JSON-RPC 报告可用模型                                 │
│   发出事件: config_options_update / models_update                │
└──────────────────────┬──────────────────────────────────────────┘
                       │ ACP JSON-RPC
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│ Tier 2: Daemon (happy-cli)                                     │
│   AcpBackend.ts     — 接收 ACP 事件，重新发射内部事件              │
│   runAcp.ts         — extractConfigSelector() 提取模型           │
│   sessionConfigMetadata.ts — mergeAcpSessionConfigIntoMetadata() │
│   apiSession.ts     — session.updateMetadata() 加密并发送         │
└──────────────────────┬──────────────────────────────────────────┘
                       │ Socket.IO (encrypted)
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│ Tier 3: Happy App                                              │
│   modelModeOptions.ts  — getAvailableModels() 三级优先级          │
│   useComposerModes.ts  — React hook 提供给 UI                    │
│   AgentInput.tsx       — PickerSheet 渲染模型选择器               │
└─────────────────────────────────────────────────────────────────┘
```

## 关键文件

### App 端 (happy-app)

| 文件 | 作用 |
|------|------|
| `sources/components/modelModeOptions.ts` | 模型列表定义、选择逻辑、优先级判断 |
| `sources/hooks/useComposerModes.ts` | React hook，为 UI 提供 availableModels |
| `sources/components/AgentInput.tsx` | 模型选择器 UI 组件（PickerSheet） |
| `sources/sync/storageTypes.ts` | Metadata 类型定义 |

### Daemon 端 (happy-cli)

| 文件 | 作用 |
|------|------|
| `src/agent/acp/AcpBackend.ts` | ACP 事件接收与转发 |
| `src/agent/acp/runAcp.ts` | 模型数据提取（extractConfigSelector） |
| `src/agent/acp/sessionConfigMetadata.ts` | 模型数据合并到 metadata |
| `src/api/apiSession.ts` | metadata 加密与传输 |

## 现有模型选择逻辑

### `getAvailableModels()` 三级优先级 (modelModeOptions.ts:359-426)

```typescript
getAvailableModels(flavor, metadata, translate, selectedKey)
```

```
优先级 1: isRigMetadataV1(metadata)?
  → 使用 Rig 的模型列表 (sortRigModelsForPicker)

优先级 2: metadata.models 有内容?
  → 使用 metadata 中的模型 (mapMetadataOptions)

优先级 3: 都没有
  → fallback: getHardcodedModelModes(flavor)
  → 对 Claude: getClaudeModelModes() → 5个硬编码 Anthropic 模型
```

### 硬编码模型列表 (modelModeOptions.ts:169-177)

```typescript
export function getClaudeModelModes(): ModelMode[] {
    return [
        { key: 'claude-fable-5-1', name: 'Fable 5.1',   providerId: 'anthropic' },
        { key: 'claude-fable-5',   name: 'Fable 5',     providerId: 'anthropic' },
        { key: 'claude-opus-5',    name: 'Opus 5',      providerId: 'anthropic' },
        { key: 'claude-opus-5[1m]',name: 'Opus 5 [1M]', providerId: 'anthropic' },
        { key: 'claude-sonnet-5',  name: 'Sonnet 5',    providerId: 'anthropic' },
    ];
}
```

### `includeConfiguredModel()` Bug (modelModeOptions.ts:188-209)

```typescript
export function includeConfiguredModel(flavor, models, configuredModelKey) {
    if (
        (flavor !== 'codex' && flavor !== 'agy')  // ← BUG: 排除了 'claude'
        || !configuredModelKey
        || configuredModelKey === 'default'
        || models.some(model => model.key === configuredModelKey)
    ) {
        return models;  // 直接返回，不追加
    }
    // 只有 codex / agy 能走到这里
    return [...models, { key: configuredModelKey, name: configuredModelKey, ... }];
}
```

## ACP 模型数据协议

### config_options_update（优先）

Agent 发出 `SessionNotification`，包含 `configOptions` 数组：

```json
{
  "configOptions": [{
    "id": "model",
    "type": "select",
    "category": "model",
    "currentValue": "claude-sonnet-4-20250514",
    "options": [
      { "value": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4" },
      { "value": "claude-opus-4-20250514",   "name": "Claude Opus 4" }
    ]
  }]
}
```

### models_update（遗留回退）

```json
{
  "availableModels": [
    { "modelId": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4" }
  ],
  "currentModelId": "claude-sonnet-4-20250514"
}
```

## 根因分析

### ✅ 已验证（2026-10-03）

通过直接运行 `claude --print --output-format stream-json --verbose "say hello"` 并读取 settings.json 中的环境变量（ANTHROPIC_BASE_URL 指向 Dashscope，ANTHROPIC_MODEL=qwen3.7-plus），确认了以下事实：

#### Claude Code `init` 消息的实际内容

```json
{
  "type": "system",
  "subtype": "init",
  "session_id": "bbeedf6d-...",
  "model": "qwen3.7-plus",           // ✅ 报告了当前模型
  "permissionMode": "default",
  "claude_code_version": "2.1.285",
  "tools": [...],
  "slash_commands": [...],
  "mcp_servers": [...],
  // ❌ 没有 configOptions 字段
  // ❌ 没有 availableModels 字段
  // ❌ 没有 models_update 事件
}
```

#### 确认的根因

| 发现 | 说明 |
|------|------|
| ✅ Claude Code **知道**自己在用 `qwen3.7-plus` | `init` 消息明确报告了 `"model": "qwen3.7-plus"` |
| ❌ **没有** `config_options_update` 事件 | Claude Code 的 stream-json 输出中完全没有模型列表数据 |
| ❌ **没有** `availableModels` 字段 | 只报告当前使用的模型，不提供可切换列表 |
| ❌ **没有** `models_update` 事件 | 遗留 API 也没有数据 |

**结论：Claude Code 只报告当前使用的模型名，不提供可选模型列表。`metadata.models` 在当前架构下永远为空。**

### 问题 1: Claude Code 不报告模型列表（设计限制）

Claude Code 在 `init` 消息中只报告 `"model": "qwen3.7-plus"`（当前模型），但不提供 `config_options_update` 或 `availableModels`。这意味着：
- `metadata.models` **始终为空**
- App **必定走到硬编码 fallback 路径**（`getClaudeModelModes()`）
- 用户看到 5 个 Anthropic 模型（Fable 5.1, Fable 5, Opus 5, Opus 5 [1M], Sonnet 5），与实际使用的模型无关

### 问题 2: `includeConfiguredModel()` 排除 claude（代码 Bug）

即使走了 fallback 路径，`includeConfiguredModel()` 的设计也不允许 `claude` flavor 追加自定义模型到列表中。条件判断 `(flavor !== 'codex' && flavor !== 'agy')` 对 `claude` 为 true，直接返回硬编码列表，不追加 `selectedKey`（如 `qwen3.7-plus`）。

### 补充场景: settings.json 中的多模型层级配置

#### 配置示例

settings.json 支持通过多个环境变量配置不同的模型层级：

```json
{
  "env": {
    "ANTHROPIC_MODEL": "qwen3.7-plus",              // 默认模型
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "qwen-turbo",  // Haiku 层级
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "qwen-plus",  // Sonnet 层级
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "qwen-max",     // Opus 层级
    "CLAUDE_CODE_SUBAGENT_MODEL": "qwen3.7-plus"    // 子代理
  }
}
```

#### 当前配置

用户当前配置将所有层级设为同一个模型：

```json
{
  "env": {
    "ANTHROPIC_MODEL": "qwen3.7-plus",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "qwen3.7-plus",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "qwen3.7-plus",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "qwen3.7-plus",
    "CLAUDE_CODE_SUBAGENT_MODEL": "qwen3.7-plus"
  }
}
```

#### 问题分析

1. **Claude Code 的 `/model` 命令**：`init` 消息中包含 `"slash_commands": [..., "model", ...]`，说明 Claude Code 支持通过 `/model` 命令切换模型。这个命令应该能读取 settings.json 中的多个模型配置。

2. **ACP 层面缺失**：即使 Claude Code 内部支持多模型切换，但 ACP 层面（`--print --output-format stream-json`）**没有传递可选模型列表**：
   - `init` 消息只有 `"model": "qwen3.7-plus"`（当前模型）
   - 没有 `configOptions` 字段
   - 没有 `availableModels` 字段
   - 没有 `config_options_update` 事件
   - 没有 `models_update` 事件

3. **Happy App 无法感知**：由于 ACP 不传递可选模型列表，Happy App 无法知道 Claude Code 配置了哪些可选模型，只能显示硬编码的 Anthropic 模型列表。

#### 影响

- 即使用户在 settings.json 中配置了多个不同的模型（如 Haiku 用 qwen-turbo，Sonnet 用 qwen-plus，Opus 用 qwen-max），Happy App 也无法显示这些选项
- 用户只能在 Claude Code 终端中使用 `/model` 命令切换模型，无法在 Happy App 中切换
- 这是一个架构限制，需要 ACP 上游支持或 daemon 端从 settings.json 读取模型配置
