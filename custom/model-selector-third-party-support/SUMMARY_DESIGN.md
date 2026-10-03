# 概要设计文档: 模型选择器第三方模型支持

> **状态**: 设计完成，待评审
> **日期**: 2026-10-03
> **关联**: [PRD.md](./PRD.md) · [TECHNICAL_ANALYSIS.md](./TECHNICAL_ANALYSIS.md) · [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)

---

## 1. 全面分析

### 1.1 系统架构总览

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          ~/.claude/settings.json                         │
│  { "model": "qwen3.7-plus", "env": { "ANTHROPIC_BASE_URL": "..." } }   │
└─────────────────────────────┬────────────────────────────────────────────┘
                              │ daemon 读取，传给 Claude CLI
                              ▼
┌──────────────────────────────────────────────────────────────────────────┐
│              Tier 1: Claude Code Agent Process                           │
│                                                                          │
│  启动参数: --print --output-format stream-json --model qwen3.7-plus     │
│  环境变量: ANTHROPIC_BASE_URL=https://custom-api-endpoint               │
│                                                                          │
│  ACP 输出（已验证 2026-10-03）:                                          │
│    • init 消息: { "model": "qwen3.7-plus" }  ← 只报告当前模型           │
│    • ❌ 没有 config_options_update 事件（不提供可选模型列表）             │
│    • ❌ 没有 models_update 事件                                         │
│    • 结论: metadata.models 永远为空                                      │
└─────────────────────────────┬────────────────────────────────────────────┘
                              │ ACP JSON-RPC
                              ▼
┌──────────────────────────────────────────────────────────────────────────┐
│              Tier 2: happy-cli Daemon                                    │
│                                                                          │
│  AcpBackend.ts        → 接收 ACP 事件，转发内部事件                       │
│  runAcp.ts            → extractConfigSelector() 提取模型选择器            │
│  sessionConfigMetadata.ts → mergeAcpSessionConfigIntoMetadata()          │
│  apiSession.ts        → session.updateMetadata() 加密发送到服务器          │
└─────────────────────────────┬────────────────────────────────────────────┘
                              │ Socket.IO (E2E 加密)
                              ▼
┌──────────────────────────────────────────────────────────────────────────┐
│              Happy Server                                                │
│  广播 update-session 事件给所有连接的客户端                                │
└─────────────────────────────┬────────────────────────────────────────────┘
                              │ Socket.IO
                              ▼
