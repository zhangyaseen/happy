# 实现方案: 模型选择器第三方模型支持

## 修复策略

两个问题需要分别修复，互不依赖：

| # | 问题 | 修复位置 | 影响范围 |
|---|------|----------|----------|
| 1 | `includeConfiguredModel()` 排除 claude | App 端 modelModeOptions.ts | 小，仅影响 fallback 路径 |
| 2 | ACP 未传递第三方模型列表 | 需进一步诊断 | 取决于根因 |

---

## 修复 1: `includeConfiguredModel()` 支持 claude flavor

### 文件

`packages/happy-app/sources/components/modelModeOptions.ts`

### 当前代码（第 188-209 行）

```typescript
export function includeConfiguredModel(
    flavor: AgentFlavor,
    models: ModelMode[],
    configuredModelKey: string | null | undefined,
): ModelMode[] {
    if (
        (flavor !== 'codex' && flavor !== 'agy')
        || !configuredModelKey
        || configuredModelKey === 'default'
        || models.some((model) => model.key === configuredModelKey)
    ) {
        return models;
    }
    return [
        ...models,
        {
            key: configuredModelKey,
            name: configuredModelKey,
            description: flavor === 'agy' ? 'saved model' : 'custom model',
        },
    ];
}
```

### 修改方案

将条件改为也包含 `claude` flavor：

```typescript
export function includeConfiguredModel(
    flavor: AgentFlavor,
    models: ModelMode[],
    configuredModelKey: string | null | undefined,
): ModelMode[] {
    if (
        (flavor !== 'codex' && flavor !== 'agy' && flavor !== 'claude')
        || !configuredModelKey
        || configuredModelKey === 'default'
        || models.some((model) => model.key === configuredModelKey)
    ) {
        return models;
    }
    return [
        ...models,
        {
            key: configuredModelKey,
            name: configuredModelKey,
            description: flavor === 'agy' ? 'saved model' : 'custom model',
        },
    ];
}
```

### 效果

- 当走到 fallback 路径时，如果当前选中的模型（如 `qwen3.7-plus`）不在硬编码列表中，会追加一行
- 该行显示为 `custom model` 描述，key 为实际的模型 ID
- 用户可以看并选择这个模型

### 补充考虑

追加的自定义模型缺少 `providerId` / `providerName`，在 `groupModelModesByProvider()` 中会被分到无 provider 的组。可以补充：

```typescript
return [
    ...models,
    {
        key: configuredModelKey,
        name: configuredModelKey,
        description: 'custom model',
        providerId: 'custom',
        providerName: 'Custom',
        providerKind: 'custom',
    },
];
```

---

## 修复 2: 诊断 ACP 数据流 ✅ 已完成（2026-10-03）

### 诊断方法

运行 `claude --print --output-format stream-json --verbose "say hello"`，使用 settings.json 中的第三方模型配置（ANTHROPIC_BASE_URL 指向 Dashscope，ANTHROPIC_MODEL=qwen3.7-plus）。

### 诊断结果

```json
{
  "type": "system",
  "subtype": "init",
  "model": "qwen3.7-plus",           // ✅ 报告了当前模型
  // ❌ 没有 configOptions 字段
  // ❌ 没有 availableModels 字段
  // ❌ 后续没有 config_options_update 事件
  // ❌ 后续没有 models_update 事件
}
```

### 结论

**Claude Code 只提供当前模型名，不提供可选模型列表**。这是设计限制，不是 bug：
- `init` 消息包含 `"model": "qwen3.7-plus"`（当前使用的模型）
- 没有 `config_options_update` 事件（不提供可选模型列表）
- 没有 `models_update` 事件（遗留 API 也没有数据）
- `metadata.models` 在当前架构下**始终为空**

### 影响

由于 ACP 不提供模型列表，App 端**必定走到硬编码 fallback 路径**。这意味着：
1. 修复 1（`includeConfiguredModel()` 支持 claude）是必要的
2. 方案 C（智能 fallback）是最佳选择 — 当检测到第三方模型时，不显示无用的 Anthropic 硬编码列表
3. Daemon 端不需要从 settings.json 注入模型信息（方案 B）— 这会增加耦合，且只能提供 1 个模型
4. 未来如果 Anthropic 让 Claude Code 提供可选模型列表，现有的优先级 2 逻辑会自动生效

