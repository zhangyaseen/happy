# 深度代码分析：settings.json 环境变量覆盖问题

## 一、当前架构分析

### 1.1 Settings 文件流转路径

```
用户配置 ~/.claude/settings.json
    ↓ (包含 env, permissions, modelSettings 等)
    
Happy CLI 启动
    ↓
runClaude.ts:523 → generateHookSettingsFile(port)
    ↓ (生成临时文件，只包含 hooks)
    ↓ 临时文件内容: { hooks: { SessionStart: [...] } }
    
runClaude.ts:1004 → 传递 hookSettingsPath 给 loop
    ↓
loop.ts:71 → 传递给 claudeRemote/claudeLocal
    ↓
claudeRemote.ts:144 → 设置 settingsPath: opts.hookSettingsPath
    ↓
query.ts:44 → 设置 SDK 选项 settings: opts?.settingsPath
    ↓
Claude Agent SDK → 使用临时文件替代 ~/.claude/settings.json
    ↓
Claude 子进程 → 读取临时文件，缺少 env 字段
    ↓
CLAUDE_CODE_MAX_CONTEXT_TOKENS 等配置丢失
```

### 1.2 环境变量流转路径

```
方式 1: 命令行 --claude-env KEY=VALUE
    ↓
index.ts:661-669 → 解析到 options.claudeEnvVars
    ↓
runClaude.ts:248 → 传递给 loop
    ↓
claudeRemote.ts:87-91 → 写入 process.env
    ↓
query.ts:63-71 → 复制到 sdkOptions.env
    ↓
SDK → 传递给子进程
    ↓
✅ 生效

方式 2: Daemon 进程环境
    ↓
process.env (daemon 启动时的环境)
    ↓
query.ts:63-71 → 复制到 sdkOptions.env
    ↓
SDK → 传递给子进程
    ↓
✅ 生效（如果 daemon 启动时有这些变量）

方式 3: settings.json env 字段
    ↓
❌ Happy 不读取 settings.json 的 env 字段
❌ 不传递给子进程
❌ 不生效
```

### 1.3 关键代码位置

| 文件 | 行号 | 作用 | 问题 |
|------|------|------|------|
| `generateHookSettings.ts` | 32-46 | 生成临时 settings 文件 | 只写入 hooks，不合并用户配置 |
| `runClaude.ts` | 523 | 调用 generateHookSettingsFile | 生成的文件缺少用户配置 |
| `query.ts` | 44 | 传递 settings 给 SDK | 传递的是不完整的临时文件 |
| `query.ts` | 63-71 | 构建 env 传递给 SDK | 只复制 process.env，不读取 settings.json |
| `claudeRemote.ts` | 87-91 | 设置 claudeEnvVars | 只处理显式传入的变量 |
| `claudeLocal.ts` | 249 | 传递 --settings 参数 | 传递的是不完整的临时文件 |

### 1.4 SDK settings 选项行为

根据 `@anthropic-ai/claude-agent-sdk/sdk.d.ts`：

```typescript
settings?: Settings | string;
// 可以是：
// 1. Settings 对象（内联配置）
// 2. 字符串（settings 文件路径）

// 当提供 settings 时，SDK 会：
// - 使用提供的 settings 替代默认的 ~/.claude/settings.json
// - 不会合并，而是完全替换
```

**关键发现**：SDK 的 `settings` 选项是**替换**而非**合并**行为。

---

## 二、解决方案分析

### 方案 A：合并 Settings 文件（推荐）

#### 实现思路

修改 `generateHookSettingsFile()` 函数，在生成临时文件时：
1. 读取用户的 `~/.claude/settings.json`
2. 深合并用户配置和 hooks 配置
3. 写入临时文件

#### 代码示例

