# 概要设计文档：settings.json 配置合并方案

> **状态**: 待评审
> **日期**: 2026-10-03
> **关联**: [PRD.md](./PRD.md) · [TECHNICAL_ANALYSIS.md](./TECHNICAL_ANALYSIS.md)

---

## 1. 设计概述

### 1.1 问题陈述

Happy CLI 在启动 Claude 会话时，生成的临时 settings 文件**覆盖**了用户的 `~/.claude/settings.json`，导致用户配置的环境变量（如 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`）不生效。

### 1.2 设计目标

- **GD-1**: 用户的 `~/.claude/settings.json` 配置完全生效
- **GD-2**: Happy 的 SessionStart hook 继续正常工作
- **GD-3**: 用户自定义 hooks 与 Happy hooks 共存
- **GD-4**: 向后兼容（无用户配置时行为不变）
- **GD-5**: 最小化代码改动范围

### 1.3 设计约束

- 只修改 1 个核心文件（`generateHookSettings.ts`）
- 不修改现有函数签名
- 不引入新的依赖
- 保持向后兼容

---

## 2. 架构设计

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    用户配置层                             │
│  ~/.claude/settings.json                                │
│  ├─ env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000" } │
│  ├─ permissions: { ... }                                │
│  ├─ modelSettings: { ... }                              │
│  └─ hooks: { SessionStart: [ ... ] }                    │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│              Happy CLI 配置合并层                         │
│                                                         │
│  generateHookSettingsFile(port: number)                 │
│  ├─ 1. readClaudeSettings() → 读取用户配置              │
│  ├─ 2. 生成 Happy hooks 配置                            │
│  ├─ 3. deepMergeSettings(userSettings, happyHooks)      │
│  └─ 4. 写入临时文件                                     │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│              Claude Agent SDK                            │
│                                                         │
│  query({                                                │
│    settings: '/path/to/merged-settings.json',           │
│    env: { ... }                                         │
│  })                                                     │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│              Claude 子进程                               │
│                                                         │
│  读取合并后的 settings 文件：                            │
│  ├─ env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = 1000000 ✅    │
│  ├─ permissions = { ... } ✅                            │
│  ├─ modelSettings = { ... } ✅                          │
│  └─ hooks = [用户 hooks + Happy hooks] ✅               │
└─────────────────────────────────────────────────────────┘
```

### 2.2 核心组件

#### 组件 1: 配置读取器

**职责**: 读取用户的 `~/.claude/settings.json`

**接口**:
```typescript
function readClaudeSettings(): ClaudeSettings | null
```

**位置**: `packages/happy-cli/src/claude/utils/claudeSettings.ts`（已存在）

**行为**:
- 返回 `null` 如果文件不存在或读取失败
- 返回解析后的 JSON 对象
- 记录调试日志

#### 组件 2: 配置合并器

**职责**: 深合并用户配置和 Happy hooks 配置

**接口**:
```typescript
function deepMergeSettings(
    base: ClaudeSettings,
    override: Partial<ClaudeSettings>
): ClaudeSettings
```

**位置**: `packages/happy-cli/src/claude/utils/generateHookSettings.ts`（新增）

**行为**:
- 浅拷贝所有顶层字段
- 特殊处理 `hooks` 字段（数组合并）
- 返回合并后的新对象

#### 组件 3: Hook 设置生成器

**职责**: 生成包含用户配置和 Happy hooks 的临时 settings 文件

**接口**:
```typescript
function generateHookSettingsFile(port: number): string
```

**位置**: `packages/happy-cli/src/claude/utils/generateHookSettings.ts`（修改）

**行为**:
1. 调用 `readClaudeSettings()` 读取用户配置
2. 生成 Happy hooks 配置
3. 调用 `deepMergeSettings()` 合并配置
4. 写入临时文件
5. 返回文件路径

---

## 3. 数据流设计

### 3.1 配置合并流程

```
Session 启动
    │
    ▼
generateHookSettingsFile(port)
    │
    ├─► readClaudeSettings()
    │       │
    │       ├─ 成功 → userSettings
    │       └─ 失败 → userSettings = {}
    │
    ├─► 生成 Happy hooks
    │       │
    │       └─ happyHooks = {
    │              SessionStart: [{
    │                  matcher: "*",
    │                  hooks: [{
    │                      type: "command",
    │                      command: "node session_hook_forwarder.cjs <port>"
    │                  }]
    │              }]
    │          }
    │
    ├─► deepMergeSettings(userSettings, happyHooks)
    │       │
    │       ├─ 复制 userSettings 所有字段
    │       ├─ 合并 hooks 字段
    │       │   ├─ userSettings.hooks.SessionStart + happyHooks.SessionStart
    │       │   └─ 用户其他 hooks 保持不变
    │       └─ 返回 mergedSettings
    │
    ├─► writeFileSync(filepath, JSON.stringify(mergedSettings))
    │
    └─► return filepath
```

