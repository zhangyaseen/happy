# 详细设计文档: 模型选择器第三方模型支持（方案 B）

> **状态**: 待实施
> **日期**: 2026-10-03
> **关联**: [SUMMARY_DESIGN.md](./SUMMARY_DESIGN.md) · [TECHNICAL_ANALYSIS.md](./TECHNICAL_ANALYSIS.md) · [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)

---

## Context

当用户通过 `~/.claude/settings.json` 配置第三方模型（如 `qwen3.7-plus`）后，Happy App 的模型选择器始终显示硬编码的 Anthropic 模型（Fable 5.1, Fable 5, Opus 5 等），无法显示用户实际配置的模型。

**根因**：Claude Code 的 `init` 消息只报告当前模型名（`"model": "qwen3.7-plus"`），不提供 `config_options_update` 或 `models_update` 事件，导致 `metadata.models` 始终为空，App 必定走到硬编码 fallback。

**方案**：在 daemon 端（`runAcp.ts`）从 settings.json 读取用户配置的模型列表，注入到 `metadata.models`。基于第一性原理，这是正确的设计——daemon 最接近配置源，职责分离清晰。

---

## 1. 架构总览

### 1.1 修改范围

```
修改 2 个文件:
├── packages/happy-cli/src/agent/acp/runAcp.ts          ← daemon 注入逻辑
└── packages/happy-app/sources/components/modelModeOptions.ts  ← app 端兼容修复
```

### 1.2 数据流（修改后）

```
~/.claude/settings.json
    │
    │ env.ANTHROPIC_MODEL, env.ANTHROPIC_DEFAULT_HAIKU_MODEL, ...
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│  Daemon (runAcp.ts)                                     │
│                                                         │
│  1. ACP 事件到达（config_options_update / models_update）│
│  2. mergeAcpSessionConfigIntoMetadata() → metadata.models│
│  3. ★ NEW: 如果 metadata.models 为空                    │
│     → readClaudeSettings() → 提取模型 → 注入 metadata   │
│  4. session.updateMetadata() → 加密发送到服务器           │
└──────────────────────┬──────────────────────────────────┘
                       │ Socket.IO (encrypted)
                       ▼
┌─────────────────────────────────────────────────────────┐
│  App (modelModeOptions.ts)                              │
│                                                         │
│  getAvailableModels(flavor, metadata, t, selectedKey)   │
│    │                                                    │
│    ├─ Priority 1: isRigMetadataV1? → Rig models         │
│    ├─ Priority 2: metadata.models? → ★ 现在会有数据     │
│    │   → mapMetadataOptions() → ModelMode[]             │
│    └─ Priority 3: fallback → hardcoded (不会走到了)     │
└─────────────────────────────────────────────────────────┘
```

### 1.3 关键类型

```typescript
// metadata.models 的结构 (api/types.ts:300)
models?: Array<{
    code: string;          // 模型 ID（如 "qwen3.7-plus"）
    value: string;         // 显示名称（如 "qwen3.7-plus"）
    description?: string | null;
}>;

// currentModelCode — 当前使用的模型
currentModelCode?: string;

// ModelMode (app 端, modelModeOptions.ts:29-39)
type ModelMode = ModeOption & {
    key: string;           // ← 对应 metadata.models[].code
    name: string;          // ← 对应 metadata.models[].value
    description?: string | null;
    providerId?: string;
    providerName?: string;
    // ... 更多可选字段
};
```

---

## 2. Daemon 端改动（runAcp.ts）

### 2.1 新增常量

在文件顶部（import 之后，函数定义之前）添加：

```typescript
// --- Third-party model injection from settings.json ---
// Environment variables that can configure model tiers.
// Order: default first, then specific tiers, then subagent.
const MODEL_ENV_VARS = [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
] as const;
```

### 2.2 新增 import

```typescript
import { readClaudeSettings } from '@/claude/utils/claudeSettings';
```

### 2.3 新增加载函数

在 `runAcp` 函数定义之前（或作为内部函数），添加：