```typescript
// generateHookSettings.ts
import { readClaudeSettings } from './claudeSettings';

export function generateHookSettingsFile(port: number): string {
    const hooksDir = join(configuration.happyHomeDir, 'tmp', 'hooks');
    mkdirSync(hooksDir, { recursive: true });

    const filename = `session-hook-${process.pid}.json`;
    const filepath = join(hooksDir, filename);

    const forwarderScript = resolve(projectPath(), 'scripts', 'session_hook_forwarder.cjs');
    const hookCommand = `node "${forwarderScript}" ${port}`;

    // 1. 读取用户 settings.json
    const userSettings = readClaudeSettings() || {};
    
    // 2. 生成 Happy hooks 配置
    const happyHooks = {
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
    };

    // 3. 深合并配置
    const mergedSettings = deepMergeSettings(userSettings, {
        hooks: happyHooks
    });

    writeFileSync(filepath, JSON.stringify(mergedSettings, null, 2));
    logger.debug(`[generateHookSettings] Created merged settings file: ${filepath}`);
    logger.debug(`[generateHookSettings] User settings keys: ${Object.keys(userSettings).join(', ')}`);

    return filepath;
}

// 深合并函数
function deepMergeSettings(base: any, override: any): any {
    const result = { ...base };
    
    for (const key in override) {
        if (key === 'hooks' && base.hooks) {
            // 特殊处理 hooks：合并而不是替换
            result.hooks = { ...base.hooks };
            for (const hookEvent in override.hooks) {
                if (base.hooks[hookEvent]) {
                    // 合并同一事件的 hooks 数组
                    result.hooks[hookEvent] = [
                        ...base.hooks[hookEvent],
                        ...override.hooks[hookEvent]
                    ];
                } else {
                    result.hooks[hookEvent] = override.hooks[hookEvent];
                }
            }
        } else {
            result[key] = override[key];
        }
    }
    
    return result;
}
```

#### 预期效果

✅ **完全生效**：用户的所有 settings.json 配置都会被应用
- `env.CLAUDE_CODE_MAX_CONTEXT_TOKENS` → contextWindow: 1000000
- `env.API_TIMEOUT_MS` → 自定义超时
- `env.CLAUDE_CODE_EFFORT_LEVEL` → 模型努力级别
- `permissions` → 权限配置
- `modelSettings` → 模型特定配置
- 用户自定义 hooks → 与 Happy hooks 共存

✅ **向后兼容**：没有用户 settings.json 时，行为与当前一致

✅ **Hook 共存**：用户的 SessionStart hooks 和 Happy 的 hooks 都会执行

#### 成本和风险

| 项目 | 评估 | 说明 |
|------|------|------|
| **开发成本** | 低 | 只需修改 1 个文件（generateHookSettings.ts） |
| **测试成本** | 中 | 需要测试各种 settings.json 配置场景 |
| **风险** | 低 | 深合并逻辑需要仔细处理边界情况 |
| **性能影响** | 可忽略 | 只在 session 启动时读取一次 |
| **复杂度** | 中 | 需要实现深合并逻辑 |

#### 影响范围

**修改文件**：
- `packages/happy-cli/src/claude/utils/generateHookSettings.ts`（主要修改）

**影响功能**：
- ✅ SessionStart hook 仍然工作
- ✅ 会话追踪功能正常
- ✅ 用户配置生效
- ⚠️ 需要验证 hooks 合并顺序（用户 hooks 先执行还是 Happy hooks 先执行）

**不影响的代码**：
- `claudeRemote.ts` — 无需修改
- `claudeLocal.ts` — 无需修改
- `query.ts` — 无需修改
- SDK 调用逻辑 — 无需修改

#### 验证方法

```bash
# 1. 配置 settings.json
cat > ~/.claude/settings.json << 'EOF'
{
  "env": {
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000",
    "API_TIMEOUT_MS": "1800000"
  }
}
EOF

# 2. 启动 Happy 会话
happy claude

# 3. 检查日志
grep "contextWindow" ~/.happy/logs/*.log
# 期望输出: "contextWindow": 1000000

# 4. 验证 hook 工作
grep "SessionStart" ~/.happy/logs/*.log
# 期望看到 Happy 的 hook 执行记录
```

---

### 方案 B：通过环境变量传递 settings.json env

#### 实现思路

不修改 settings 文件，而是在启动 Claude 时：
1. 读取 `~/.claude/settings.json` 的 `env` 字段
2. 将 env 字段合并到 `process.env`
3. 通过 SDK 的 `env` 选项传递给子进程

#### 代码示例

```typescript
// runClaude.ts
import { readClaudeSettings } from '@/claude/utils/claudeSettings';

// 在启动 session 前
const userSettings = readClaudeSettings();
if (userSettings?.env && typeof userSettings.env === 'object') {
    // 将 settings.json 的 env 合并到 process.env
    Object.entries(userSettings.env).forEach(([key, value]) => {
        if (typeof value === 'string' && !process.env[key]) {
            process.env[key] = value;
            logger.debug(`[runClaude] Set env from settings.json: ${key}`);
        }
    });
}

// 然后正常启动 session...
```

