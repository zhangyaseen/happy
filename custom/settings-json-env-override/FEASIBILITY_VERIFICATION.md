# 可行性验证文档：settings.json 配置合并方案

> **状态**: 待验证
> **日期**: 2026-10-03
> **关联**: [DETAILED_DESIGN.md](./DETAILED_DESIGN.md) · [SUMMARY_DESIGN.md](./SUMMARY_DESIGN.md)

---

## 1. 验证目标

### 1.1 核心验证点

1. **功能验证**: 用户 `~/.claude/settings.json` 的 `env` 配置是否生效
2. **兼容性验证**: Happy SessionStart hook 是否继续正常工作
3. **共存验证**: 用户自定义 hooks 是否与 Happy hooks 共存
4. **性能验证**: 配置合并是否影响 session 启动性能
5. **降级验证**: 配置读取/写入失败时的降级行为

### 1.2 验收标准

| 验证项 | 验收标准 | 优先级 |
|--------|---------|--------|
| contextWindow | 配置 1M 后日志显示 `contextWindow: 1000000` | P0 |
| SessionStart hook | Happy 会话追踪功能正常 | P0 |
| 用户 hooks 共存 | 用户和 Happy hooks 都执行 | P1 |
| 多配置生效 | env、permissions、modelSettings 都生效 | P1 |
| 性能影响 | session 启动时间增加 < 50ms | P2 |
| 降级行为 | 配置失败时仍能正常启动 | P2 |

---

## 2. 验证环境

### 2.1 环境要求

- **操作系统**: macOS / Linux
- **Node.js**: >= 18
- **Happy CLI**: 当前开发版本
- **Claude Code**: 已安装并配置

### 2.2 测试配置

**基础配置**（`~/.claude/settings.json`）:
```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-sp-xxx",
    "ANTHROPIC_BASE_URL": "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    "ANTHROPIC_MODEL": "qwen3.7-plus",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000",
    "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT": "1",
    "API_TIMEOUT_MS": "1800000",
    "CLAUDE_CODE_EFFORT_LEVEL": "max"
  }
}
```

---

## 3. 验证步骤

### 3.1 准备阶段

#### 步骤 1: 备份现有配置

```bash
#!/bin/bash

# 备份用户配置
if [ -f ~/.claude/settings.json ]; then
    cp ~/.claude/settings.json ~/.claude/settings.json.backup.$(date +%Y%m%d_%H%M%S)
    echo "✅ 已备份用户配置"
else
    echo "⚠️  用户配置不存在，将创建测试配置"
fi

# 备份 Happy 日志
HAPPY_LOG_DIR=~/.happy/logs
if [ -d "$HAPPY_LOG_DIR" ]; then
    BACKUP_DIR="$HAPPY_LOG_DIR/backup_$(date +%Y%m%d_%H%M%S)"
    mkdir -p "$BACKUP_DIR"
    mv "$HAPPY_LOG_DIR"/*.log "$BACKUP_DIR/" 2>/dev/null || true
    echo "✅ 已备份 Happy 日志到 $BACKUP_DIR"
fi
```

#### 步骤 2: 实施代码修改

按照 [DETAILED_DESIGN.md](./DETAILED_DESIGN.md) 第 2 节实施代码修改：

```bash
# 1. 编辑 generateHookSettings.ts
cd packages/happy-cli
vim src/claude/utils/generateHookSettings.ts

# 2. 构建项目
cd ../..
pnpm build

# 3. 重启 daemon
./packages/happy-cli/bin/happy.mjs daemon stop
./packages/happy-cli/bin/happy.mjs daemon start
```

#### 步骤 3: 创建测试配置

```bash
cat > ~/.claude/settings.json << 'EOF'
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-sp-3c7ca87d87c146cfa1c8ed927b4f1fe5",
    "ANTHROPIC_BASE_URL": "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    "ANTHROPIC_MODEL": "qwen3.7-plus",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "qwen3.7-plus",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "qwen3.7-plus",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "qwen3.7-plus",
    "CLAUDE_CODE_SUBAGENT_MODEL": "qwen3.7-plus",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000",
    "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT": "1",
    "API_TIMEOUT_MS": "1800000",
    "CLAUDE_CODE_EFFORT_LEVEL": "max"
  },
  "permissions": {
    "allow": [
      "Bash(git *)",
      "Bash(npm run *)",
      "Bash(npm test *)"
    ],
    "deny": [
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(./secrets/**)"
    ]
  },
  "modelSettings": {
    "qwen3.7-plus": {
      "effortLevel": "max"
    }
  }
}
EOF

echo "✅ 已创建测试配置"
```