```typescript
/**
 * Extract model configuration from Claude's settings.json.
 *
 * Reads the `env` field and collects all model-related environment
 * variables (ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL, etc.),
 * deduplicates them, and returns the unique list.
 *
 * @returns Unique model names and the current model (ANTHROPIC_MODEL or first).
 */
function extractModelsFromSettings(): { models: string[]; currentModel: string | null } {
    const settings = readClaudeSettings();
    if (!settings?.env || typeof settings.env !== 'object') {
        return { models: [], currentModel: null };
    }

    const env = settings.env as Record<string, unknown>;

    // Collect model names from known env vars
    const configuredModels: string[] = [];
    for (const key of MODEL_ENV_VARS) {
        const value = env[key];
        if (typeof value === 'string' && value.length > 0) {
            configuredModels.push(value);
        }
    }

    // Deduplicate while preserving order
    const uniqueModels = [...new Set(configuredModels)];

    // Current model: prefer ANTHROPIC_MODEL, fallback to first unique
    const currentModel = (typeof env.ANTHROPIC_MODEL === 'string' && env.ANTHROPIC_MODEL.length > 0)
        ? env.ANTHROPIC_MODEL as string
        : uniqueModels[0] ?? null;

    return { models: uniqueModels, currentModel };
}
```

### 2.4 注入时机

注入发生在 `onBackendMessage` 处理完 `emitInitialSessionMetadata` 的合成事件之后。

**关键问题**：合成事件是通过 `backend.emit()` 同步发射的，而 `onBackendMessage` 是异步回调。所以注入点应该在 `backend.startSession()` 返回之后、main message loop 开始之前。

**方案**：在 `backend.startSession()` 之后、进入消息循环之前，检查 `metadata.models` 是否为空，如果为空则注入。

具体位置：在 `runAcp.ts` 中，`backend.startSession()` 调用之后（约 line 893），添加注入逻辑。

```typescript
// After backend.startSession() returns (around line 893)
await backend.startSession();

// --- Inject models from settings.json if ACP didn't provide any ---
{
    const currentMeta = session.getMetadata();
    if (!currentMeta.models || currentMeta.models.length === 0) {
        const { models: settingsModels, currentModel } = extractModelsFromSettings();
        if (settingsModels.length > 0) {
            session.updateMetadata((meta) => ({
                ...meta,
                models: settingsModels.map((model) => ({
                    code: model,
                    value: model,
                })),
                ...(currentModel ? { currentModelCode: currentModel } : {}),
            }));
            logger.debug(
                `[runAcp] Injected ${settingsModels.length} model(s) from settings.json: ${settingsModels.join(', ')}`,
            );
        }
    }
}
```

**注意**：需要确认 `session.getMetadata()` 方法是否存在。从探索结果看，`session.updateMetadata()` 接受一个 callback `(currentMetadata) => newMetadata`，所以可以直接在 callback 中检查：

```typescript
// Alternative: inject via updateMetadata callback (safer, atomic)
session.updateMetadata((meta) => {
    // Only inject if ACP didn't provide models
    if (meta.models && meta.models.length > 0) {
        return meta; // ACP already provided models, don't override
    }

    const { models: settingsModels, currentModel } = extractModelsFromSettings();
    if (settingsModels.length === 0) {
        return meta; // No models in settings.json either
    }

    logger.debug(
        `[runAcp] Injected ${settingsModels.length} model(s) from settings.json: ${settingsModels.join(', ')}`,
    );

    return {
        ...meta,
        models: settingsModels.map((model) => ({
            code: model,
            value: model,
        })),
        ...(currentModel ? { currentModelCode: currentModel } : {}),
    };
});
```

### 2.5 与 ACP 数据的优先级

优先级：
1. **ACP `config_options_update`**（最高）— 如果 agent 后续报告了模型列表，`mergeAcpSessionConfigIntoMetadata` 会覆盖 `metadata.models`
2. **ACP `models_update`**（遗留）— 同上
3. **settings.json 注入**（fallback）— 仅在 ACP 未提供时生效

这确保了向后兼容：如果未来 Claude Code 开始通过 ACP 报告模型列表，注入的数据会自动被覆盖。

---

## 3. App 端改动（modelModeOptions.ts）

### 3.1 为什么还需要改 App 端？

方案 B 解决了 `metadata.models` 为空的问题。但还有一个边界情况：