或者在 `query.ts` 中：

```typescript
// query.ts
import { readClaudeSettings } from '../utils/claudeSettings';

export function query(params: { prompt: QueryPrompt; options?: QueryOptions }): Query {
    const opts = params.options;
    
    // ... 其他代码 ...
    
    // 构建 env
    const env: Record<string, string> = {}
    
    // 1. 先读取 settings.json 的 env
    const userSettings = readClaudeSettings();
    if (userSettings?.env && typeof userSettings.env === 'object') {
        for (const [key, value] of Object.entries(userSettings.env)) {
            if (typeof value === 'string') {
                env[key] = value;
            }
        }
    }
    
    // 2. 然后复制 process.env（会覆盖 settings.json 的同名变量）
    for (const [key, value] of Object.entries(process.env)) {
        if (typeof value === 'string') env[key] = value
    }
    
    // 3. 最后应用 opts.claudeEnvVars（最高优先级）
    if (opts?.claudeEnvVars) {
        Object.entries(opts.claudeEnvVars).forEach(([key, value]) => {
            env[key] = value;
        });
    }
    
    env.CLAUDE_CODE_ENTRYPOINT = resolveHappyEntrypoint(env.CLAUDE_CODE_ENTRYPOINT)
    sdkOptions.env = env
    
    // ... 其他代码 ...
}
```

#### 预期效果

✅ **env 字段生效**：`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 等环境变量会被应用
✅ **contextWindow**: 应该显示 1000000
✅ **API 超时**: 应该使用自定义值

❌ **其他配置不生效**：
- `permissions` — 不会生效（需要通过 settings 文件）
- `modelSettings` — 不会生效（需要通过 settings 文件）
- 用户自定义 hooks — 不会生效

#### 成本和风险

| 项目 | 评估 | 说明 |
|------|------|------|
| **开发成本** | 低 | 修改 1-2 个文件 |
| **测试成本** | 低 | 只需测试 env 变量 |
| **风险** | 低 | 逻辑简单，边界情况少 |
| **性能影响** | 可忽略 | 只在 session 启动时读取一次 |
| **复杂度** | 低 | 简单的环境变量合并 |

#### 影响范围

**修改文件**：
- `packages/happy-cli/src/claude/runClaude.ts`（方案 B.1）
- 或 `packages/happy-cli/src/claude/sdk/query.ts`（方案 B.2）

**影响功能**：
- ✅ env 变量生效
- ❌ permissions、modelSettings 等仍不生效
- ✅ Hook 功能不受影响

**优先级问题**：
需要确定环境变量的优先级：
1. `process.env`（daemon 环境）
2. `settings.json` env 字段
3. `--claude-env` 命令行参数
4. `opts.claudeEnvVars`（代码传入）

建议优先级：命令行 > code > settings.json > process.env

---

### 方案 C：使用 SDK 的内联 settings 对象

#### 实现思路

不使用文件路径，而是直接在代码中构建 settings 对象传递给 SDK：

```typescript
// query.ts
import { readClaudeSettings } from '../utils/claudeSettings';

