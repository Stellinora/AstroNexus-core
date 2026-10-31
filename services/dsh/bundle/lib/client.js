window.__ModuleLoader__.load({
	id: "@astronexus/dsh-bundle",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		const { jsx } = require("react/jsx-runtime");

		const css = `
:root, body {
  --dsw-alias-brand-primary: #4d6bfe !important;
  --dsw-alias-brand-text: #4d6bfe !important;
  --dsw-alias-link: #4d6bfe !important;

  --dsw-specific-sidebar-fill: #f7f8fa !important;
  --dsw-specific-input-major: #ffffff !important;
  --dsw-alias-button-info-fill: #4d6bfe !important;
  --dsw-alias-button-info-hover: #3f5cf0 !important;
  --dsw-alias-state-business-primary: #4d6bfe !important;

  --dsw-alias-bg-base: #ffffff !important;
  --dsw-alias-bg-layer-1: #ffffff !important;
  --dsw-alias-bg-layer-2: #f3f4f6 !important;
  --dsw-alias-bg-layer-3: #edeff2 !important;
  --dsw-alias-bg-module-platform: #f1f3f6 !important;
  --dsw-alias-bg-overlay: #ffffff !important;

  --dsw-alias-label-primary: #1b1b1f !important;
  --dsw-alias-label-secondary: #4f535a !important;
  --dsw-alias-label-tertiary: #5f646c !important;
  --dsw-alias-label-caption: #767b84 !important;

  --dsw-alias-border-l1: #e9ebef !important;
  --dsw-alias-border-l2: #d7dce3 !important;
  --dsw-alias-border-l3: #ccd2da !important;
  --dsw-alias-border-l4: #c9cfd7 !important;

  --dsw-alias-interactive-bg-hover: #eef1f5 !important;
  --dsw-alias-interactive-bg-active: #e5eaf0 !important;

  --dsw-alias-button-primary-fill: #4d6bfe !important;
  --dsw-alias-button-primary-hover: #3f5cf0 !important;
}

body[data-ds-dark-theme] {
  --dsw-alias-brand-primary: #6b83ff !important;
  --dsw-alias-button-primary-fill: #5b78ff !important;
  --dsw-alias-button-primary-hover: #4f6ef5 !important;

  --dsw-specific-sidebar-fill: #141416 !important;
  --dsw-specific-input-major: #26262b !important;
  --dsw-alias-button-info-fill: #5b78ff !important;
  --dsw-alias-button-info-hover: #4f6ef5 !important;
  --dsw-alias-state-business-primary: #6b83ff !important;

  --dsw-alias-bg-base: #1a1a1d !important;
  --dsw-alias-bg-layer-1: #1a1a1d !important;
  --dsw-alias-bg-layer-2: #202024 !important;
  --dsw-alias-bg-layer-3: #26262b !important;
  --dsw-alias-bg-module-platform: #1e1e22 !important;
  --dsw-alias-bg-overlay: #242428 !important;

  --dsw-alias-label-primary: #ededf0 !important;
  --dsw-alias-label-secondary: #b4b8bf !important;
  --dsw-alias-label-tertiary: #aab0b8 !important;
  --dsw-alias-label-caption: #7f838b !important;

  --dsw-alias-border-l1: #2a2a2f !important;
  --dsw-alias-border-l2: #3a3a42 !important;
  --dsw-alias-border-l3: #43434c !important;
  --dsw-alias-border-l4: #464650 !important;

  --dsw-alias-interactive-bg-hover: #303036 !important;
  --dsw-alias-interactive-bg-active: #34343c !important;
}
`;

		function BrandMark() {
			return jsx("svg", {
				width: 22,
				height: 22,
				viewBox: "0 0 24 24",
				fill: "none",
				"aria-hidden": true,
				style: { color: "var(--dsw-alias-brand-primary)" },
				children: [
					jsx("circle", { key: "core", cx: 12, cy: 12, r: 3.1, fill: "currentColor" }),
					jsx("ellipse", {
						key: "orbit",
						cx: 12,
						cy: 12,
						rx: 10,
						ry: 4.4,
						stroke: "currentColor",
						strokeWidth: 1.6,
						transform: "rotate(-28 12 12)",
					}),
					jsx("circle", { key: "moon", cx: 20.1, cy: 7.3, r: 1.5, fill: "currentColor" }),
				],
			});
		}

		function BrandName() {
			return jsx("span", {
				style: { fontWeight: 600, letterSpacing: "0.01em", whiteSpace: "nowrap" },
				children: "AstroNexus",
			});
		}

		function hidePreviewBadge() {
			const hero = document.querySelector('[class*="hero"]');
			if (!hero) return;
			for (const el of hero.querySelectorAll("span,div")) {
				if (el.children.length === 0 && (el.textContent === "预览版" || el.textContent === "Preview")) {
					el.style.display = "none";
				}
			}
		}

		function apply(ctx) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@astronexus/dsh-bundle";
			tag.textContent = css;
			document.head.appendChild(tag);
			if (ctx && typeof ctx.effect === "function") {
				ctx.effect(() => () => tag.remove());
			}
			if (ctx && ctx.slots) {
				ctx.slots.inject("sidebar.brand.mark", () => ctx.slots.inject("sidebar.brand.name", function* () {
					yield ctx.slots.register({ name: "sidebar.brand.mark" }, BrandMark);
					yield ctx.slots.register({ name: "sidebar.brand.name" }, BrandName);
				}));
			}
			if (typeof MutationObserver === "function") {
				const observer = new MutationObserver(() => hidePreviewBadge());
				observer.observe(document.body, { childList: true, subtree: true });
				hidePreviewBadge();
				if (ctx && typeof ctx.effect === "function") {
					ctx.effect(() => () => observer.disconnect());
				}
			}
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		exports.name = "astronexus-theme";
		return module.exports;
	},
});
