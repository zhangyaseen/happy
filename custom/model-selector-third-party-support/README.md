# Model Selector Third-Party Model Support

## 需求概述

当用户通过 Claude Code 的 `settings.json` 配置了第三方模型（如 `qwen3.7-plus`）后，Happy App 的模型选择器应正确显示这些自定义模型选项，而不是始终展示硬编码的 Anthropic 默认模型列表（Fable 5.1, Fable 5, Opus 5, Opus 5 [1M], Sonnet 5）。

## 当前状态

- **状态**: 已分析，待实现
- **优先级**: 高
- **创建日期**: 2026-10-03

## 文档索引

| 文档 | 说明 |
|------|------|
| [SUMMARY_DESIGN.md](./SUMMARY_DESIGN.md) | ⭐ 概要设计 — 全面分析、5 个方案对比、推荐方案、详细设计 |
| [PRD.md](./PRD.md) | 产品需求文档 — 用户场景、验收标准 |
| [TECHNICAL_ANALYSIS.md](./TECHNICAL_ANALYSIS.md) | 技术分析 — 架构、数据流、根因定位 |
| [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) | 实现方案 — 修复步骤、影响范围 |

## 问题总结

```
用户配置 settings.json 第三方模型
    → Claude Code agent 只报告当前模型（init 消息 "model": "qwen3.7-plus"）
    → ❌ 不提供 config_options_update 或 models_update 事件
    → metadata.models 始终为空
    → App fallback 到硬编码 Anthropic 模型
    → includeConfiguredModel() 还排除了 claude flavor
    → 用户看到的始终是 Fable/Opus/Sonnet
```

涉及两个问题（均已于 2026-10-03 验证）：
1. **ACP 数据缺失（设计限制）**：Claude Code 只提供当前模型名，不提供可选模型列表（`config_options_update` 和 `models_update` 均不存在）
2. **App 端 fallback 逻辑**：`includeConfiguredModel()` 排除了 `claude` flavor，无法补救

### 补充场景: 多模型层级配置

settings.json 支持通过多个环境变量配置不同的模型层级：

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

**当前配置**: 所有层级都设为 `qwen3.7-plus`（同一个模型）

**潜在配置**: 可以配置成不同的模型，用户可以在 Claude Code 中通过 `/model` 命令切换

**问题**: 即使配置了多个模型，ACP 层面也不传递可选模型列表，Happy App 无法感知这些配置

**解决方案**: 方案 B（Daemon 从 settings.json 读取多模型配置）可以解决这个问题，详见 [SUMMARY_DESIGN.md](./SUMMARY_DESIGN.md) 和 [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)

### 可行性验证 ✅（2026-10-03）

**方案 B 已验证通过**：

1. ✅ `readClaudeSettings()` 函数已存在，可以读取 settings.json
2. ✅ settings.json 的 `env` 字段包含所有模型配置（5 个环境变量）
3. ✅ 可以提取、去重并构造 metadata.models
4. ✅ 当前配置（所有层级相同）→ 去重后 **1 个模型**
5. ✅ 多模型配置（测试场景）→ 去重后 **4 个模型**

**多模型真实测试 ✅**（2026-10-03）

| 测试 | 配置 | Claude Code 报告 | 结果 |
|------|------|-----------------|------|
| 测试 1 | ANTHROPIC_MODEL = qwen3.7-plus | `"model": "qwen3.7-plus"` | ✅ 识别 |
| 测试 2 | ANTHROPIC_MODEL = kimi-k2.5 | `"model": "kimi-k2.5"` | ✅ 识别 |

**关键发现**：
- ✅ Claude Code 确实能识别不同的第三方模型（qwen、kimi）
- ✅ init 消息中的 model 字段会反映 ANTHROPIC_MODEL 的配置
- ✅ 方案 B 不仅逻辑可行，在真实场景中也完全可行

**验证脚本**: `/tmp/verify-scheme-b.mjs` 和 `/tmp/verify-scheme-b-multi.mjs`
