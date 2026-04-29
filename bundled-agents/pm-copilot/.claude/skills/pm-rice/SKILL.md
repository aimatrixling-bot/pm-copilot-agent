---
name: pm-rice
displayName: RICE 优先级排序
displayDescription: 基于 Reach/Impact/Confidence/Effort 四维度排序
description: "Prioritize features using the RICE framework (Reach × Impact × Confidence / Effort). Use this skill whenever the user needs to rank features, says 'prioritize', 'RICE', '优先级', '排优先级', 'what to build first', 'feature ranking', or has a list of features and isn't sure which to tackle. Also trigger when the user says 'we have too many things to do' or 'which one should we do first'. Converts gut-feel prioritization into data-driven decisions."
user-invocable: true
argument-hint: "[功能列表或需求列表]"
---

# RICE 优先级排序

<SUBAGENT-STOP>
如果是子代理派发执行此 Skill，直接按下方指令执行，不重新加载入口 Skill。
</SUBAGENT-STOP>

用 RICE 框架对功能/需求进行量化优先级排序。把争论从"我觉得"变成"数据说"。

**公式**: `RICE Score = (Reach × Impact × Confidence) / Effort`

## Iron Law（铁律）

| 铁律 | 违反后果 |
| --- | --- |
| 四个维度必须全部填写 | 立即停止——缺失维度估算为 [默认] 后继续，但必须标注 |
| Effort 不能为 0 | 立即停止——Effort 最小值 0.5 人月 |
| 单维度排序无效 | 立即停止——必须展示综合 RICE 分数，不能只看某维度 |

## 反合理化

| 你可能在想的 | 真相 |
| --- | --- |
| "这个功能肯定最重要" | "肯定"不是数据——用 RICE 分数证明 |
| "Impact 打 3 分没问题" | Impact 3 分意味着改变用户生活——90% 的功能不超过 2 分 |
| "Confidence 都打 80% 吧" | 没有用户数据支撑的估算 Confidence 应该是 50% |
| "Effort 让开发估" | PM 应该给出业务视角的粗估，等开发确认后再更新 |
| "老板说要先做这个" | RICE 排序 + 老板意见 = 有数据的决策。只有老板意见 = 猜测 |

## Entry Mode

### Quick（快速模式）— 收集功能列表后直接评分

**输入**: 功能列表（来自对话上下文或用户直接输入）

**评分引导**（防止维度失真）：

| 维度 | 常见偏差 | 纠正规则 |
| --- | --- | --- |
| Impact | 倾向全打 2-3 分 | 3 分 = "改变用户生活"，90% 功能 ≤ 2 分 |
| Confidence | 倾向全打 80% | 无用户数据 = 50%，有访谈 = 80%，有 A/B = 100% |
| Effort | 倾向低估 | 宁可高估。0.5 人月 = 1 人 2 周 |
| Reach | 倾向高估 | 用实际用户数，不是"潜在用户数" |

**维度定义**：

| 维度 | 单位 | 评分范围 |
| --- | --- | --- |
| Reach | 人/季度 | 正整数（如 1000, 50000） |
| Impact | 分数 | 3=Massive, 2=High, 1=Medium, 0.5=Low, 0.25=Minimal |
| Confidence | 百分比 | 100%=High, 80%=Medium, 50%=Low |
| Effort | 人月 | 正数（如 0.5, 2, 6），最小 0.5 |

**流程**:
1. 解析功能列表（≤ 20 个，> 10 个建议分批）
2. 对每个功能估算四维度（遵循纠正规则）
3. 所有推断标注 [假设]
4. 计算 RICE 分数并排序
5. **自动检查**：Impact 全部 ≥ 2 或 Confidence 全部 ≥ 80% → 警告并建议校准

**产出格式**:

| 排名 | 功能 | Reach | Impact | Confidence | Effort | RICE Score | 标注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 功能 A | 5000 | 2 | 80% | 2 | 4000 | |
| 2 | 功能 B | 10000 | 1 | 50% | 3 | 1667 | [假设:Effort] |

### Expert（专家模式）— 直接产出 + 高级选项

基于上下文直接产出，支持高级选项：
- **A. 标准模式** — 4 维度 RICE
- **B. 加权模式** — 自定义维度权重（如 Impact × 1.5）
- **C. 对比模式** — 与上次排序对比，标注变化
- **D. 敏感度分析** — Confidence ±20% 后排名是否变化

**批量支持**: PRD 文件 → 提取功能列表 → 批量评分

## 执行流程

```
触发 pm-rice
    ├── 1. 模式判断（Quick/Expert）
    ├── 2. 收集功能列表
    │     ├── 从对话上下文提取
    │     ├── 从已有 PRD/Roadmap 文件读取
    │     └── 从用户直接输入解析
    ├── 3. 四维度评分（遵循纠正规则）
    ├── 4. 计算 RICE 分数
    ├── 5. Iron Law 检查
    │     ├── 四维度全部填写？
    │     ├── Effort > 0？
    │     └── 展示综合分数？
    ├── 6. 排序 + 标注 [假设]
    └── 7. 交付 + 建议下一步（→ pm-roadmap 或 → pm-prd）
```
## 交付前检查

## Hard Bans（硬禁令）

以下模式在所有保真度级别均禁止出现。检测到时立即修正。

| # | 禁止模式 | 修正动作 |
| --- | --------- | -------- |
| HB-1 | 评审/回顾只说好话无改进建议 | 补充 >=3 个改进建议并标注 P0/P1/P2 |
| HB-2 | 行动项无负责人或无截止日期 | 每个行动项必须填入负责人和截止日期 |
| HB-3 | 报告/输出超过 1 页且无摘要 | 压缩至 1 页关键信息，详细内容移入附录 |
| HB-4 | 评分/排序中某维度全给满分（无区分度） | 至少有一个维度的得分范围跨越 >=2 个分值 |
| HB-5 | 跳过问题定义直接给方案 | 先输出 1 句话问题概括，经用户确认后再给方案 |


- [ ] 所有功能的四个维度已填写
- [ ] RICE 分数计算正确
- [ ] 按分数降序排列
- [ ] 假设值已标注 [假设]
- [ ] Confidence 低的项已建议验证
- [ ] Effort > 0（最小 0.5 人月）
- [ ] 功能列表 ≤ 20 个
- [ ] Impact 未全部 ≥ 2 分（已校准）
- [ ] Confidence 未全部 ≥ 80%（已校准）
