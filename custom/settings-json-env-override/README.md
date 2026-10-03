# settings.json 环境变量被覆盖问题

## 问题概述

Happy CLI 在启动 Claude 会话时，生成的临时 settings 文件**覆盖了**用户的 `~/.claude/settings.json`，导致 `env` 字段中的配置（如 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`）不生效。

## 当前状态

- **状态**: 已分析，待实施
- **优先级**: 高
- **创建日期**: 2026-10-03

## 文档索引

| 文档 | 说明 |
|------|------|
| [PRD.md](./PRD.md) | 需求文档 — 问题背景、根因分析、影响范围 |
| [TECHNICAL_ANALYSIS.md](./TECHNICAL_ANALYSIS.md) | 🔍 深度代码分析 — 4 个解决方案对比、成本评估 |
| [SUMMARY_DESIGN.md](./SUMMARY_DESIGN.md) | 概要设计 — 推荐方案、架构设计、接口设计 |
| [DETAILED_DESIGN.md](./DETAILED_DESIGN.md) | 详细设计 — 完整代码实现、测试用例 |
| [FEASIBILITY_VERIFICATION.md](./FEASIBILITY_VERIFICATION.md) | ⭐ 可行性验证 — 验证步骤、自动化脚本、验收标准 |

## 问题总结

```
Happy 生成临时 settings 文件（只有 hooks）
    → 通过 SDK settings 参数传递给 Claude
    → Claude 使用临时文件替代 ~/.claude/settings.json
    → env 字段中的配置丢失
    → CLAUDE_CODE_MAX_CONTEXT_TOKENS 等不生效
    → contextWindow 显示 200K 而非配置的 1M
```

## 关键影响

| 配置项 | 期望值 | 实际值 | 状态 |
|--------|--------|--------|------|
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | 1000000 | 200000 | ❌ 不生效 |
| `API_TIMEOUT_MS` | 1800000 | 默认值 | ❌ 不生效 |
| `CLAUDE_CODE_EFFORT_LEVEL` | max | 默认值 | ❌ 不生效 |

## 根因

`generateHookSettingsFile()` 只写入 hooks 配置，不合并用户 settings.json 的内容。

## 相关发现

此问题在验证"模型选择器第三方模型支持"功能时发现：
- [custom/model-selector-third-party-support/](../model-selector-third-party-support/) — 模型选择器修复（已完成）
