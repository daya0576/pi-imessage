import { fileURLToPath } from "node:url";
import { Eta } from "eta";
import { expect, it } from "vitest";

const eta = new Eta({ views: fileURLToPath(new URL("../web/templates", import.meta.url)) });
const fixtures = {
	page: { blocks: [] },
	logs: { appLog: "<script>bad</script>", digestLog: "test" },
	memory: { globalMemory: "test", chatMemories: [] },
	scheduled: { jobs: [], runs: [], reminders: [], configPath: "fixture" },
	tasks: { tasks: [], runs: [] },
	sources: { sources: [], categories: [], generatedAt: "2026-09-06T00:00:00Z" },
};
for (const [name, data] of Object.entries(fixtures)) {
	it(`${name} renders the same responsive shell and exactly one active tab`, () => {
		const html = eta.render(name, data);
		expect(html).toContain('name="viewport"');
		expect(html).toContain('data-app-shell="v1"');
		expect(html).toContain("--nav-width: 160px");
		expect(html.match(/aria-current="page"/g)).toHaveLength(1);
		for (const href of ["/", "/scheduled", "/tasks", "/sources", "/logs", "/memory"]) {
			expect(html).toContain(`href="${href}"`);
		}
		expect(html).not.toContain("<script>bad</script>");
		expect(html).not.toContain("<%");
	});
}

it("keeps each source on one plain table row with a separate details button", () => {
	const sources = Array.from({ length: 15 }, (_, i) => ({
		id: `source-${i}`,
		category: "test",
		name: `Source ${i}`,
		phase: "needs_authorization",
		state: "blocked",
		reason: "collector_missing",
		method: "fixture",
		note: "private <text>",
		lastSuccessAt: null,
		checkedAt: "2026-09-06T00:00:00Z",
		recordCount: null,
		staleHours: 24,
	}));
	const html = eta.render("sources", {
		sources,
		categories: [{ id: "test", name: "Test category" }],
		generatedAt: "2026-09-06T00:00:00Z",
	});
	expect(html.match(/<tr data-source-id=/g)).toHaveLength(15);
	expect(html.match(/data-detail-id="source-/g)).toHaveLength(15);
	expect(html).not.toMatch(/<details[^>]*\sopen(?:\s|>|=)/);
	expect(html).toContain("private &lt;text&gt;");
	expect(html).toContain("缺少已验证的采集器");
	expect(html).toContain("状态证据时间");
	expect(html).toContain('data-detail-ui="v1"');
	expect(html).not.toContain("<summary>");
	expect(html).toContain("popovertarget=");
	expect(html).not.toContain("<script>");
});

it("uses the same details dialog for planned and paused tasks without changing controls", () => {
	const html = eta.render("tasks", {
		tasks: [
			{ id: "plan", name: "Plan <script>bad</script>", state: "planned", enabled: false },
			{ id: "paused", name: "Paused", state: "needs_human", paused: true, enabled: true },
		],
		runs: [{ taskId: "paused", summary: "Evidence <private>", status: "failed", startedAt: "2026-09-06T00:00:00Z" }],
	});
	expect(html.match(/<tr data-task-id=/g)).toHaveLength(2);
	expect(html.match(/data-detail-id="task-/g)).toHaveLength(2);
	expect(html).toContain('data-action="resume"');
	expect(html).toContain("仅规划，不执行");
	expect(html).toContain("Evidence &lt;private&gt;");
	expect(html).not.toContain("<summary>");
	expect(html).not.toContain("<script>bad</script>");
	expect(html).toContain("document.querySelector('[popover]:popover-open')");
	expect(html).toContain('data-detail-ui="v1"');
});