- 如果 daemon 端的 settings.json 注入因为某种原因失败（settings.json 不存在、env 为空等），`metadata.models` 仍然为空
- App 会走到 Priority 3（hardcoded fallback）
- `includeConfiguredModel()` 排除 `claude` flavor，导致自定义模型不显示

**修复 `includeConfiguredModel()`** 是防御性编程，确保即使 daemon 注入失败，App 端也能正确显示当前模型。

### 3.2 改动内容

**文件**: `packages/happy-app/sources/components/modelModeOptions.ts`
**位置**: line 193

```typescript
// Before:
(flavor !== 'codex' && flavor !== 'agy')

// After:
(flavor !== 'codex' && flavor !== 'agy' && flavor !== 'claude')
```

这 1 行改动让 `claude` flavor 也能追加自定义模型到列表中。

---

## 4. 完整行为矩阵

### 4.1 正常流程（方案 B 生效后）

| 步骤 | 组件 | 行为 |
|------|------|------|
| 1 | Daemon | `createSessionMetadata()` 创建空 metadata |
| 2 | Daemon | `backend.startSession()` → ACP agent 启动 |
| 3 | Daemon | `emitInitialSessionMetadata()` → 合成事件 |
| 4 | Daemon | `onBackendMessage` 处理合成事件 → `mergeAcpSessionConfigIntoMetadata()` |
| 5 | Daemon | `metadata.models` 为空（Claude Code 不提供模型列表） |
| 6 | **Daemon** | **★ NEW: `extractModelsFromSettings()` → 注入 metadata.models** |
| 7 | Daemon | `session.updateMetadata()` → 加密发送到服务器 |
| 8 | Server | 广播 `update-session` 事件 |
| 9 | App | 解密 metadata → `getAvailableModels()` |
| 10 | App | Priority 2: `metadata.models` 有数据 → `mapMetadataOptions()` |
| 11 | App | UI 显示用户配置的模型列表 |

### 4.2 场景覆盖

| 场景 | metadata.models | UI 显示 | 说明 |
|------|----------------|---------|------|
| settings.json 配置 1 个模型 | `[{code: "qwen3.7-plus", value: "qwen3.7-plus"}]` | 1 个模型 | 当前配置 |
| settings.json 配置 3 个模型 | `[{code: "qwen3.7-plus"}, {code: "kimi-k2.5"}, {code: "glm-5"}]` | 3 个模型 | 多模型配置 |
| settings.json 配置 5 个模型（有重复） | 去重后 4 个 | 4 个模型 | 自动去重 |
| settings.json 无模型配置 | 空 | 5 个 Anthropic（hardcoded） | fallback |
| settings.json 不存在 | 空 | 5 个 Anthropic（hardcoded） | fallback |
| ACP 后续报告模型列表 | ACP 数据覆盖 | ACP 报告的模型 | 向后兼容 |
| Rig session | N/A | Rig 模型列表 | Priority 1 不受影响 |

### 4.3 模型切换回传

```
用户在 App 中选择模型
    │
    ▼
onModelModeChange(model)
    → sessionSetAgentModes({ modelMode: model.key })
    → update-metadata socket event → server → daemon
    │
    ▼
Daemon 收到 metadata 更新
    → 下一条用户消息附带 meta.model = model.key
    → switchModelIfRequested(model.key)
    → backend.setSessionConfigOption() 或 backend.setSessionModel()
```

**注意**：如果 ACP 没有提供 `modelSelector`（`config_options_update`），`switchModelIfRequested` 走 legacy path `setSessionModel()`。这在第三方模型下可能不生效（agent 端不感知模型切换）。这是一个已知限制，需要 ACP 上游支持。

---

## 5. 实施步骤

### Step 1: Daemon 端注入

**文件**: `packages/happy-cli/src/agent/acp/runAcp.ts`

1. 添加 import: `import { readClaudeSettings } from '@/claude/utils/claudeSettings';`
2. 添加常量: `MODEL_ENV_VARS`
3. 添加函数: `extractModelsFromSettings()`
4. 在 `backend.startSession()` 之后注入逻辑

### Step 2: App 端防御性修复

**文件**: `packages/happy-app/sources/components/modelModeOptions.ts`

1. 修改 `includeConfiguredModel()` 的条件判断（line 193）

### Step 3: 验证