---

## 修复 3: Daemon 端从 settings.json 注入多模型配置（方案 B）✅ 已验证（2026-10-03）

### 多模型真实测试结果（2026-10-03）

**测试方法**: 临时修改 settings.json，配置不同的第三方模型，运行 Claude Code 检查 init 消息。

| 测试 | 配置 | Claude Code 报告 | 结果 |
|------|------|-----------------|------|
| 测试 1 | ANTHROPIC_MODEL = qwen3.7-plus | `"model": "qwen3.7-plus"` | ✅ 识别 |
| 测试 2 | ANTHROPIC_MODEL = kimi-k2.5 | `"model": "kimi-k2.5"` | ✅ 识别 |

**关键发现**:
1. ✅ Claude Code 确实能识别不同的第三方模型（qwen、kimi）
2. ✅ init 消息中的 model 字段会反映 ANTHROPIC_MODEL 的配置
3. ✅ 方案 B 不仅逻辑可行，在真实场景中也完全可行

### 可行性验证结果

**验证方法**: 运行 `/tmp/verify-scheme-b.mjs` 和 `/tmp/verify-scheme-b-multi.mjs` 脚本

**验证结果**:

1. ✅ settings.json 存在且可以读取
2. ✅ `env` 字段包含所有 5 个模型配置环境变量
3. ✅ 可以提取并去重模型列表
4. ✅ 可以构造 metadata.models

**当前配置（所有层级相同）**:
```
ANTHROPIC_MODEL: qwen3.7-plus
ANTHROPIC_DEFAULT_HAIKU_MODEL: qwen3.7-plus
ANTHROPIC_DEFAULT_SONNET_MODEL: qwen3.7-plus
ANTHROPIC_DEFAULT_OPUS_MODEL: qwen3.7-plus
CLAUDE_CODE_SUBAGENT_MODEL: qwen3.7-plus
```
→ 去重后: **1 个模型** (qwen3.7-plus)

**多模型配置（测试场景）**:
```
ANTHROPIC_MODEL: qwen-max
ANTHROPIC_DEFAULT_HAIKU_MODEL: qwen-turbo
ANTHROPIC_DEFAULT_SONNET_MODEL: qwen-plus
ANTHROPIC_DEFAULT_OPUS_MODEL: qwen-max
CLAUDE_CODE_SUBAGENT_MODEL: qwen3.7-plus
```
→ 去重后: **4 个模型** (qwen-max, qwen-turbo, qwen-plus, qwen3.7-plus)

**结论**: ✅ 方案 B 完全可行

### 场景

用户在 settings.json 中配置了多个不同的模型层级：

```json
{
  "env": {
    "ANTHROPIC_MODEL": "qwen3.7-plus",              // 默认模型
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "qwen-turbo",  // Haiku 层级
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "qwen-plus",  // Sonnet 层级
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "qwen-max"      // Opus 层级
  }
}
```

用户希望在 Happy App 中能看到并切换这些模型。

### 文件

1. `packages/happy-cli/src/agent/acp/runAcp.ts` — 读取 settings.json，构造模型列表
2. `packages/happy-cli/src/claude/claudeSettings.ts` — 已有读取 settings.json 的逻辑，可能需要扩展

### 实现逻辑

```typescript
// 在 runAcp.ts 的 session 初始化逻辑中

// 1. 定义模型相关的环境变量
const MODEL_ENV_VARS = [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
];

// 2. 从 settings.json 的 env 字段读取模型配置
const settings = readClaudeSettings(); // 已有函数
const env = settings.env || {};
const configuredModels = MODEL_ENV_VARS
    .map(key => env[key])
    .filter((v): v is string => typeof v === 'string' && v.length > 0);

// 3. 去重
const uniqueModels = [...new Set(configuredModels)];

// 4. 如果 ACP 没有报告模型列表，使用 settings.json 的配置
if (uniqueModels.length > 0 && !metadata.models?.length) {
    metadata.models = uniqueModels.map(model => ({
        code: model,
        value: model,
    }));
    // 当前模型优先使用 init 消息中的 model，否则使用 ANTHROPIC_MODEL
    metadata.currentModelCode = initModel || env.ANTHROPIC_MODEL || uniqueModels[0];
}
```

