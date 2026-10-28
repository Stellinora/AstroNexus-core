/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-dsh-outside-adapter',
      severity: 'error',
      comment:
        'DSH 的 import 只允许出现在 services/dsh/bundle/src/{memory,reflect,orchestrate} 插件入口（docs/15）。domain 内核、协议、schema、薄插件与 MCP 配置必须保持运行时无关。',
      from: { path: '^(packages|plugins|mcp)/|(^|/)domain/' },
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