### 3.2 Hooks 合并策略

```typescript
// 用户配置
{
  hooks: {
    SessionStart: [
      { matcher: "*.ts", hooks: [{ type: "command", command: "echo user1" }] }
    ],
    SessionEnd: [
      { matcher: "*", hooks: [{ type: "command", command: "echo user2" }] }
    ]
  }
}

// Happy hooks
{
  hooks: {
    SessionStart: [
      { matcher: "*", hooks: [{ type: "command", command: "node hook_forwarder" }] }
    ]
  }
}

// 合并结果
{
  hooks: {
    SessionStart: [
      { matcher: "*.ts", hooks: [{ type: "command", command: "echo user1" }] },
      { matcher: "*", hooks: [{ type: "command", command: "node hook_forwarder" }] }
    ],
    SessionEnd: [
      { matcher: "*", hooks: [{ type: "command", command: "echo user2" }] }
    ]
  }
}
```

**合并规则**:
1. 用户 hooks 在前，Happy hooks 在后
2. 同一事件的 hooks 数组合并
3. 不同事件的 hooks 各自保留
4. 用户配置的 matcher 优先级高于 Happy 的通配符

---

## 4. 接口设计

### 4.1 内部接口

#### `readClaudeSettings()`

```typescript
/**
 * 读取用户的 ~/.claude/settings.json
 * 
 * @returns 配置对象或 null（文件不存在/读取失败）
 */
export function readClaudeSettings(): ClaudeSettings | null
```

**已存在**: `packages/happy-cli/src/claude/utils/claudeSettings.ts:31`

#### `deepMergeSettings()`

```typescript
/**
 * 深合并两个 settings 对象
 * 
 * @param base - 基础配置（用户配置）
 * @param override - 覆盖配置（Happy hooks）
 * @returns 合并后的新配置对象
 * 
 * 合并规则:
 * - 顶层字段：override 覆盖 base
 * - hooks 字段：数组合并（base 在前，override 在后）
 * - 其他嵌套对象：浅拷贝
 */
function deepMergeSettings(
    base: ClaudeSettings,
    override: Partial<ClaudeSettings>
): ClaudeSettings
```

**新增**: `packages/happy-cli/src/claude/utils/generateHookSettings.ts`

#### `generateHookSettingsFile()`

```typescript
/**
 * 生成包含用户配置和 Happy hooks 的临时 settings 文件
 * 
 * @param port - Hook 服务器端口
 * @returns 临时文件路径
 * 
 * 行为:
 * 1. 读取用户 ~/.claude/settings.json
 * 2. 生成 Happy SessionStart hook
 * 3. 深合并配置
 * 4. 写入临时文件
 * 5. 返回文件路径
 */
export function generateHookSettingsFile(port: number): string
```

**修改**: `packages/happy-cli/src/claude/utils/generateHookSettings.ts:20`

### 4.2 外部接口

**无变化**：对外接口保持不变，调用方无需修改。

---

## 5. 数据结构

### 5.1 ClaudeSettings 类型

```typescript
interface ClaudeSettings {
    // 环境变量
    env?: Record<string, string>;
    
    // 权限配置
    permissions?: {
        allow?: string[];
        deny?: string[];
        defaultMode?: 'auto' | 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    };
    
    // 模型特定配置
    modelSettings?: Record<string, {
        effortLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    }>;
    
    // Hooks 配置
    hooks?: {
        SessionStart?: HookEvent[];
        SessionEnd?: HookEvent[];
        PreToolUse?: HookEvent[];
        PostToolUse?: HookEvent[];
        // ... 其他 hook 事件
    };
    
    // 其他配置
    includeCoAuthoredBy?: boolean;
    [key: string]: any;
}

interface HookEvent {
    matcher: string;
    hooks: Array<{
        type: 'command';
        command: string;
    }>;
}
```

### 5.2 合并后的 Settings 示例

```json
{
  "env": {
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000",
    "API_TIMEOUT_MS": "1800000",
    "ANTHROPIC_MODEL": "qwen3.7-plus"
  },
  "permissions": {
    "allow": ["Bash(git *)"],
    "deny": ["Read(./.env)"]
  },
  "modelSettings": {
    "qwen3.7-plus": {
      "effortLevel": "max"
    }
  },
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*.ts",
        "hooks": [{ "type": "command", "command": "echo user hook" }]
      },
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "node session_hook_forwarder.cjs 8080" }]
      }
    ]
  },
  "includeCoAuthoredBy": true
}
```