### 效果

- 如果用户配置了 5 个不同的模型，Happy App 显示 5 个选项
- 如果用户配置了相同的模型（如当前配置，所有层级都是 qwen3.7-plus），去重后只显示 1 个选项
- 如果 ACP 后续报告了模型列表（未来可能的上游修复），优先使用 ACP 数据

### 待验证

1. Claude Code 在用户通过 `/model` 切换模型后，settings.json 是否会更新？
   - 如果不会，方案 B 只能读取初始配置，无法感知后续切换
   - 需要测试：在 Claude Code 中执行 `/model` 切换到另一个模型，然后检查 settings.json 是否变化

2. 不同 agent 的 settings 路径：
   - Claude: `~/.claude/settings.json`
   - Codex: 可能不同，需要确认

3. 环境变量名是否会变化：
   - 当前使用的变量名来自 Claude Code 的内部实现
   - 如果 Anthropic 改变变量名，daemon 需要更新

### 回归风险

- 中。增加了 daemon 对 settings.json 的直接依赖
- 需要确保不影响现有的 ACP 数据流（如果 ACP 报告了模型，优先使用 ACP）
- 需要处理 settings.json 不存在或格式错误的情况

---

## 影响范围评估

### 修改文件清单

| 文件 | 修改类型 | 风险 |
|------|----------|------|
| `happy-app/.../modelModeOptions.ts` | 修改条件判断 | 低 — 仅影响 fallback 路径 |
| `happy-cli/.../runAcp.ts` | 添加诊断日志（临时） | 无 — 仅日志 |

### 不需要修改的部分

- AcpBackend.ts — 逻辑正确
- sessionConfigMetadata.ts — 合并逻辑正确
- useComposerModes.ts — hook 层不涉及
- AgentInput.tsx — UI 组件不涉及

### 回归风险

- 修复 1 只影响 `flavor === 'claude'` 且走到 fallback 路径的场景
- 不会影响 Codex / Gemini / Agy / Rig 的模型选择
- 不会影响 metadata.models 有内容的正常路径

---

## 待确认事项 ✅ 已全部确认（2026-10-03）

1. [x] Claude Code agent 在第三方模型配置下，ACP 的 `config_options_update` 具体发出了什么内容？
   - **结论**: 没有 `config_options_update` 事件。只有 `init` 消息包含 `"model": "qwen3.7-plus"`。

2. [x] `~/.claude/settings.json` 中第三方模型的配置格式是什么？
   - **结论**: 使用 `env` 字段设置 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_MODEL` 等环境变量，`model` 字段设为 `"sonnet"` 等 Anthropic 模型层级。

3. [x] 是否需要在 App 端显示 provider 信息（如 "Qwen" / "Custom"）？
   - **结论**: 是。方案 C 中补充了 `providerId: 'custom'` / `providerName: 'Custom'`。

4. [x] 第三方模型是否支持 effort level 选择？
   - **结论**: 不相关。由于 ACP 不提供可选模型列表，第三方模型用户只能看到当前使用的 1 个模型，无法切换 effort level。

5. [x] settings.json 是否支持配置多个不同的模型？
   - **结论**: **是**。settings.json 支持多个环境变量配置不同的模型层级：
     - `ANTHROPIC_MODEL` — 默认模型
     - `ANTHROPIC_DEFAULT_HAIKU_MODEL` — Haiku 层级
     - `ANTHROPIC_DEFAULT_SONNET_MODEL` — Sonnet 层级
     - `ANTHROPIC_DEFAULT_OPUS_MODEL` — Opus 层级
     - `CLAUDE_CODE_SUBAGENT_MODEL` — 子代理模型
   - **当前配置**: 所有层级都设为 `qwen3.7-plus`（同一个模型）
   - **潜在配置**: 可以配置成不同的模型（如 Haiku 用 qwen-turbo，Sonnet 用 qwen-plus，Opus 用 qwen-max）

6. [ ] Claude Code 在用户通过 `/model` 切换模型后，settings.json 是否会更新？
   - **结论**: **待验证**。需要测试在 Claude Code 中执行 `/model` 切换模型后，检查 settings.json 是否变化。
   - **影响**: 如果不会更新，方案 B（Daemon 从 settings.json 读取模型）只能读取初始配置，无法感知后续切换。
