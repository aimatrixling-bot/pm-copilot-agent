/**
 * Analytics Configuration
 * 埋点配置管理
 */

/**
 * 检查埋点是否启用
 * 必须同时满足：VITE_ANALYTICS_ENABLED=true 且 VITE_ANALYTICS_API_KEY 有值 且 VITE_ANALYTICS_ENDPOINT 有值
 * 三个条件全部来自 .env（gitignored），fork 构建不包含任何值，analytics 完全不运作
 */
export function isAnalyticsEnabled(): boolean {
  const enabled = import.meta.env.VITE_ANALYTICS_ENABLED;
  const apiKey = import.meta.env.VITE_ANALYTICS_API_KEY;
  const endpoint = import.meta.env.VITE_ANALYTICS_ENDPOINT;

  return enabled === 'true' && !!apiKey && apiKey.length > 0 && !!endpoint && endpoint.length > 0;
}

/**
 * 获取 API Key
 */
export function getApiKey(): string {
  return import.meta.env.VITE_ANALYTICS_API_KEY || '';
}

/**
 * 获取上报地址
 */
export function getEndpoint(): string {
  return import.meta.env.VITE_ANALYTICS_ENDPOINT || '';
}

/**
 * 获取完整配置（用于调试）
 */
export function getAnalyticsConfig() {
  return {
    enabled: isAnalyticsEnabled(),
    endpoint: getEndpoint(),
    hasApiKey: !!getApiKey(),
  };
}
