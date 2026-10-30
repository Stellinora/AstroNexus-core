window.__ModuleLoader__.load({
	id: "@astronexus/dsh-client-theme",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;

		const css = `
:root, body {
  --dsw-alias-brand-primary: #4d6bfe !important;
  --dsw-alias-brand-text: #4d6bfe !important;
  --dsw-alias-link: #4d6bfe !important;

  --dsw-alias-bg-base: #ffffff !important;
  --dsw-alias-bg-layer-1: #ffffff !important;
  --dsw-alias-bg-layer-2: #f7f8fa !important;
  --dsw-alias-bg-layer-3: #f2f3f5 !important;
  --dsw-alias-bg-module-platform: #f5f6f8 !important;
  --dsw-alias-bg-overlay: #ffffff !important;

  --dsw-alias-label-primary: #1b1b1f !important;
  --dsw-alias-label-secondary: #5c5f66 !important;
  --dsw-alias-label-tertiary: #8b8f96 !important;
  --dsw-alias-label-caption: #a2a6ad !important;

  --dsw-alias-border-l1: #eceef1 !important;
  --dsw-alias-border-l2: #e6e8eb !important;
  --dsw-alias-border-l3: #dfe2e6 !important;
  --dsw-alias-border-l4: #d6dae0 !important;

  --dsw-alias-interactive-bg-hover: #f2f4f7 !important;
  --dsw-alias-interactive-bg-active: #e9edf3 !important;

  --dsw-alias-button-primary-fill: #4d6bfe !important;
  --dsw-alias-button-primary-hover: #3f5cf0 !important;
}

body[data-ds-dark-theme] {
  --dsw-alias-bg-base: #1b1b1d !important;
  --dsw-alias-bg-layer-1: #212124 !important;
  --dsw-alias-bg-layer-2: #26262a !important;
  --dsw-alias-bg-layer-3: #2c2c31 !important;
  --dsw-alias-bg-module-platform: #232326 !important;
  --dsw-alias-bg-overlay: #2a2a2e !important;

  --dsw-alias-label-primary: #ededf0 !important;
  --dsw-alias-label-secondary: #a8abb2 !important;
  --dsw-alias-label-tertiary: #85888f !important;
  --dsw-alias-label-caption: #6f7278 !important;

  --dsw-alias-border-l1: #2f2f34 !important;
  --dsw-alias-border-l2: #35353b !important;
  --dsw-alias-border-l3: #3d3d44 !important;
  --dsw-alias-border-l4: #46464e !important;

  --dsw-alias-interactive-bg-hover: #2e2e34 !important;
  --dsw-alias-interactive-bg-active: #3a3a42 !important;
}
`;

		function apply(ctx) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@astronexus/dsh-client-theme";
			tag.textContent = css;
			document.head.appendChild(tag);
			if (ctx && typeof ctx.effect === "function") {
				ctx.effect(() => () => tag.remove());
			}
		}

		exports.apply = apply;
		exports.name = "astronexus-theme";
		return module.exports;
	},
});