### 3.2 验证阶段

#### 验证 1: 单模型配置（P0）

**目的**: 验证 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 生效

**步骤**:
```bash
#!/bin/bash

echo "=== 验证 1: 单模型配置 ==="

# 1. 启动会话
echo "1. 启动 Happy 会话..."
./packages/happy-cli/bin/happy.mjs claude --happy-starting-mode remote &
HAPPY_PID=$!
sleep 10

# 2. 查找最新的日志文件
LATEST_LOG=$(ls -t ~/.happy/logs/*.log | head -1)
echo "2. 日志文件: $LATEST_LOG"

# 3. 检查 contextWindow
echo "3. 检查 contextWindow..."
CONTEXT_WINDOW=$(grep -o '"contextWindow":[0-9]*' "$LATEST_LOG" | tail -1 | cut -d':' -f2)

if [ "$CONTEXT_WINDOW" = "1000000" ]; then
    echo "✅ PASS: contextWindow = 1000000 (期望值)"
else
    echo "❌ FAIL: contextWindow = $CONTEXT_WINDOW (期望 1000000)"
fi

# 4. 检查调试日志
echo "4. 检查调试日志..."
if grep -q "User settings loaded: env" "$LATEST_LOG"; then
    echo "✅ 用户配置已加载"
else
    echo "⚠️  未找到用户配置加载日志"
fi

if grep -q "CLAUDE_CODE_MAX_CONTEXT_TOKENS" "$LATEST_LOG"; then
    echo "✅ 检测到 CLAUDE_CODE_MAX_CONTEXT_TOKENS"
else
    echo "⚠️  未检测到 CLAUDE_CODE_MAX_CONTEXT_TOKENS"
fi

# 5. 检查合并的 settings 文件
echo "5. 检查合并的 settings 文件..."
SETTINGS_FILE=$(ls -t ~/.happy/tmp/hooks/session-hook-*.json | head -1)
if [ -f "$SETTINGS_FILE" ]; then
    echo "✅ Settings 文件: $SETTINGS_FILE"
    echo "内容预览:"
    cat "$SETTINGS_FILE" | jq '{env: .env, hooks: .hooks}' 2>/dev/null || cat "$SETTINGS_FILE"
else
    echo "❌ 未找到 settings 文件"
fi

# 6. 清理
echo "6. 清理..."
kill $HAPPY_PID 2>/dev/null
wait $HAPPY_PID 2>/dev/null
echo "✅ 验证 1 完成"
```

**预期结果**:
- `contextWindow: 1000000`
- 调试日志显示用户配置已加载
- 合并的 settings 文件包含 env 和 hooks

#### 验证 2: 多配置场景（P1）

**目的**: 验证多个配置项同时生效

**步骤**:
```bash
#!/bin/bash

echo "=== 验证 2: 多配置场景 ==="

# 1. 启动会话
echo "1. 启动 Happy 会话..."
./packages/happy-cli/bin/happy.mjs claude --happy-starting-mode remote &
HAPPY_PID=$!
sleep 10

# 2. 检查合并的 settings 文件
echo "2. 检查合并的 settings 文件..."
SETTINGS_FILE=$(ls -t ~/.happy/tmp/hooks/session-hook-*.json | head -1)

if [ -f "$SETTINGS_FILE" ]; then
    echo "✅ Settings 文件存在"
    
    # 检查 env
    if jq -e '.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS' "$SETTINGS_FILE" > /dev/null 2>&1; then
        echo "✅ env.CLAUDE_CODE_MAX_CONTEXT_TOKENS 存在"
    else
        echo "❌ env.CLAUDE_CODE_MAX_CONTEXT_TOKENS 不存在"
    fi
    
    # 检查 permissions
    if jq -e '.permissions' "$SETTINGS_FILE" > /dev/null 2>&1; then
        echo "✅ permissions 存在"
    else
        echo "❌ permissions 不存在"
    fi
    
    # 检查 modelSettings
    if jq -e '.modelSettings' "$SETTINGS_FILE" > /dev/null 2>&1; then
        echo "✅ modelSettings 存在"
    else
        echo "❌ modelSettings 不存在"
    fi
    
    # 检查 hooks
    if jq -e '.hooks.SessionStart' "$SETTINGS_FILE" > /dev/null 2>&1; then
        echo "✅ hooks.SessionStart 存在"
        HOOKS_COUNT=$(jq '.hooks.SessionStart | length' "$SETTINGS_FILE")
        echo "   SessionStart hooks 数量: $HOOKS_COUNT"
    else
        echo "❌ hooks.SessionStart 不存在"
    fi
else
    echo "❌ Settings 文件不存在"
fi

# 3. 清理
kill $HAPPY_PID 2>/dev/null
wait $HAPPY_PID 2>/dev/null
echo "✅ 验证 2 完成"
```