1. 使用当前配置（所有层级 = qwen3.7-plus）启动 session
2. 检查 App 模型选择器是否显示 qwen3.7-plus（而非 Anthropic 模型）
3. 临时修改 settings.json 配置多个模型，验证多模型显示
4. 恢复 settings.json

---

## 6. 验证计划

### 6.1 单元测试

在 `runAcp.ts` 旁边创建 `extractModelsFromSettings.test.ts`（或在现有测试文件中）：

```typescript
describe('extractModelsFromSettings', () => {
    it('returns empty when settings.json does not exist', () => { ... });
    it('returns empty when env field is missing', () => { ... });
    it('extracts single model from ANTHROPIC_MODEL', () => { ... });
    it('extracts multiple models from all env vars', () => { ... });
    it('deduplicates identical models', () => { ... });
    it('sets currentModel to ANTHROPIC_MODEL', () => { ... });
    it('falls back currentModel to first unique model', () => { ... });
});
```

### 6.2 端到端测试

1. **单模型测试**:
   - settings.json 所有层级 = qwen3.7-plus
   - 启动 Happy session
   - 检查 App 模型选择器 → 应显示 1 个模型: qwen3.7-plus

2. **多模型测试**:
   - settings.json 配置 qwen3.7-plus + kimi-k2.5 + glm-5
   - 启动 Happy session
   - 检查 App 模型选择器 → 应显示 3 个模型

3. **Fallback 测试**:
   - 删除 settings.json（或清空 env 字段）
   - 启动 Happy session
   - 检查 App 模型选择器 → 应显示 5 个 Anthropic 硬编码模型

4. **模型切换测试**:
   - 配置多个模型
   - 在 App 中切换模型
   - 检查 metadata.modelMode 是否更新
   - 发送消息，检查 agent 是否使用了新模型

---

## 7. 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| `session.getMetadata()` 不存在 | 低 | 低 | 使用 `updateMetadata` callback，在 callback 中检查当前 metadata |
| settings.json 读取失败 | 低 | 低 | `readClaudeSettings()` 已有 try-catch，返回 null |
| 注入时机不对（在 ACP 事件之前） | 中 | 中 | 确保注入在 `backend.startSession()` 之后，此时合成事件已处理 |
| ACP 后续覆盖注入的数据 | 无 | 无 | 这是期望行为 — ACP 数据优先级更高 |
| 环境变量名变化 | 低 | 中 | 使用常量数组，易于维护 |
| 模型切换在 agent 端不生效 | 中 | 中 | 已知限制，需 ACP 上游支持 |

---

## 8. 改动量估算（初始设计 vs 实际）

### 初始设计（错误）

| 文件 | 改动行数 | 说明 |
|------|---------|------|
| `runAcp.ts` | +35 行 | import(1) + 常量(7) + 函数(25) + 注入逻辑(7) |
| `modelModeOptions.ts` | 1 行 | 条件判断修改 |
| **总计** | **~36 行** | |

### 实际改动（修复后）

| 文件 | 改动行数 | 说明 |
|------|---------|------|
| `claudeSettings.ts` | +36 行 | 新增 `extractModelsFromSettings()` 共享函数 |
| `runClaude.ts` | +30 行 | import + metadata 注入 + 模型覆盖 + 消息级保护 |
| `runAcp.ts` | +2 行 / -35 行 | 改用共享函数，移除重复代码 |
| `modelModeOptions.ts` | 1 行 | 防御性修复 `claude` flavor |
| **总计** | **~34 行净增** | |

---

## 9. 实施复盘（2026-10-03）

### 9.1 过程时间线