export function query(params: { prompt: QueryPrompt; options?: QueryOptions }): Query {
    const opts = params.options;
    
    // 1. 读取用户 settings.json
    const userSettings = readClaudeSettings() || {};
    
    // 2. 构建 Happy hooks
    const happyHooks = {
        SessionStart: [{
            matcher: "*",
            hooks: [{
                type: "command",
                command: `node "${resolve(projectPath(), 'scripts', 'session_hook_forwarder.cjs')}" ${opts.hookServerPort}`
            }]
        }]
    };
    
    // 3. 合并 settings
    const mergedSettings = {
        ...userSettings,
        hooks: {
            ...userSettings.hooks,
            ...happyHooks
        }
    };
    
    // 4. 传递给 SDK（内联对象，不需要文件）
    const sdkOptions: Options = {
        // ... 其他选项 ...
        settings: mergedSettings,  // 直接传对象，不是路径
    };
    
    // ... 其他代码 ...
}
```

#### 预期效果

✅ **完全生效**：与方案 A 相同
✅ **不需要临时文件**：减少文件 I/O
✅ **更清晰**：逻辑集中在一个地方

#### 成本和风险

| 项目 | 评估 | 说明 |
|------|------|------|
| **开发成本** | 中 | 需要修改 query.ts，传递 hookServerPort |
| **测试成本** | 中 | 需要测试各种配置场景 |
| **风险** | 中 | 需要修改多个函数的签名 |
| **性能影响** | 可忽略 | 内存中合并，无文件 I/O |
| **复杂度** | 中 | 需要传递额外参数 |

#### 影响范围

**修改文件**：
- `packages/happy-cli/src/claude/sdk/query.ts`（主要修改）
- `packages/happy-cli/src/claude/sdk/types.ts`（添加 hookServerPort 字段）
- `packages/happy-cli/src/claude/claudeRemote.ts`（传递 hookServerPort）
- `packages/happy-cli/src/claude/claudeLocal.ts`（传递 hookServerPort）
- `packages/happy-cli/src/claude/loop.ts`（传递 hookServerPort）
- `packages/happy-cli/src/claude/runClaude.ts`（传递 hookServerPort）

**影响功能**：
- ✅ 所有配置生效
- ✅ 不需要临时文件
- ⚠️ 函数签名变化，影响面较大

---

### 方案 D：不传递 settings，让 Claude 读取默认配置

#### 实现思路

完全不传递 `settings` 选项给 SDK，让 Claude 子进程自动读取 `~/.claude/settings.json`。Happy 的 hooks 通过其他方式注入（如命令行参数或环境变量）。

#### 代码示例

```typescript
// query.ts
const sdkOptions: Options = {
    cwd: opts?.cwd,
    resume: opts?.resume,
    // ... 其他选项 ...
    // 不设置 settings，让 SDK 使用默认的 ~/.claude/settings.json
    // settings: opts?.settingsPath,  // 删除这行
};