**预期结果**:
- settings 文件包含 env、permissions、modelSettings、hooks
- hooks.SessionStart 数组长度 >= 1

#### 验证 3: 用户 hooks 共存（P1）

**目的**: 验证用户自定义 hooks 与 Happy hooks 共存

**步骤**:
```bash
#!/bin/bash

echo "=== 验证 3: 用户 hooks 共存 ==="

# 1. 添加用户 hooks
cat > ~/.claude/settings.json << 'EOF'
{
  "env": {
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000"
  },
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'User hook executed at $(date)' >> /tmp/user_hook.log"
          }
        ]
      }
    ]
  }
}
EOF

echo "1. 已添加用户 hooks"

# 2. 清理之前的 hook 日志
rm -f /tmp/user_hook.log

# 3. 启动会话
echo "2. 启动 Happy 会话..."
./packages/happy-cli/bin/happy.mjs claude --happy-starting-mode remote &
HAPPY_PID=$!
sleep 10

# 4. 检查合并的 settings 文件
echo "3. 检查合并的 settings 文件..."
SETTINGS_FILE=$(ls -t ~/.happy/tmp/hooks/session-hook-*.json | head -1)

if [ -f "$SETTINGS_FILE" ]; then
    HOOKS_COUNT=$(jq '.hooks.SessionStart | length' "$SETTINGS_FILE")
    echo "✅ SessionStart hooks 数量: $HOOKS_COUNT"
    
    if [ "$HOOKS_COUNT" -ge 2 ]; then
        echo "✅ PASS: 用户 hooks 和 Happy hooks 共存"
        echo "Hooks 详情:"
        jq '.hooks.SessionStart' "$SETTINGS_FILE"
    else
        echo "❌ FAIL: hooks 数量不足（期望 >= 2，实际 $HOOKS_COUNT）"
    fi
else
    echo "❌ Settings 文件不存在"
fi

# 5. 检查用户 hook 是否执行
echo "4. 检查用户 hook 是否执行..."
if [ -f /tmp/user_hook.log ]; then
    echo "✅ 用户 hook 已执行"
    cat /tmp/user_hook.log
else
    echo "⚠️  用户 hook 未执行（可能需要实际会话交互才会触发）"
fi

# 6. 清理
kill $HAPPY_PID 2>/dev/null
wait $HAPPY_PID 2>/dev/null
echo "✅ 验证 3 完成"
```

**预期结果**:
- SessionStart hooks 数组长度 >= 2
- 用户 hook 在前，Happy hook 在后

#### 验证 4: 降级行为（P2）

**目的**: 验证配置读取失败时的降级行为

**步骤**:
```bash
#!/bin/bash

echo "=== 验证 4: 降级行为 ==="

# 1. 删除用户配置
rm -f ~/.claude/settings.json
echo "1. 已删除用户配置"

# 2. 启动会话
echo "2. 启动 Happy 会话..."
./packages/happy-cli/bin/happy.mjs claude --happy-starting-mode remote &
HAPPY_PID=$!
sleep 10

# 3. 检查日志
LATEST_LOG=$(ls -t ~/.happy/logs/*.log | head -1)

if grep -q "No user settings found" "$LATEST_LOG"; then
    echo "✅ 检测到降级日志"
else
    echo "⚠️  未检测到降级日志"
fi

# 4. 检查 settings 文件
SETTINGS_FILE=$(ls -t ~/.happy/tmp/hooks/session-hook-*.json | head -1)

if [ -f "$SETTINGS_FILE" ]; then
    if jq -e '.hooks.SessionStart' "$SETTINGS_FILE" > /dev/null 2>&1; then
        echo "✅ PASS: 降级后仍有 Happy hooks"
    else
        echo "❌ FAIL: 降级后缺少 Happy hooks"
    fi
else
    echo "❌ Settings 文件不存在"
fi

# 5. 清理
kill $HAPPY_PID 2>/dev/null
wait $HAPPY_PID 2>/dev/null
echo "✅ 验证 4 完成"
```

**预期结果**:
- 日志显示 "No user settings found"
- settings 文件仍包含 Happy hooks
- 会话正常启动

#### 验证 5: 性能影响（P2）