---

## 6. 错误处理

### 6.1 配置读取失败

```typescript
const userSettings = readClaudeSettings();
if (!userSettings) {
    logger.warn('[generateHookSettings] Failed to read user settings, using empty config');
    userSettings = {};
}
```

**行为**: 降级为空配置，继续生成只包含 Happy hooks 的临时文件。

### 6.2 配置格式错误

```typescript
try {
    const mergedSettings = deepMergeSettings(userSettings, happyHooks);
    writeFileSync(filepath, JSON.stringify(mergedSettings, null, 2));
} catch (error) {
    logger.error('[generateHookSettings] Failed to merge settings:', error);
    // 降级：只写入 Happy hooks
    writeFileSync(filepath, JSON.stringify(happyHooks, null, 2));
}
```

**行为**: 合并失败时降级为只写入 Happy hooks，确保会话追踪功能正常。

### 6.3 Hooks 合并冲突

```typescript
// 用户 hooks 和 Happy hooks 的 SessionStart 事件
if (base.hooks?.SessionStart && override.hooks?.SessionStart) {
    result.hooks.SessionStart = [
        ...base.hooks.SessionStart,  // 用户 hooks 在前
        ...override.hooks.SessionStart  // Happy hooks 在后
    ];
}
```

**行为**: 数组合并，不冲突。用户 hooks 先执行，Happy hooks 后执行。

---

## 7. 性能设计

### 7.1 性能特征

| 操作 | 时间复杂度 | 频率 | 影响 |
|------|-----------|------|------|
| 读取 settings.json | O(1) | 每次 session 启动 | 可忽略 |
| 深合并配置 | O(n) | 每次 session 启动 | 可忽略（n = 配置项数） |
| 写入临时文件 | O(1) | 每次 session 启动 | 可忽略 |

**总体影响**: 每次 session 启动增加 < 10ms，可忽略。

### 7.2 优化策略

**当前设计**: 每次 session 启动时读取和合并配置。

**未来优化**（如性能成为瓶颈）:
```typescript
// 缓存配置（1 分钟 TTL）
let cachedSettings: ClaudeSettings | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 60000;

function getCachedSettings(): ClaudeSettings | null {
    const now = Date.now();
    if (!cachedSettings || now - cacheTimestamp > CACHE_TTL) {
        cachedSettings = readClaudeSettings();
        cacheTimestamp = now;
    }
    return cachedSettings;
}
```

---

## 8. 测试设计

### 8.1 单元测试

#### 测试用例 1: 读取用户配置

```typescript
describe('readClaudeSettings', () => {
    it('should return user settings when file exists', () => {
        // Mock fs.readFileSync
        // 验证返回解析后的 JSON
    });
    
    it('should return null when file does not exist', () => {
        // Mock fs.existsSync to return false
        // 验证返回 null
    });
});
```

#### 测试用例 2: 深合并配置

```typescript
describe('deepMergeSettings', () => {
    it('should merge env fields', () => {
        const base = { env: { KEY1: 'value1' } };
        const override = { env: { KEY2: 'value2' } };
        const result = deepMergeSettings(base, override);
        expect(result.env).toEqual({ KEY1: 'value1', KEY2: 'value2' });
    });
    
    it('should merge hooks arrays', () => {
        const base = {
            hooks: {
                SessionStart: [{ matcher: '*.ts', hooks: [...] }]
            }
        };
        const override = {
            hooks: {
                SessionStart: [{ matcher: '*', hooks: [...] }]
            }
        };
        const result = deepMergeSettings(base, override);
        expect(result.hooks.SessionStart).toHaveLength(2);
    });
    
    it('should override non-hooks fields', () => {
        const base = { includeCoAuthoredBy: true };
        const override = { includeCoAuthoredBy: false };
        const result = deepMergeSettings(base, override);
        expect(result.includeCoAuthoredBy).toBe(false);
    });
});
```

#### 测试用例 3: 生成 Hook 设置文件

```typescript
describe('generateHookSettingsFile', () => {
    it('should create merged settings file', () => {
        // Mock readClaudeSettings to return user config
        const filepath = generateHookSettingsFile(8080);
        const content = JSON.parse(readFileSync(filepath, 'utf-8'));
        
        // 验证包含用户配置
        expect(content.env).toBeDefined();
        expect(content.permissions).toBeDefined();
        
        // 验证包含 Happy hooks
        expect(content.hooks.SessionStart).toBeDefined();
        expect(content.hooks.SessionStart.length).toBeGreaterThan(0);
    });
    
    it('should fallback to happy hooks when user settings missing', () => {
        // Mock readClaudeSettings to return null
        const filepath = generateHookSettingsFile(8080);
        const content = JSON.parse(readFileSync(filepath, 'utf-8'));
        
        // 验证只包含 Happy hooks
        expect(content.hooks.SessionStart).toBeDefined();
    });
});
```

