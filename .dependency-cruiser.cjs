/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-dsh-outside-adapter',
      severity: 'error',
      comment:
        'DSH 只允许出现在 services/dsh（docs/15）。记忆核心、反思 Worker、协议、schema、薄插件与 MCP 配置必须保持运行时无关。',
      from: { path: '^(services/(memory|worker)|packages|plugins|mcp)/' },
      to: { path: '@deepseek-ai' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
