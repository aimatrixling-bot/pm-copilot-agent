/**
 * Recommended providers for the Setup Wizard
 * Providers with lowest barrier to entry for new users
 */

export interface RecommendedProvider {
    id: string;
    reason: string;
    signupUrl: string;
    docLabel: string;
}

export const RECOMMENDED_PROVIDERS: readonly RecommendedProvider[] = [
    {
        id: 'deepseek',
        reason: '¥1/百万 token，最低成本开始',
        signupUrl: 'https://platform.deepseek.com/api_keys',
        docLabel: '获取 DeepSeek API Key',
    },
    {
        id: 'zhipu',
        reason: '注册即送免费额度，国产大模型',
        signupUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
        docLabel: '获取智谱 API Key',
    },
    {
        id: 'siliconflow',
        reason: '注册即送免费额度，多模型可选',
        signupUrl: 'https://cloud.siliconflow.cn/account/ak',
        docLabel: '获取 SiliconFlow API Key',
    },
    {
        id: 'anthropic-api',
        reason: 'Claude 系列，最强推理能力',
        signupUrl: 'https://console.anthropic.com/settings/keys',
        docLabel: '获取 Anthropic API Key',
    },
] as const;

/** Quick-access skills to show after setup completes */
export const QUICK_START_SKILLS = [
    { command: '/pm-prd', label: '写 PRD', description: '30 秒生成结构化需求文档' },
    { command: '/pm-comp', label: '竞品分析', description: '多维度竞品对比分析' },
    { command: '/pm-prototype', label: '原型设计', description: '从 PRD 到可交互原型' },
] as const;