| 阶段 | 产出 | 评估 |
|------|------|------|
| 需求分析 | `README.md`, `PRD.md` | ✅ 准确识别了问题 |
| 技术分析 | `TECHNICAL_ANALYSIS.md` | ⚠️ 正确识别 ACP 不提供模型列表，但**没有验证 Claude 模式的实际代码路径** |
| 可行性验证 | 脚本验证 `extractModelsFromSettings()` | ✅ 函数逻辑正确，但**只验证了函数本身，没验证调用路径** |
| 概要设计 | `SUMMARY_DESIGN.md` — 5 方案对比 | ⚠️ 方案 B 逻辑正确，但**假设了错误的注入位置** |
| 详细设计 | `DETAILED_DESIGN.md` | ❌ **注入位置错误** — 放在 `runAcp.ts`，但 Claude 模式走 `runClaude.ts` |
| 第一次实施 | 修改 `runAcp.ts` + `modelModeOptions.ts` | ❌ 改错了文件，daemon 重启后无效 |
| 调试定位 | 通过 session 日志追踪代码路径 | ✅ 发现 Claude 模式走 `runClaude.ts` → `loop.ts` → SDK |
| 第二次实施 | 注入到 `runClaude.ts` + 模型覆盖 | ⚠️ 注入生效，但**忽略了消息元数据也会覆盖模型** |
| 最终修复 | 消息处理中保护 settings.json 模型 | ✅ 三层保护：初始化覆盖 + metadata 注入 + 消息级忽略 |

### 9.2 三个关键错误

#### 错误 1：没有追踪实际代码路径

- **做了什么**: 深入分析了 ACP 协议层（`runAcp.ts`、`sessionConfigMetadata.ts`、`AcpBackend.ts`）
- **没做什么**: 从未确认 Claude 模式是否走 ACP 代码路径
- **实际情况**: Claude 模式走 `index.ts` → `runClaude.ts` → `loop.ts` → Claude SDK，完全不经过 ACP
- **发现方式**: 通过 session 日志（`pid-32414.log`）发现没有任何 `runAcp` 相关日志，追踪到 `runClaude.ts`

**教训**: 分析架构时必须从入口（`index.ts`）追踪到终点，不能假设。应该先画完整的调用链路图，再设计解决方案。

#### 错误 2：没有端到端验证

- **做了什么**: 用 Node.js 脚本验证 `extractModelsFromSettings()` 函数逻辑正确
- **没做什么**: 没有验证函数在正确的时机被调用、在正确的代码路径上
- **实际情况**: 函数逻辑正确，但放在了一个永远不会被 Claude 模式执行的文件里

**教训**: 验证必须覆盖完整链路（从触发条件 → 函数调用 → 数据流 → UI 表现），不只是单个函数的单元测试。

#### 错误 3：忽略了消息级模型覆盖

- **做了什么**: 在 `runClaude.ts` 中覆盖了 `options.model`
- **没做什么**: 没有追踪所有修改 `currentModel` 的代码路径
- **实际情况**: app 发送的每条消息都带有 `meta.model`（硬编码模型名），`loop` 的消息处理会用消息级覆盖取代会话级设置
- **日志证据**: `[CLAUDE] Overriding model...using qwen3.7-plus` 之后紧跟 `[loop] Model updated from user message: claude-fable-5-1`

**教训**: 修改状态变量时，必须搜索所有写入该变量的代码位置，确保没有被后续逻辑覆盖。

### 9.3 根本原因

整个过程中最大的问题是：**在分析和设计阶段过于关注协议层（ACP/metadata），而忽视了实际执行路径（runClaude → loop → SDK）**。

这导致：
- 所有文档逻辑自洽，但建立在错误的前提上
- 可行性验证通过了，但验证的是错误的代码路径
- 第一性原理分析得出了正确的方法论，但应用到了错误的位置

### 9.4 正确做法（如果重来）

1. **第一步**: 运行一次真实 session，用日志追踪完整数据流
   ```
   app picker → spawn RPC → daemon spawn CLI → index.ts → runClaude.ts
   → loop.ts → Claude SDK → API endpoint
   ```
2. **第二步**: 确认每个环节传递了什么数据、在哪里决策
3. **第三步**: 找到问题的**实际**注入点（不是假设的注入点）
4. **第四步**: 设计解决方案并端到端验证

### 9.5 最终修复的三层保护

```
Layer 1: runClaude.ts 初始化
  → extractModelsFromSettings() → 覆盖 options.model
  → 效果: Claude SDK 使用正确的模型

Layer 2: runClaude.ts metadata 注入
  → session.updateMetadata() → 注入 models 到 metadata
  → 效果: app 端模型选择器收到正确模型列表

Layer 3: loop.ts 消息处理
  → 如果 settingsJsonModel 存在，忽略 message.meta.model
  → 效果: app 发来的硬编码模型名不会覆盖设置
```