**目的**: 验证配置合并对性能的影响

**步骤**:
```bash
#!/bin/bash

echo "=== 验证 5: 性能影响 ==="

# 1. 恢复用户配置
cat > ~/.claude/settings.json << 'EOF'
{
  "env": {
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000"
  }
}
EOF

# 2. 测试 3 次，取平均值
TOTAL_TIME=0
RUNS=3

for i in $(seq 1 $RUNS); do
    echo "运行 $i/$RUNS..."
    
    START_TIME=$(date +%s%N)
    
    # 启动会话
    ./packages/happy-cli/bin/happy.mjs claude --happy-starting-mode remote &
    HAPPY_PID=$!
    
    # 等待会话就绪
    sleep 10
    
    END_TIME=$(date +%s%N)
    
    # 计算耗时（毫秒）
    ELAPSED=$(( (END_TIME - START_TIME) / 1000000 ))
    TOTAL_TIME=$((TOTAL_TIME + ELAPSED))
    
    echo "  耗时: ${ELAPSED}ms"
    
    # 清理
    kill $HAPPY_PID 2>/dev/null
    wait $HAPPY_PID 2>/dev/null
    sleep 2
done

# 3. 计算平均耗时
AVG_TIME=$((TOTAL_TIME / RUNS))
echo ""
echo "平均启动时间: ${AVG_TIME}ms"

if [ $AVG_TIME -lt 10050 ]; then
    echo "✅ PASS: 性能影响 < 50ms"
else
    OVERHEAD=$((AVG_TIME - 10000))
    echo "⚠️  性能影响: ${OVERHEAD}ms (目标 < 50ms)"
fi

echo "✅ 验证 5 完成"
```

**预期结果**:
- 平均启动时间增加 < 50ms

### 3.3 恢复阶段

#### 步骤 1: 恢复原始配置

```bash
#!/bin/bash

echo "=== 恢复原始配置 ==="

# 查找最新的备份
LATEST_BACKUP=$(ls -t ~/.claude/settings.json.backup.* 2>/dev/null | head -1)

if [ -n "$LATEST_BACKUP" ]; then
    cp "$LATEST_BACKUP" ~/.claude/settings.json
    echo "✅ 已恢复用户配置: $LATEST_BACKUP"
else
    echo "⚠️  未找到配置备份"
fi

# 重启 daemon
./packages/happy-cli/bin/happy.mjs daemon stop
./packages/happy-cli/bin/happy.mjs daemon start
echo "✅ 已重启 daemon"
```

---

## 4. 验证报告模板

### 4.1 验证结果汇总

| 验证项 | 状态 | 实际值 | 期望值 | 备注 |
|--------|------|--------|--------|------|
| contextWindow | ✅/❌ | | 1000000 | |
| 用户配置加载 | ✅/❌ | | 日志显示 | |
| 多配置生效 | ✅/❌ | | env+permissions+modelSettings | |
| 用户 hooks 共存 | ✅/❌ | | hooks 数量 >= 2 | |
| 降级行为 | ✅/❌ | | 无配置时仍正常 | |
| 性能影响 | ✅/❌ | | < 50ms | |

### 4.2 问题记录

| # | 问题描述 | 严重程度 | 影响范围 | 解决方案 |
|---|---------|---------|---------|---------|
| 1 | | P0/P1/P2 | | |

### 4.3 结论

**整体评估**: ✅ 通过 / ❌ 未通过

**发布建议**:
- ✅ 可以发布
- ⚠️ 需要修复后重新验证
- ❌ 不建议发布

---

## 5. 自动化验证脚本

### 5.1 完整验证脚本