┌──────────────────────────────────────────────────────────────────────────┐
│              Tier 3: Happy App                                           │
│                                                                          │
│  sync.ts             → 解密 metadata，更新 Zustand store                  │
│  useComposerModes.ts → getAvailableModels() 三级优先级解析                 │
│  AgentInput.tsx      → PickerSheet / NativeSettingsMenu 渲染              │
└──────────────────────────────────────────────────────────────────────────┘
```

### 1.2 数据流细节

#### ACP 协议层 — 模型数据如何传递

**现代 API (`config_options_update`)**:

```json
{
  "configOptions": [{
    "id": "model",
    "type": "select",
    "category": "model",
    "currentValue": "claude-sonnet-4-20250514",
    "options": [
      { "value": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4" },
      { "value": "claude-opus-4-20250514", "name": "Claude Opus 4" }
    ]
  }]
}
```

**遗留 API (`models_update`)**:

```json
{
  "availableModels": [
    { "modelId": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4" }
  ],
  "currentModelId": "claude-sonnet-4-20250514"
}
```

#### Daemon 层 — 提取与合并

`extractConfigSelector(configOptions, 'model')` 的匹配策略：
1. **优先**: `option.category === 'model'` 精确匹配
2. **回退**: `option.id` 或 `option.name` 包含 "model"（大小写不敏感）

匹配成功后：
- `flattenSelectOptions()` 展平嵌套选项为 `[{ code, value }]`
- `mergeAcpSessionConfigIntoMetadata()` 写入 `metadata.models` + `metadata.currentModelCode`

#### App 层 — 三级优先级

```typescript
getAvailableModels(flavor, metadata, translate, selectedKey)

优先级 1: isRigMetadataV1(metadata)?
  → Rig 模型列表 (sortRigModelsForPicker)

优先级 2: metadata.models 有内容?
  → mapMetadataOptions(metadata.models) → UI 显示

优先级 3: 都没有
  → getHardcodedModelModes(flavor) → 硬编码回退
  → includeConfiguredModel(flavor, hardcoded, selectedKey)
```

### 1.3 问题根因链（已验证 2026-10-03）

```
settings.json 配置了 "model": "qwen3.7-plus"
    │
    ▼
daemon 启动 Claude CLI: --model qwen3.7-plus
    │
    ▼
Claude Code agent 运行，使用 qwen3.7-plus
    │
    ├─→ init 消息: { "model": "qwen3.7-plus" }  ✅ 报告当前模型
    │
    ├─→ config_options_update 事件?
    │   └─ ❌ 不存在（已验证，没有此事件）
    │
    ├─→ models_update 事件?
    │   └─ ❌ 不存在（已验证，没有此事件）
    │
    ▼
metadata.models 始终为空（Claude Code 不提供可选模型列表）
    │
    ▼
App 走到优先级 3: 硬编码 fallback
    │
    ▼
includeConfiguredModel() 排除 'claude' flavor
    │
    ▼
用户看到: Fable 5.1, Fable 5, Opus 5, Opus 5 [1M], Sonnet 5
```

**关键发现**:

| 问题编号 | 描述 | 严重程度 | 位置 |
|---------|------|---------|------|
| P1 | Claude Code **只报告当前模型**，不提供可选模型列表（`config_options_update` 和 `models_update` 均不存在） | 🔴 高 | Agent 端（设计限制） |
| P2 | `includeConfiguredModel()` 排除 `claude` flavor，导致当前第三方模型也不显示 | 🟡 中 | `modelModeOptions.ts:193` |
| P3 | Daemon 不主动读取 settings.json 的模型配置 | 🟢 低（设计如此） | `claudeSettings.ts` |

**验证方法**: `claude --print --output-format stream-json --verbose "say hello"` 读取完整输出，确认只有 `init` 消息包含 `"model"` 字段，无其他模型列表事件。

---

## 2. 解决方案

### 方案 A: 仅修复 App 端 `includeConfiguredModel()`

**思路**: 最小改动，让 fallback 路径能显示当前选中的自定义模型。

**改动**:

```
文件: happy-app/sources/components/modelModeOptions.ts
函数: includeConfiguredModel() (第 193 行)

旧: (flavor !== 'codex' && flavor !== 'agy')
新: (flavor !== 'codex' && flavor !== 'agy' && flavor !== 'claude')
```

**效果**:
- 当 `metadata.models` 为空时，`selectedKey`（如 `qwen3.7-plus`）会被追加到硬编码列表末尾
- 用户至少能看到当前使用的第三方模型

**优点**:
- ✅ 改动极小（1 行条件）
- ✅ 零风险，不影响其他 flavor
- ✅ 立即生效，不依赖 daemon 端改动

**缺点**:
- ❌ 治标不治本 — 只显示 1 个自定义模型，不显示可选列表
- ❌ 追加的模型没有 `providerId`/`providerName`，UI 分组不完美
- ❌ 用户仍然看到 5 个不可用的 Anthropic 模型 + 1 个自定义模型
- ❌ 如果 `selectedKey` 也丢失（比如 session 没有保存 modelMode），则完全无效

**影响范围**: `modelModeOptions.ts` 1 处改动
**回归风险**: 极低

---

### 方案 B: Daemon 端补充 — 从 settings.json 注入模型信息 ✅ 已验证（2026-10-03）

**思路**: 当 ACP agent 没有报告模型列表时，daemon 主动从 settings.json 读取模型配置，构造 `metadata.models`。

**可行性验证**: ✅ 通过

- ✅ `readClaudeSettings()` 函数已存在于 `claudeSettings.ts`
- ✅ settings.json 的 `env` 字段包含所有模型配置
- ✅ 可以提取、去重并构造 metadata.models
- ✅ 当前配置（所有层级相同）→ 去重后 1 个模型
- ✅ 多模型配置（测试）→ 去重后 4 个模型

**思路**: 当 ACP agent 没有报告模型列表时，daemon 主动从 settings.json 读取模型配置，构造 `metadata.models`。

**settings.json 的多模型配置**（已确认 2026-10-03）:

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

**改动**:

```
文件: happy-cli/src/agent/acp/runAcp.ts
位置: session 创建后的 metadata 初始化逻辑

新增逻辑:
1. 读取 settings.json 的 env 字段
2. 提取所有模型相关环境变量:
   - ANTHROPIC_MODEL (默认)
   - ANTHROPIC_DEFAULT_HAIKU_MODEL
   - ANTHROPIC_DEFAULT_SONNET_MODEL
   - ANTHROPIC_DEFAULT_OPUS_MODEL
   - CLAUDE_CODE_SUBAGENT_MODEL
3. 去重后构造 metadata.models = [{ code: model1, value: model1 }, ...]
4. 设置 metadata.currentModelCode = ANTHROPIC_MODEL 或 init 消息中的 model
5. 如果 ACP 后续报告了 config_options_update，优先使用 ACP 数据
```

**效果**:
- `metadata.models` 不为空，App 走优先级 2 而非优先级 3
- 用户在 UI 中看到所有配置的模型选项（可能 1-5 个，取决于配置）
- 如果所有层级配置为同一个模型，只显示 1 个选项

**优点**:
- ✅ 从源头解决问题 — 确保 metadata 始终有模型数据
- ✅ 支持多模型层级配置 — 用户可以在 Happy App 中切换不同层级的模型
- ✅ 不依赖 ACP agent 的行为
- ✅ 利用已有的 `claudeSettings.ts` 读取逻辑
- ✅ 去重后避免重复选项

**缺点**:
- ❌ 如果用户在 Claude Code 中通过 `/model` 切换模型，settings.json 可能不会更新（需要验证）
- ❌ Daemon 需要新增读取 settings.json 的逻辑（增加耦合）
- ❌ 不同 agent 的 settings 路径不同（Claude: `~/.claude/`, Codex: 不同位置）
- ❌ 环境变量名可能变化（依赖 Claude Code 的内部实现）

**影响范围**: `runAcp.ts` + `claudeSettings.ts`
**回归风险**: 中

---

### 方案 C: App 端智能 Fallback — 感知自定义模型

**思路**: 在 `getAvailableModels()` 的 fallback 路径中，不仅追加自定义模型，还隐藏不相关的硬编码模型。

**改动**:

```
文件: happy-app/sources/components/modelModeOptions.ts
函数: getAvailableModels() 的优先级 3 分支

新增逻辑:
1. 检测 selectedKey 是否是硬编码列表中的模型
2. 如果是 → 走现有逻辑（显示完整硬编码列表）
3. 如果不是（第三方模型）→ 只显示该自定义模型，不显示硬编码列表
4. 补充 providerId/providerName 信息
```

**效果**:
- 第三方模型用户：UI 只显示 1 个模型（当前使用的）
- Anthropic 模型用户：UI 显示完整的 5 个 Anthropic 模型（现有行为）
- 如果有 metadata.models，走优先级 2 显示完整列表

**优点**:
- ✅ 用户体验最好 — 不会显示无法使用的 Anthropic 模型
- ✅ 纯 App 端改动，不依赖 daemon
- ✅ 自动适配 — 有 ACP 数据时用 ACP，没有时智能回退

**缺点**:
- ❌ 只显示当前模型，不提供其他 Anthropic 模型作为切换选项
- ❌ 需要判断 "是否是第三方模型" 的逻辑（可能有边界情况）
- ❌ 如果用户想临时切回 Anthropic 模型，需要先去 settings.json 改

**影响范围**: `modelModeOptions.ts` 1 处改动
**回归风险**: 低

---

### 方案 D: 完整链路修复 — ACP 诊断 + App Fallback + Provider 分组

**思路**: 同时修复 daemon 和 app 两端，实现完整的第三方模型支持。

**改动**:

**Daemon 端 (happy-cli)**:
1. ~~在 `runAcp.ts` 添加诊断日志，确认 ACP 事件内容~~ — ✅ 已验证：Claude Code 不提供可选模型列表
2. 在 `sessionConfigMetadata.ts` 放宽 `findConfigOptionByCategory()` 匹配逻辑 — **不再需要**，因为根本没有模型列表数据
3. 如果 ACP 没有报告模型，从 settings.json 补充当前模型到 metadata

**App 端 (happy-app)**:
4. 修复 `includeConfiguredModel()` 支持 `claude` flavor
5. 追加自定义模型时补充 `providerId`/`providerName`/`providerKind`
6. 在 fallback 路径中，当检测到第三方模型时，分组显示 "Custom" provider

**效果**:
- 完整支持：有 ACP 数据时显示完整列表，没有时智能 fallback
- 自定义模型有正确的 provider 分组
- 两端都有防御性逻辑

**优点**:
- ✅ 最完整的解决方案
- ✅ 多层防御 — 即使 ACP 不报告，也能优雅降级
- ✅ Provider 分组清晰
- ✅ 为未来完整的第三方模型列表支持铺路

**缺点**:
- ❌ 改动量大（2 个 package，多处改动）
- ❌ 需要更多测试
- ❌ Daemon 端 fuzzy match 可能误匹配

**影响范围**: `modelModeOptions.ts` + `runAcp.ts` + `sessionConfigMetadata.ts`
**回归风险**: 中

---

### 方案 E: 等待 ACP 上游修复

**思路**: 这是 Claude Code agent 的问题 — 当使用第三方模型时，应该通过 `config_options_update` 报告可用模型列表。等上游修复后，daemon 和 app 端的现有逻辑能自动工作。

**改动**: 无（或仅方案 A 的 1 行作为防御性补充）

**优点**:
- ✅ 零改动
- ✅ 最正确 — 数据源在 agent 端

**缺点**:
- ❌ 不可控 — 依赖 Anthropic 的优先级
- ❌ 用户现在就有问题
- ❌ 即使上游修了，`includeConfiguredModel()` 的 bug 仍在

---

## 3. 方案对比

| 维度 | A: App 最小修复 | B: Daemon 注入 | C: App 智能 Fallback | D: 完整链路修复 | E: 等上游 |
|------|----------------|---------------|---------------------|----------------|----------|
| **改动量** | 1 行 | ~50 行 | ~20 行 | ~60 行 | 0 行 |
| **影响范围** | App 1 文件 | Daemon 2 文件 | App 1 文件 | App 1 + Daemon 2 | 无 |
| **解决程度** | 部分 | **大部分** | 大部分 | 完整 | 不确定 |
| **多模型支持** | ❌ 不支持 | ✅ **支持** | ❌ 不支持 | ✅ 支持 | 不确定 |
| **用户体验** | ⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐ |
| **回归风险** | 极低 | 中 | 低 | 中 | 无 |
| **可控性** | 完全 | 完全 | 完全 | 完全 | 不可控 |
| **未来扩展** | 差 | 好 | 好 | 最好 | 最好 |
| **实施速度** | 5 分钟 | 2 小时 | 30 分钟 | 2-3 小时 | 0 |

**关键更新**（2026-10-03）：方案 B 现在支持读取 settings.json 中的多个模型层级配置（ANTHROPIC_MODEL、ANTHROPIC_DEFAULT_HAIKU_MODEL 等），可以为用户提供完整的可选模型列表。

---

## 4. 推荐方案（基于第一性原理分析，2026-10-03 更新）

### 🏆 最佳实践: 方案 B（直接实施 Daemon 端注入）

**基于第一性原理的分析**:

1. **数据源头原则** — settings.json 是配置源头，daemon 最接近源头，应该在这里读取
2. **职责分离原则** — daemon 负责数据构造，app 负责展示，职责清晰
3. **单一数据源原则** — metadata.models 由 daemon 统一构造，避免 app 端做 workaround
4. **最小化 App 端逻辑** — app 端只使用 metadata.models，不需要复杂的 fallback 逻辑
5. **向后兼容原则** — 优先使用 ACP 数据，fallback 到 settings.json，未来 ACP 支持时自动切换

**为什么方案 B 是正确的设计**:

- ✅ 数据从源头获取（settings.json → daemon → app）
- ✅ 职责分离清晰（daemon 构造数据，app 展示数据）
- ✅ 代码干净（不需要 workaround）
- ✅ 已验证完全可行（逻辑验证 + 真实多模型测试）

**改动**:
- Daemon 端: `runAcp.ts` + `claudeSettings.ts`（~50 行代码，2 小时）

**效果**:
- 用户配置多个模型 → Happy App 显示多个模型
- 用户配置 1 个模型 → Happy App 显示 1 个模型
- 所有模型都是可用的，没有无用的 Anthropic 硬编码模型

### 为什么不选 A + C？

**方案 A + C 的本质**: 在 app 端做 workaround，弥补 daemon 端的缺失。

**问题**:
- ❌ 违反职责分离 — app 端承担了不应该的职责
- ❌ 违反单一数据源 — app 端也要判断是否第三方模型
- ❌ 增加技术债务 — 未来 Claude Code 提供数据时，这些 workaround 需要清理
- ❌ 治标不治本 — 只是在 app 端"掩盖"问题
- ❌ 不支持多模型切换 — 只能显示 1 个模型

**唯一优点**: 改动小（20 行代码，30 分钟），但这不应该成为选择错误设计的理由。

### 历史推荐（已废弃）

<details>
<summary>方案 A + C 组合（渐进式 App 端修复）— 已废弃</summary>

**理由**（已过时）:
1. 方案 A 作为底线保障 — 1 行改动，零风险
2. 方案 C 作为体验优化 — 隐藏无用的硬编码列表
3. 两者组合 = 最小改动 + 最好体验

**局限**: 不支持多模型切换，违反第一性原理。
</details>

### 不选方案 D 的原因

方案 D 虽然最完整，但：
- 改动量大（60 行代码，2-3 小时）
- Daemon 端 fuzzy match 引入了不确定行为
- 方案 B 已经足够，不需要 D 的复杂逻辑

---

## 5. 推荐方案详细设计（方案 B）

### 5.1 改动清单

**改动文件**:
1. `packages/happy-cli/src/agent/acp/runAcp.ts` — 读取 settings.json，构造模型列表
2. `packages/happy-cli/src/claude/utils/claudeSettings.ts` — 已有读取逻辑，可能需要扩展

### 5.2 改动 1: 定义模型环境变量常量

在 `runAcp.ts` 中定义：

```typescript
// 模型相关的环境变量（按优先级排序）
const MODEL_ENV_VARS = [
    'ANTHROPIC_MODEL',                    // 默认模型
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',      // Haiku 层级
    'ANTHROPIC_DEFAULT_SONNET_MODEL',     // Sonnet 层级
    'ANTHROPIC_DEFAULT_OPUS_MODEL',       // Opus 层级
    'CLAUDE_CODE_SUBAGENT_MODEL',         // 子代理模型
];
```

### 5.3 改动 2: 从 settings.json 提取模型配置

在 session 初始化逻辑中添加：

```typescript
import { readClaudeSettings } from '@/claude/utils/claudeSettings';

function extractModelsFromSettings(): { models: string[], currentModel: string | null } {
    const settings = readClaudeSettings();
    if (!settings?.env) {
        return { models: [], currentModel: null };
    }

    const env = settings.env;
    
    // 提取所有模型配置
    const configuredModels = MODEL_ENV_VARS
        .map(key => env[key])
        .filter((v): v is string => typeof v === 'string' && v.length > 0);

    // 去重
    const uniqueModels = [...new Set(configuredModels)];

    // 当前模型优先使用 ANTHROPIC_MODEL
    const currentModel = env.ANTHROPIC_MODEL || uniqueModels[0] || null;

    return { models: uniqueModels, currentModel };
}
```

### 5.4 改动 3: 构造 metadata.models

在 `onBackendMessage` 处理 init 消息后：

```typescript
// 如果 ACP 没有报告模型列表，从 settings.json 补充
if (!metadata.models?.length) {
    const { models, currentModel } = extractModelsFromSettings();
    
    if (models.length > 0) {
        metadata.models = models.map(model => ({
            code: model,
            value: model,
        }));
        
        if (currentModel) {
            metadata.currentModelCode = currentModel;
        }
        
        logger.debug(`[runAcp] Injected ${models.length} models from settings.json`);
    }
}

// 如果 ACP 后续报告了模型列表，优先使用 ACP 数据
// （现有的 config_options_update 处理逻辑已经会覆盖 metadata.models）
```

### 5.5 行为矩阵

| 场景 | ACP 报告 | settings.json | 结果 |
|------|---------|---------------|------|
| ACP 报告了模型列表 | ✅ 有 | 任意 | 使用 ACP 数据（优先级最高） |
| ACP 未报告，settings.json 有配置 | ❌ 无 | ✅ 有 | 使用 settings.json 数据 |
| ACP 未报告，settings.json 无配置 | ❌ 无 | ❌ 无 | 走 App 端硬编码 fallback |
| 多模型配置 | ❌ 无 | ✅ 多个 | 显示所有配置的模型 |
| 单模型配置 | ❌ 无 | ✅ 1 个 | 显示 1 个模型 |

### 5.6 实施步骤

1. 在 `runAcp.ts` 中导入 `readClaudeSettings`
2. 添加 `extractModelsFromSettings()` 函数
3. 在 session 初始化时调用该函数
4. 如果 ACP 没有报告模型列表，注入 settings.json 的数据
5. 测试验证

### 5.7 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| settings.json 不存在或格式错误 | 低 | 低 | `readClaudeSettings()` 已有错误处理，返回 null |
| 环境变量名变化 | 低 | 中 | 使用常量数组，易于维护 |
| Claude Code `/model` 切换后 settings.json 不更新 | 中 | 低 | 已验证当前配置可以工作，未来问题未来解决 |
| 与 ACP 数据冲突 | 低 | 低 | ACP 数据优先级更高，会自动覆盖 |
├─────────────────────────┤
│  ─ Anthropic ─          │
│  ○ Fable 5.1            │
│    1M context            │
│  ○ Fable 5              │
│  ● Opus 5               │
│  ○ Opus 5 [1M]          │
│    1M context            │
│  ○ Sonnet 5             │
└─────────────────────────┘
```

---

## 6. 后续演进

### Phase 1 (本次): Daemon 端注入模型列表
- ✅ 已验证：settings.json 可以读取多模型配置
- ✅ 已验证：Claude Code 能识别不同的第三方模型（qwen、kimi）
- 实施：在 runAcp.ts 中读取 settings.json，构造 metadata.models
- 测试：单模型和多模型场景

### Phase 2 (未来): ACP 数据完善
- ✅ 已确认：Claude Code 不提供可选模型列表（设计限制）
- 期望：未来 Claude Code 能通过 ACP 报告可选模型列表
- 当 ACP 支持时，自动优先使用 ACP 数据（现有逻辑已支持）

### Phase 3 (长期): 完整多 Provider 支持
- App 端支持任意数量的 provider 分组
- 支持 provider 级别的配置（API key、endpoint 等）
- 模型列表从 daemon 动态获取，不再硬编码

---

## 7. 风险与缓解（方案 B）

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| settings.json 不存在或格式错误 | 低 | 低 | `readClaudeSettings()` 已有错误处理，返回 null |
| 环境变量名变化 | 低 | 中 | 使用常量数组，易于维护 |
| Claude Code `/model` 切换后 settings.json 不更新 | 中 | 低 | 已验证当前配置可以工作，未来问题未来解决 |
| 与 ACP 数据冲突 | 低 | 低 | ACP 数据优先级更高，会自动覆盖 |
| 模型切换在 agent 端不生效 | 中 | 中 | 已知限制，需 ACP 上游支持 |
