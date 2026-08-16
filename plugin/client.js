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
		const { Button, Tooltip } = primitives;
		/** `pet` namespace dictionaries: the Web power switch button. */
		const zh = {
			"toggle.on": "开启桌宠",
			"toggle.off": "关闭桌宠",
			"toggle.failed": "操作失败，请重试"
		};
		const en = {
			"toggle.on": "Turn pet on",
			"toggle.off": "Turn pet off",
			"toggle.failed": "Action failed, try again"
		};
		/**
		* 电源开关图标（内联 SVG，原语库无 power 图标）：圆圈 + 顶部竖线。
		* active=true（桌宠开启）= 绿色；关闭 = 灰色。
		*/
		function PowerIcon({ size = 16, active = false }) {
			const color = active ? "#22C55E" : "#8A8F98";
			return react_jsx_runtime.jsxs("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				children: [
					react_jsx_runtime.jsx("circle", { cx: 8, cy: 8.6, r: 5.6, stroke: color, strokeWidth: 1.7 }),
					react_jsx_runtime.jsx("path", {
						d: "M8 3.2 V8.2",
						stroke: color,
						strokeWidth: 1.9,
						strokeLinecap: "round"
					})
				]
			});
		}
		/**
		* Sidebar footer power switch: reads /pet-bridge/state once, then toggles
		* via POST /pet-bridge/toggle. Green = pet on (click to turn off),
		* gray = pet off (click to turn on).
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
						// 服务暂不可用：乐观默认可见，保证按钮始终可操作
						// （点了 toggle 会拿到真实状态并纠正图标）。
						if (alive) setVisible(true);
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
			const on = visible !== false; // null（未知）按开启处理
			const label = on ? t("toggle.off") : t("toggle.on");
			return react_jsx_runtime.jsx(Tooltip, {
				label,
				delayMs: 400,
				children: react_jsx_runtime.jsx(Button, {
					variant: "ghost",
					size: "md",
					"aria-label": label,
					onClick: toggle,
					icon: react_jsx_runtime.jsx(PowerIcon, { size: 16, active: on })
				})
			});
		}
		/** Required services: slots (插槽注册) and locale (文案)。 */
		const inject = ["slots", "locale"];
		/** Register the footer switch and its dictionaries. */
		function apply(ctx) {
			const NS = "pet";
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-pet-bridge: dictionaries");
			// 官方模式（对照 dsh-client-ui-cordis）：inject 等待 sidebar 声明
			// sidebar.footer.action 插槽后，register 自己的条目（id 唯一）。
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "dsh-pet-toggle",
				locale: NS
			}, PetToggleButton));
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