// 通过其他方式注入 Happy hooks
// 方式 1: 命令行参数（如果 SDK 支持）
// 方式 2: 环境变量（如果 SDK 支持）
// 方式 3: 项目级 .happy/settings.json（如果 SDK 支持项目级配置）
```

#### 预期效果

✅ **用户配置完全生效**：Claude 读取默认的 settings.json
✅ **简化代码**：不需要生成临时文件

❌ **Happy hooks 无法注入**：除非 SDK 支持其他注入方式
❌ **会话追踪失效**：SessionStart hook 无法工作

#### 成本和风险

| 项目 | 评估 | 说明 |
|------|------|------|
| **开发成本** | 低 | 删除代码即可 |
| **测试成本** | 低 | 简单验证 |
| **风险** | 高 | 会话追踪功能失效 |
| **性能影响** | 无 | — |
| **复杂度** | 低 | — |

#### 影响范围

**修改文件**：
- `packages/happy-cli/src/claude/sdk/query.ts`（删除 settings 传递）
- `packages/happy-cli/src/claude/claudeRemote.ts`（删除 hookSettingsPath 参数）
- `packages/happy-cli/src/claude/claudeLocal.ts`（删除 --settings 参数）

**影响功能**：
- ✅ 用户配置生效
- ❌ 会话追踪失效（重大功能损失）
- ❌ Hook 功能失效

**结论**：此方案不可行，除非找到其他注入 hooks 的方式。

---

## 三、方案对比总结

| 方案 | 效果 | 开发成本 | 风险 | 影响范围 | 推荐度 |
|------|------|----------|------|----------|--------|
| **A: 合并 Settings 文件** | ⭐⭐⭐⭐⭐ | 低 | 低 | 小（1 个文件） | ⭐⭐⭐⭐⭐ **推荐** |
| **B: 环境变量传递** | ⭐⭐⭐ | 低 | 低 | 小（1-2 个文件） | ⭐⭐⭐⭐ |
| **C: 内联 Settings 对象** | ⭐⭐⭐⭐⭐ | 中 | 中 | 大（6+ 个文件） | ⭐⭐⭐ |
| **D: 不传递 Settings** | ⭐⭐ | 低 | 高 | 中 | ⭐⭐ 不推荐 |

### 详细对比

#### 功能完整性

| 功能 | 方案 A | 方案 B | 方案 C | 方案 D |
|------|--------|--------|--------|--------|
| env 变量生效 | ✅ | ✅ | ✅ | ✅ |
| permissions 生效 | ✅ | ❌ | ✅ | ✅ |
| modelSettings 生效 | ✅ | ❌ | ✅ | ✅ |
| 用户 hooks 生效 | ✅ | ❌ | ✅ | ✅ |
| Happy hooks 生效 | ✅ | ✅ | ✅ | ❌ |
| 会话追踪 | ✅ | ✅ | ✅ | ❌ |

#### 实施复杂度

| 方面 | 方案 A | 方案 B | 方案 C | 方案 D |
|------|--------|--------|--------|--------|
| 修改文件数 | 1 | 1-2 | 6+ | 3 |
| 新增代码行数 | ~50 | ~20 | ~80 | -10 |
| 需要深合并 | ✅ | ❌ | ✅ | ❌ |
| 需要修改函数签名 | ❌ | ❌ | ✅ | ✅ |
| 需要测试场景 | 中 | 少 | 多 | 少 |

---

## 四、推荐方案：方案 A（合并 Settings 文件）

### 选择理由

1. **功能完整**：所有用户配置都能生效
2. **成本低**：只修改 1 个文件
3. **风险小**：逻辑清晰，边界情况可控
4. **向后兼容**：没有用户配置时行为不变
5. **影响面小**：不需要修改函数签名

### 实施步骤

1. **修改 `generateHookSettings.ts`**：
   - 导入 `readClaudeSettings`
   - 读取用户 settings.json
   - 实现深合并逻辑
   - 写入合并后的配置

2. **测试验证**：
   - 测试单模型配置（contextWindow）
   - 测试多配置场景（env、permissions）
   - 测试用户 hooks 共存
   - 测试无用户配置时的 fallback

3. **文档更新**：
   - 更新 PRD.md 记录实施结果
   - 添加测试报告

### 预期结果

实施后，用户配置将完全生效：

```json
// 用户 ~/.claude/settings.json
{
  "env": {
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000",
    "API_TIMEOUT_MS": "1800000",
    "CLAUDE_CODE_EFFORT_LEVEL": "max"
  }
}
```

**日志输出**：
```json
{
  "contextWindow": 1000000,  // ✅ 从 200K 变为 1M
  "maxOutputTokens": 32000,
  "canonicalModel": "qwen3.7-plus"
}
```

---

## 五、备选方案：方案 B（环境变量传递）

### 适用场景

如果只需要 env 变量生效，不需要 permissions、modelSettings 等配置，可以选择方案 B。

### 优势

- 更简单，代码更少
- 不需要深合并逻辑
- 风险更低

### 劣势

- 功能不完整（permissions、modelSettings 不生效）
- 需要确定优先级规则

### 实施建议

如果选择方案 B，建议在 `query.ts` 中实现，这样可以统一管理环境变量：

```typescript
// 优先级：命令行 > code > settings.json > process.env
```

---

## 六、后续优化建议

### 6.1 配置验证

无论选择哪个方案，都建议添加配置验证：

```typescript
function validateSettings(settings: any): void {
    // 验证 env 字段类型
    if (settings.env && typeof settings.env !== 'object') {
        logger.warn('[Settings] env field should be an object');
    }
    
    // 验证 hooks 字段结构
    if (settings.hooks) {
        for (const [event, hooks] of Object.entries(settings.hooks)) {
            if (!Array.isArray(hooks)) {
                logger.warn(`[Settings] hooks.${event} should be an array`);
            }
        }
    }
}
```

### 6.2 配置日志

添加详细的配置日志，便于调试：

```typescript
logger.debug(`[Settings] User settings loaded: ${Object.keys(userSettings).join(', ')}`);
logger.debug(`[Settings] Merged settings keys: ${Object.keys(mergedSettings).join(', ')}`);
logger.debug(`[Settings] Env vars from settings.json: ${Object.keys(userSettings.env || {}).join(', ')}`);
```

### 6.3 配置缓存

如果性能成为问题，可以缓存 settings.json 的读取结果：

```typescript
let cachedSettings: any = null;
let cacheTimestamp = 0;
const CACHE_TTL = 60000; // 1 分钟

function getCachedSettings(): any {
    const now = Date.now();
    if (!cachedSettings || now - cacheTimestamp > CACHE_TTL) {
        cachedSettings = readClaudeSettings();
        cacheTimestamp = now;
    }
    return cachedSettings;
}
```

---

## 七、结论

**推荐方案 A**：合并 Settings 文件

- 功能最完整
- 成本最低
- 风险最小
- 影响面最小

**实施优先级**：
1. 立即实施方案 A
2. 验证 contextWindow 是否变为 1M
3. 验证其他配置是否生效
4. 更新文档记录实施结果
