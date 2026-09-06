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