### 8.2 集成测试

#### 测试场景 1: 单模型配置

```bash
# 配置
cat > ~/.claude/settings.json << 'EOF'
{
  "env": {
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000"
  }
}
EOF

# 启动会话
happy claude

# 验证
grep "contextWindow" ~/.happy/logs/*.log
# 期望: "contextWindow": 1000000
```

#### 测试场景 2: 多配置场景

```bash
# 配置
cat > ~/.claude/settings.json << 'EOF'
{
  "env": {
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000",
    "API_TIMEOUT_MS": "1800000"
  },
  "permissions": {
    "allow": ["Bash(git *)"]
  }
}
EOF

# 启动会话
happy claude

# 验证
# 1. contextWindow 应为 1000000
# 2. API 超时应为 30 分钟
# 3. 权限配置应生效
```

#### 测试场景 3: 用户 hooks 共存

```bash
# 配置
cat > ~/.claude/settings.json << 'EOF'
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "echo user hook" }]
      }
    ]
  }
}
EOF

# 启动会话
happy claude

# 验证
# 1. 用户 hook 应执行
# 2. Happy hook 应执行
# 3. 会话追踪应正常
```

### 8.3 端到端测试

```bash
# 1. 配置 1M 上下文
# 2. 启动 Happy 会话
# 3. 进行长对话（超过 200K token）
# 4. 验证不会被截断
```

---

## 9. 部署设计

### 9.1 部署步骤

1. **代码修改**:
   - 修改 `generateHookSettings.ts`
   - 添加 `deepMergeSettings()` 函数
   - 修改 `generateHookSettingsFile()` 函数

2. **测试验证**:
   - 运行单元测试
   - 运行集成测试
   - 验证 contextWindow 变为 1M

3. **发布**:
   - 提交代码
   - 构建新版本
   - 发布到 npm

### 9.2 回滚方案

如果新版本出现问题，可以回滚到旧版本：

```bash
npm install happy@previous-version
```

**回滚影响**: 用户配置再次不生效，但会话追踪功能正常。

---

## 10. 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 深合并逻辑错误 | 低 | 中 | 充分的单元测试覆盖 |
| 用户 hooks 执行顺序问题 | 中 | 低 | 文档说明：用户 hooks 先执行 |
| 配置文件格式错误 | 低 | 低 | try-catch 降级处理 |
| 性能问题 | 极低 | 低 | 监控 session 启动时间 |

---

## 11. 未来扩展

### 11.1 配置验证

```typescript
function validateSettings(settings: ClaudeSettings): ValidationResult {
    const errors: string[] = [];
    
    if (settings.env && typeof settings.env !== 'object') {
        errors.push('env field should be an object');
    }
    
    if (settings.hooks) {
        for (const [event, hooks] of Object.entries(settings.hooks)) {
            if (!Array.isArray(hooks)) {
                errors.push(`hooks.${event} should be an array`);
            }
        }
    }
    
    return { valid: errors.length === 0, errors };
}
```

### 11.2 配置热更新

当前设计：每次 session 启动时读取配置。

未来扩展：支持配置热更新（需要监听文件变化）。

### 11.3 项目级配置

当前设计：只读取用户全局配置 `~/.claude/settings.json`。

未来扩展：支持项目级配置 `.claude/settings.json`，优先级：项目级 > 用户级。

---

## 12. 附录

### 12.1 相关文件

| 文件 | 作用 | 修改 |
|------|------|------|
| `generateHookSettings.ts` | 生成临时 settings 文件 | ✅ 主要修改 |
| `claudeSettings.ts` | 读取用户配置 | ❌ 已存在，无需修改 |
| `query.ts` | 传递 settings 给 SDK | ❌ 无需修改 |
| `claudeRemote.ts` | 远程模式启动 | ❌ 无需修改 |
| `claudeLocal.ts` | 本地模式启动 | ❌ 无需修改 |

### 12.2 参考文档

- [PRD.md](./PRD.md) — 需求文档
- [TECHNICAL_ANALYSIS.md](./TECHNICAL_ANALYSIS.md) — 深度代码分析
- [Claude Agent SDK 文档](https://docs.anthropic.com/en/docs/claude-code/sdk) — SDK settings 选项说明
