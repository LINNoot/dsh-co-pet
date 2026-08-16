// dsh-pet-bridge — 浏览器端 bundle（client plugin）。
//
// 在 DSH Web GUI 侧边栏底部（sidebar.footer.action 插槽）注册一个桌宠
// 开关按钮：点击后经同源 HTTP 调用插件宿主路由 /pet-bridge/toggle，
// 控制桌宠窗口显示/隐藏；图标与提示文案随状态切换。
//
// 此文件是 __ModuleLoader__ 格式的手写 bundle（无需构建工具），由
// dsh-client-modules 在插件包的 package.json 声明 `dsh.client` +
// `exports["./client"]` 后自动发现并 serve。
window.__ModuleLoader__.load({
	id: "dsh-pet-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const { Button, Tooltip, IconPlayOutline16, IconPauseOutline16, IconLoadingOutline16 } = primitives;
		/** `pet` namespace dictionaries: the Web switch button. */
		const zh = {
			"toggle.show": "显示桌宠",
			"toggle.hide": "隐藏桌宠",
			"toggle.label": "桌宠开关",
			"toggle.failed": "操作失败，请重试"
		};
		const en = {
			"toggle.show": "Show pet",
			"toggle.hide": "Hide pet",
			"toggle.label": "Pet toggle",
			"toggle.failed": "Action failed, try again"
		};
		/**
		* Sidebar footer switch: reads /pet-bridge/state once, then toggles via
		* POST /pet-bridge/toggle. Icon shows the current visibility intent:
		* pause icon while visible (click = hide), play icon while hidden.
		*/
		function PetToggleButton(props) {
			const [visible, setVisible] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			react.useEffect(() => {
				let alive = true;
				fetch("/pet-bridge/state")
					.then((res) => res.json())
					.then((state) => {
						if (alive && typeof state.visible === "boolean") setVisible(state.visible);
					})
					.catch(() => {
						/* 服务暂不可用：保持未知态（占位图标） */
					});
				return () => {
					alive = false;
				};
			}, []);
			const toggle = () => {
				if (busy) return;
				setBusy(true);
				fetch("/pet-bridge/toggle", { method: "POST" })
					.then((res) => res.json())
					.then((state) => {
						if (typeof state.visible === "boolean") setVisible(state.visible);
					})
					.catch(() => {
						console.warn("[dsh-pet-bridge] toggle failed");
					})
					.finally(() => setBusy(false));
			};
			const t = (key) => props.t?.(key) ?? zh[key] ?? key;
			const label = visible === null ? t("toggle.label") : visible ? t("toggle.hide") : t("toggle.show");
			return react_jsx_runtime.jsx(Tooltip, {
				label,
				delayMs: 400,
				children: react_jsx_runtime.jsx(Button, {
					variant: "ghost",
					size: "md",
					"aria-label": label,
					onClick: toggle,
					icon: visible === null ? react_jsx_runtime.jsx(IconLoadingOutline16, { size: 16 }) : visible ? react_jsx_runtime.jsx(IconPauseOutline16, { size: 16 }) : react_jsx_runtime.jsx(IconPlayOutline16, { size: 16 })
				})
			});
		}
		/** Required services: slots (插槽注册) and locale (文案)。 */
		const inject = ["slots", "locale"];
		/** Register the footer switch and its dictionaries. */
		function apply(ctx) {
			const NS = "pet";
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-pet-bridge: dictionaries");
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "dsh-pet-toggle",
				locale: NS
			}, PetToggleButton), "dsh-pet-bridge: sidebar footer switch");
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
