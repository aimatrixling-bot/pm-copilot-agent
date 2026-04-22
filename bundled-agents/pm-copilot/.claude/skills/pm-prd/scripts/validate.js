/**
 * PRD 质量验证脚本
 *
 * 用法: node scripts/validate.js <prd-file.md>
 * 输出: 质量验证报告 + 退出码 (0=通过, 1=有错误)
 */

const fs = require('fs');
const path = require('path');

// ==================== 质量规则配置 ====================

const rules = {
  // 必需章节 - 支持中英文名称
  requiredSections: [
    { name: 'TL;DR', patterns: [/^#+\s*TL;?(\s*DR)?/i, /^#+\s*总结|概要/i] },
    { name: 'Background/Problem', patterns: [/^#+\s*.*背景/i, /^#+\s*.*问题/i, /^#+\s*Background/i] },
    { name: 'Success Metrics', patterns: [/^#+\s*.*[目标|成功指标|Success Metrics]/i] },
    { name: 'Solution/Requirements', patterns: [/^#+\s*.*[方案|需求|Solution|Requirements]/i] },
    { name: 'Scope', patterns: [/^#+\s*.*[范围|Scope]/i] }
  ],

  // TL;DR 规则
  tldr: {
    maxLength: 5,
    minLength: 1,
    mustContainKeywords: ['当前', '目标'], // 或 current, goal
    maxLineLength: 120
  },

  // 成功指标规则
  successMetrics: {
    minCount: 2,
    expectedColumns: ['指标', '基准', '目标', 'baseline', 'target', 'metric'],
    patterns: [
      /\|\s*指标\s*\|/,
      /\|\s*基准值?\s*\|/,
      /\|\s*目标值?\s*\|/
    ]
  },

  // 需求规则
  requirements: {
    minCount: 5,
    pattern: /^\s*[-*]\s+\[?\s*[xR]?\]?\s*R\d+[:：.\s]/im,
    alternativePattern: /^\s*[-*]\s+(功能|需求|Requirement)/im
  },

  // 范围规则
  scope: {
    mustHaveInScope: true,
    mustHaveOutScope: true,
    patterns: {
      in: [/In Scope|本期包含|包含范围/i],
      out: [/Out Scope|不包含|排除/i]
    }
  },

  // 文档长度规则
  documentLength: {
    minLines: 30,
    maxLines: 500 // 高保真 PRD 可能很长
  },

  // 风险表规则
  riskTable: {
    expectedColumns: ['风险', '可能', '影响', '缓解', 'risk', 'likelihood', 'impact', 'mitigation']
  }
};

// ==================== 验证器类 ====================

class PRDValidator {
  constructor(content, options = {}) {
    this.content = content;
    this.options = {
      strict: options.strict || false, // 严格模式: 警告也视为失败
      verbose: options.verbose || false
    };
    this.errors = [];
    this.warnings = [];
    this.passed = [];
    this.info = [];
  }

  // 主验证入口
  validate() {
    this.checkDocumentStructure();
    this.checkTLDR();
    this.checkSuccessMetrics();
    this.checkRequirements();
    this.checkScope();
    this.checkRiskTable();
    this.checkMarkdownFormat();
    this.calculateReadingTime();

    return this.generateReport();
  }

  // 检查文档结构
  checkDocumentStructure() {
    const lines = this.content.split('\n');
    const lineCount = lines.filter(l => l.trim()).length;

    // 检查文档长度
    if (lineCount < rules.documentLength.minLines) {
      this.errors.push(`❌ 文档过短 (${lineCount}/${rules.documentLength.minLines} 行)`);
    } else if (lineCount > rules.documentLength.maxLines) {
      this.warnings.push(`⚠️ 文档过长 (${lineCount}/${rules.documentLength.maxLines} 行)，考虑简化`);
    } else {
      this.passed.push(`✅ 文档长度合理 (${lineCount} 行)`);
    }

    // 检查必需章节
    const foundSections = [];
    const missingSections = [];

    for (const section of rules.requiredSections) {
      const found = section.patterns.some(pattern => pattern.test(this.content));
      if (found) {
        foundSections.push(section.name);
      } else {
        missingSections.push(section.name);
      }
    }

    if (missingSections.length > 0) {
      this.errors.push(`❌ 缺少必需章节: ${missingSections.join(', ')}`);
    } else {
      this.passed.push('✅ 所有必需章节存在');
    }

    // 检查章节顺序
    this.checkSectionOrder();
  }

  // 检查章节顺序
  checkSectionOrder() {
    const lines = this.content.split('\n');
    const sectionPositions = {};

    // 收集所有一级和二级标题
    lines.forEach((line, index) => {
      const match = line.match(/^#+\s+(.+)/);
      if (match) {
        const title = match[1].trim().toLowerCase();
        // 标准化章节名
        const standardName = this.standardizeSectionName(title);
        if (standardName && !sectionPositions[standardName]) {
          sectionPositions[standardName] = index;
        }
      }
    });

    // 检查关键顺序
    const expectedOrder = ['tldr', 'background', 'solution', 'requirements', 'scope'];
    let lastIndex = -1;

    for (const section of expectedOrder) {
      if (sectionPositions[section] !== undefined) {
        if (sectionPositions[section] < lastIndex) {
          this.warnings.push(`⚠️ 章节顺序可能有问题: ${section} 应该在前面`);
        }
        lastIndex = sectionPositions[section];
      }
    }
  }

  // 标准化章节名
  standardizeSectionName(title) {
    const mapping = {
      'tldr': ['tldr', '总结', '概要', 'overview'],
      'background': ['背景', '问题', 'background', 'problem'],
      'solution': ['方案', '解决', 'solution'],
      'requirements': ['需求', '功能', 'requirements'],
      'scope': ['范围', 'scope']
    };

    for (const [standard, variants] of Object.entries(mapping)) {
      if (variants.some(v => title.includes(v))) {
        return standard;
      }
    }
    return null;
  }

  // 检查 TL;DR
  checkTLDR() {
    // 匹配 TL;DR 章节
    const tldrMatch = this.content.match(/^#+\s*TL;?\s*DR?\s*\n([\s\S]+?)(?=\n^#+|\n\n|$)/im);

    if (!tldrMatch) {
      this.errors.push('❌ 未找到 TL;DR 章节');
      return;
    }

    const tldrContent = tldrMatch[1].trim();
    const lines = tldrContent.split('\n').filter(l => l.trim());

    // 检查行数
    if (lines.length < rules.tldr.minLength) {
      this.errors.push(`❌ TL;DR 过短 (${lines.length}/${rules.tldr.minLength} 行)`);
    } else if (lines.length > rules.tldr.maxLength) {
      this.warnings.push(`⚠️ TL;DR 过长 (${lines.length}/${rules.tldr.maxLength} 行)，建议精简`);
    } else {
      this.passed.push(`✅ TL;DR 长度适中 (${lines.length} 行)`);
    }

    // 检查关键词
    const hasKeywords = rules.tldr.mustContainKeywords.some(keyword =>
      tldrContent.toLowerCase().includes(keyword.toLowerCase()) ||
      tldrContent.toLowerCase().includes('current') ||
      tldrContent.toLowerCase().includes('goal')
    );

    if (hasKeywords) {
      this.passed.push('✅ TL;DR 包含关键信息 (当前状态 + 目标)');
    } else {
      this.warnings.push('⚠️ TL;DR 应包含当前状态和目标');
    }

    // 检查是否可以在 30 秒内阅读 (约 150 字)
    const wordCount = tldrContent.split(/\s+/).length;
    if (wordCount > 150) {
      this.warnings.push(`⚠️ TL;DR 字数过多 (${wordCount} 字)，建议精简到 150 字以内`);
    }
  }

  // 检查成功指标
  checkSuccessMetrics() {
    // 查找成功指标章节
    const metricsMatch = this.content.match(
      /^#+\s*.*[成功指标|Success Metrics|目标|指标].*\n([\s\S]+?)(?=\n^#+|\n\n|$)/im
    );

    if (!metricsMatch) {
      this.errors.push('❌ 未找到成功指标章节');
      return;
    }

    const metricsContent = metricsMatch[1];

    // 检查是否有表格
    const hasTable = /\|/.test(metricsContent);

    if (hasTable) {
      this.passed.push('✅ 成功指标使用表格格式');
    } else {
      this.warnings.push('⚠️ 建议使用表格格式展示成功指标');
    }

    // 检查指标数量 (通过表格行数或列表项)
    const tableRows = metricsContent.match(/\|[\s\w\d]+\|[\s\w\d]+\|[\s\w\d]+\|/g);
    const listItems = metricsContent.match(/^\s*[-*]\s+/gm);

    const count = Math.max(
      tableRows ? tableRows.length - 1 : 0, // 减去表头
      listItems ? listItems.length : 0
    );

    if (count < rules.successMetrics.minCount) {
      this.errors.push(`❌ 成功指标不足 (${count}/${rules.successMetrics.minCount} 个)`);
    } else {
      this.passed.push(`✅ 成功指标数量充足 (${count} 个)`);
    }

    // 检查是否包含必要的列
    if (tableRows) {
      const hasBaseline = rules.successMetrics.patterns.some(p => p.test(metricsContent));
      if (hasBaseline) {
        this.passed.push('✅ 指标表包含基准值和目标值');
      } else {
        this.warnings.push('⚠️ 建议指标表包含基准值和目标值列');
      }
    }
  }

  // 检查功能需求
  checkRequirements() {
    // 查找需求章节
    const reqMatch = this.content.match(
      /^#+\s*.*[功能需求|Requirements|需求].*\n([\s\S]+?)(?=\n^#+|\n\n|$)/im
    );

    if (!reqMatch) {
      this.errors.push('❌ 未找到功能需求章节');
      return;
    }

    const reqContent = reqMatch[1];

    // 检查需求数量
    const numberedReqs = reqContent.match(/\[?\s*[Rr]?\]?\s*R\d+[:：.\s]/g);
    const listReqs = reqContent.match(/^\s*[-*]\s+\[?\s*[x ]?\]?\s*/gm);
    const tableReqs = reqContent.match(/\|.*\|.*\|/g);

    const count = Math.max(
      numberedReqs ? numberedReqs.length : 0,
      listReqs ? listReqs.length : 0,
      tableReqs ? tableReqs.length - 1 : 0 // 减去表头
    );

    if (count < rules.requirements.minCount) {
      this.warnings.push(`⚠️ 需求数量较少 (${count}/${rules.requirements.minCount} 个)`);
    } else {
      this.passed.push(`✅ 需求数量充足 (${count} 个)`);
    }

    // 检查需求格式是否具体
    const vaguePhrases = ['优化', '改进', '提升', '增强', 'enhance', 'improve', 'optimize'];
    const hasVague = vaguePhrases.some(phrase =>
      new RegExp(`\\b${phrase}\\b[^。，.]{0,30}$`, 'im').test(reqContent)
    );

    if (hasVague) {
      this.warnings.push('⚠️ 部分需求描述较模糊，建议使用更具体的描述');
    } else {
      this.passed.push('✅ 需求描述较为具体');
    }
  }

  // 检查范围定义
  checkScope() {
    const scopeMatch = this.content.match(
      /^#+\s*.*[范围|Scope].*\n([\s\S]+?)(?=\n^#+|\n\n|$)/im
    );

    if (!scopeMatch) {
      this.errors.push('❌ 未找到范围章节');
      return;
    }

    const scopeContent = scopeMatch[1];

    // 检查 In Scope
    const hasInScope = rules.scope.patterns.in.some(pattern => pattern.test(scopeContent));
    if (rules.scope.mustHaveInScope && !hasInScope) {
      this.warnings.push('⚠️ 建议明确列出本期包含的内容 (In Scope)');
    } else {
      this.passed.push('✅ 包含 In Scope 定义');
    }

    // 检查 Out Scope
    const hasOutScope = rules.scope.patterns.out.some(pattern => pattern.test(scopeContent));
    if (rules.scope.mustHaveOutScope && !hasOutScope) {
      this.warnings.push('⚠️ 建议明确列出本期不包含的内容 (Out Scope)，防止范围蔓延');
    } else {
      this.passed.push('✅ 包含 Out Scope 定义');
    }
  }

  // 检查风险表
  checkRiskTable() {
    const riskMatch = this.content.match(
      /^#+\s*.*[风险|依赖|假设|Risk|Dependency].*\n([\s\S]+?)(?=\n^#+|\n\n|$)/im
    );

    if (!riskMatch) {
      this.warnings.push('⚠️ 建议添加风险和依赖章节');
      return;
    }

    const riskContent = riskMatch[1];
    const hasTable = /\|/.test(riskContent);

    if (hasTable) {
      this.passed.push('✅ 风险章节使用表格格式');
    } else {
      this.info.push('💡 建议使用表格展示风险、可能性和影响');
    }
  }

  // 检查 Markdown 格式
  checkMarkdownFormat() {
    const lines = this.content.split('\n');
    const issues = [];

    // 检查表格格式
    let inTable = false;
    lines.forEach((line, index) => {
      if (line.includes('|')) {
        if (!inTable) {
          inTable = true;
          // 检查表格是否有分隔行
          if (index + 1 < lines.length && !lines[index + 1].match(/^\|[\s\-:]+\|$/)) {
            issues.push(`表格格式可能有问题 (第 ${index + 1} 行)`);
          }
        }
      } else if (inTable && line.trim()) {
        inTable = false;
      }
    });

    if (issues.length > 0) {
      this.warnings.push(`⚠️ Markdown 格式: ${issues[0]}`);
    } else {
      this.passed.push('✅ Markdown 格式良好');
    }
  }

  // 计算阅读时间
  calculateReadingTime() {
    const wordCount = this.content.split(/\s+/).length;
    const avgReadingSpeed = 200; // 每分钟字数
    const minutes = Math.ceil(wordCount / avgReadingSpeed);

    this.info.push(`⏱️ 预估阅读时间: ${minutes} 分钟 (${wordCount} 字)`);
  }

  // 生成报告
  generateReport() {
    const total = this.errors.length + this.warnings.length + this.passed.length;
    const score = total > 0 ? Math.round((this.passed.length / total) * 100) : 0;

    let report = '\n' + '='.repeat(55) + '\n';
    report += '📋 PRD 质量验证报告\n';
    report += '='.repeat(55) + '\n\n';

    // 通过项
    if (this.passed.length > 0) {
      report += '✅ 通过项:\n';
      this.passed.forEach(p => report += `  ${p}\n`);
      report += '\n';
    }

    // 信息项
    if (this.info.length > 0) {
      report += '💡 信息:\n';
      this.info.forEach(i => report += `  ${i}\n`);
      report += '\n';
    }

    // 警告项
    if (this.warnings.length > 0) {
      report += '⚠️ 警告:\n';
      this.warnings.forEach(w => report += `  ${w}\n`);
      report += '\n';
    }

    // 错误项
    if (this.errors.length > 0) {
      report += '❌ 错误:\n';
      this.errors.forEach(e => report += `  ${e}\n`);
      report += '\n';
    }

    report += '='.repeat(55) + '\n';
    report += `📊 质量评分: ${score}/100\n`;
    report += `   通过: ${this.passed.length} | 警告: ${this.warnings.length} | 错误: ${this.errors.length}\n`;

    // 质量判定
    report += '\n';
    if (this.errors.length === 0 && this.warnings.length <= 2) {
      report += '🎉 质量良好，可以分享！\n';
    } else if (this.errors.length === 0) {
      report += '✅ 质量合格，建议改进后分享\n';
    } else if (score >= 60) {
      report += '⚠️ 需要改进后再分享\n';
    } else {
      report += '❌ 需要大幅改进\n';
    }

    report += '='.repeat(55) + '\n';

    return {
      text: report,
      score,
      passed: this.errors.length === 0,
      hasWarnings: this.warnings.length > 0,
      details: {
        passed: this.passed.length,
        warnings: this.warnings.length,
        errors: this.errors.length
      }
    };
  }
}

// ==================== CLI 入口 ====================

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
用法: node scripts/validate.js <prd-file.md> [选项]

选项:
  --strict    严格模式: 警告也视为失败 (非零退出码)
  --verbose   详细输出: 显示所有检查项
  --help      显示帮助信息

示例:
  node scripts/validate.js docs/PRD-001.md
  node scripts/validate.js docs/PRD-001.md --strict
  node scripts/validate.js docs/PRD-001.md --verbose

退出码:
  0 - 验证通过 (无错误)
  1 - 验证失败 (有错误，或严格模式下有警告)
`);
    process.exit(0);
  }

  const filePath = args[0];
  const strict = args.includes('--strict');
  const verbose = args.includes('--verbose');

  if (!fs.existsSync(filePath)) {
    console.error(`❌ 文件不存在: ${filePath}`);
    process.exit(1);
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const validator = new PRDValidator(content, { strict, verbose });
    const result = validator.validate();

    console.log(result.text);

    // 返回退出码
    const shouldFail = result.errors.length > 0 || (strict && result.hasWarnings);
    process.exit(shouldFail ? 1 : 0);

  } catch (error) {
    console.error(`❌ 验证出错: ${error.message}`);
    process.exit(1);
  }
}

module.exports = PRDValidator;
