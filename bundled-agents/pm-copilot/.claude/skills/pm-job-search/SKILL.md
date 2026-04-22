---
name: pm-job-search
displayName: 求职准备
displayDescription: 定制化 PM 求职材料准备
description: "Prepare PM job applications with tailored materials — JD analysis, resume optimization, cover letters, and interview prep. Use this skill whenever the user needs PM job search help, says '简历', '面试', 'job search', 'PM求职', 'resume', 'cover letter', '求职信', 'JD分析', '岗位匹配', '面试准备', or wants to prepare PM application materials. Also trigger when the user says 'help me with this JD', 'optimize my resume for this role', 'prepare for a PM interview', '帮我分析这个岗位', '简历怎么改', or '面试怎么准备'. Analyzes JD requirements, matches personal experience, and generates targeted materials using STAR method."
user-invocable: true
argument-hint: "[JD 链接或职位描述]"
---

# PM 求职工具

<SUBAGENT-STOP>
如果是子代理派发执行此 Skill，直接按下方指令执行，不重新加载入口 Skill。
</SUBAGENT-STOP>

分析 JD，匹配个人经历，生成针对性求职材料。好的求职材料不是罗列经历，是对应需求。

**输入**: JD 链接或职位描述 + 个人经历
**输出**: JD 分析 + 简历建议 + 面试准备

## Iron Law

| 铁律 | 违反后果 |
| --- | --- |
| JD 每条要求必须有匹配评估 | 立即补充——未评估的要求 = 盲区 |
| 简历经历必须 STAR 法则 + 量化 | 重写——"参与了 X 项目" 不算经历描述 |
| 匹配度 < 60% 的岗位不建议投 | 标注差距——投 = 浪费双方时间 |

## 反合理化

| 你可能在想的 | 真相 |
| --- | --- |
| "简历越长越好" | 超过 2 页 = 没重点。1-2 页足够 |
| "把所有经历都写上" | 无关经历 = 噪音。只写与 JD 相关的 |
| "面试准备太花时间" | 不准备 = 白面试。30 分钟结构化准备足够 |
| "匹配度不高但可以试试" | 试试 = 浪费时间。先补差距再投 |
| "JD 是死的，我可以灵活解读" | 灵活解读 ≠ 自作多情。硬性要求不满足就是不满足 |

## 参数

| 参数 | 类型 | 必需 | 默认值 |
| --- | --- | --- | --- |
| JD | 文本/URL | 是 | — |
| 个人经历 | 文本/文件 | 是 | — |
| 材料 | resume/cover/interview | 否 | resume |

## 执行流程

```
1. 接收 JD + 个人经历
2. JD 分析
   ├── 提取硬性要求（学历/年限/技能）
   ├── 提取软性要求（能力/特质）
   ├── 识别隐含期望（从团队描述/业务方向推断）
   └── 标注匹配/不匹配/部分匹配
3. 按材料类型产出：
   ├── resume: 简历优化建议（STAR + 量化）
   ├── cover: 求职信草稿
   └── interview: 面试问题 + 回答模板
4. 匹配度评估（≥ 60% 可投）
5. Iron Law 检查
   ├── JD 每条要求已评估？
   ├── 经历用 STAR 法则？
   └── 匹配度已计算？
```

## STAR 法则

| 要素 | 说明 | 示例 |
| --- | --- | --- |
| **S**ituation | 背景和情境 | "负责日活 50 万的电商 App 推荐..." |
| **T**ask | 具体任务 | "提升推荐点击率，目标从 3% 到 5%" |
| **A**ction | 采取的行动 | "设计 A/B 测试框架，跑 12 组实验..." |
| **R**esult | 量化结果 | "点击率从 3% 提升至 5.2%，GMV +15%" |

## 交付前检查

- [ ] JD 硬性/软性要求均已分析
- [ ] 每条要求有匹配度评估
- [ ] 经历描述使用 STAR 法则
- [ ] 成就有量化数据
- [ ] 匹配度 ≥ 60% 或差距已标注

## 产出格式

```markdown
## JD 分析: [公司 - 职位]

### 匹配度评估
**总体匹配度**: [X%]

### 关键要求匹配
| 要求 | 类型 | 匹配度 | 证据/差距 |
| --- | --- | --- | --- |
| [要求 1] | 硬性 | ✅/⚠️/❌ | [证据或差距说明] |

### 简历优化建议
[针对性修改建议，STAR 法则重写]

### 面试准备
| 可能问题 | 考察点 | 回答要点 |
| --- | --- | --- |
```

---

求职深度指南（JD 隐含期望解读、面试类型分析、PM 职级对照表）见 `references/job-search-guide.md`。

## 常见错误

| 错误 | 后果 | 正确做法 |
| --- | --- | --- |
| 简历无量化 | 缺乏说服力 | 每条成就必须有数字 |
| 不分析 JD 盲投 | 白费精力 | 先评估匹配度再决定 |
| 经历描述太平 | 无法区分 | 用 STAR 法则结构化 |
| 忽略隐含期望 | 面试被问住 | 从团队/业务描述推断 |
| 一份简历投所有 | 无针对性 | 按 JD 调整重点 |