```bash
#!/bin/bash
# 文件名: verify_settings_merge.sh
# 用途: 自动化验证 settings.json 配置合并方案

set -e

echo "========================================="
echo "Settings.json 配置合并方案验证"
echo "========================================="
echo ""

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 计数器
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# 测试函数
run_test() {
    local test_name=$1
    local test_command=$2
    
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    echo ""
    echo "=== 测试 $TOTAL_TESTS: $test_name ==="
    
    if eval "$test_command"; then
        PASSED_TESTS=$((PASSED_TESTS + 1))
        echo -e "${GREEN}✅ PASS${NC}"
    else
        FAILED_TESTS=$((FAILED_TESTS + 1))
        echo -e "${RED}❌ FAIL${NC}"
    fi
}

# 测试 1: 检查代码修改
test_code_changes() {
    if grep -q "readClaudeSettings" packages/happy-cli/src/claude/utils/generateHookSettings.ts; then
        echo "✅ 代码已修改"
        return 0
    else
        echo "❌ 代码未修改"
        return 1
    fi
}

# 测试 2: 检查构建
test_build() {
    if pnpm build > /dev/null 2>&1; then
        echo "✅ 构建成功"
        return 0
    else
        echo "❌ 构建失败"
        return 1
    fi
}

# 测试 3: 检查 contextWindow
test_context_window() {
    # 创建测试配置
    cat > ~/.claude/settings.json << 'EOF'
{
  "env": {
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000"
  }
}
EOF
    
    # 启动会话
    ./packages/happy-cli/bin/happy.mjs claude --happy-starting-mode remote &
    HAPPY_PID=$!
    sleep 10
    
    # 检查日志
    LATEST_LOG=$(ls -t ~/.happy/logs/*.log | head -1)
    CONTEXT_WINDOW=$(grep -o '"contextWindow":[0-9]*' "$LATEST_LOG" | tail -1 | cut -d':' -f2)
    
    # 清理
    kill $HAPPY_PID 2>/dev/null
    wait $HAPPY_PID 2>/dev/null
    
    if [ "$CONTEXT_WINDOW" = "1000000" ]; then
        echo "✅ contextWindow = 1000000"
        return 0
    else
        echo "❌ contextWindow = $CONTEXT_WINDOW (期望 1000000)"
        return 1
    fi
}

# 运行所有测试
run_test "代码修改" test_code_changes
run_test "项目构建" test_build
run_test "Context Window" test_context_window

# 输出汇总
echo ""
echo "========================================="
echo "验证汇总"
echo "========================================="
echo "总测试数: $TOTAL_TESTS"
echo -e "通过: ${GREEN}$PASSED_TESTS${NC}"
echo -e "失败: ${RED}$FAILED_TESTS${NC}"
echo ""

if [ $FAILED_TESTS -eq 0 ]; then
    echo -e "${GREEN}✅ 所有测试通过！${NC}"
    exit 0
else
    echo -e "${RED}❌ 部分测试失败${NC}"
    exit 1
fi
```

### 5.2 使用方法

```bash
# 1. 保存脚本
chmod +x verify_settings_merge.sh

# 2. 运行验证
./verify_settings_merge.sh

# 3. 查看报告
echo $?  # 0 = 成功, 1 = 失败
```

---

## 6. 风险评估

### 6.1 技术风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 深合并逻辑错误 | 低 | 中 | 充分的单元测试 |
| 用户配置格式异常 | 低 | 低 | try-catch 降级 |
| Hooks 合并顺序问题 | 中 | 低 | 文档说明 |
| 性能问题 | 极低 | 低 | 监控启动时间 |

### 6.2 回滚方案

如果验证失败，可以快速回滚：

```bash
#!/bin/bash

# 1. 恢复原始代码
git checkout packages/happy-cli/src/claude/utils/generateHookSettings.ts

# 2. 重新构建
pnpm build

# 3. 重启 daemon
./packages/happy-cli/bin/happy.mjs daemon stop
./packages/happy-cli/bin/happy.mjs daemon start

echo "✅ 已回滚到原始版本"
```

---

## 7. 时间估算

| 阶段 | 预计时间 | 说明 |
|------|---------|------|
| 准备阶段 | 10 分钟 | 备份、代码修改、构建 |
| 验证阶段 | 30 分钟 | 5 个验证场景 |
| 问题修复 | 30 分钟 | 如有问题 |
| 恢复阶段 | 5 分钟 | 恢复配置 |
| **总计** | **75 分钟** | 约 1.25 小时 |

---

## 8. 附录

### 8.1 相关文档

- [PRD.md](./PRD.md) — 需求文档
- [TECHNICAL_ANALYSIS.md](./TECHNICAL_ANALYSIS.md) — 深度代码分析
- [SUMMARY_DESIGN.md](./SUMMARY_DESIGN.md) — 概要设计
- [DETAILED_DESIGN.md](./DETAILED_DESIGN.md) — 详细设计

### 8.2 参考命令

```bash
# 查看 daemon 日志
tail -f ~/.happy/logs/*.log

# 查看合并的 settings 文件
cat ~/.happy/tmp/hooks/session-hook-*.json | jq .

# 重启 daemon
./packages/happy-cli/bin/happy.mjs daemon stop
./packages/happy-cli/bin/happy.mjs daemon start

# 清理测试文件
rm -f ~/.happy/tmp/hooks/session-hook-*.json
rm -f /tmp/user_hook.log
```
