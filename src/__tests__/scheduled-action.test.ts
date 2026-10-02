import { fileURLToPath } from "node:url";
import { Eta } from "eta";
import { expect, it } from "vitest";

const eta = new Eta({ views: fileURLToPath(new URL("../web/templates", import.meta.url)) });
it("clamps recurring action previews to three lines without truncating data or changing table cells", () => {
	const action = { type: "prompt", prompt: `${"Synthetic long action. ".repeat(100)}END-OF-ACTION` };
	const html = eta.render("scheduled", {
		jobs: [{ id: "test", name: "Fixture", enabled: false, action }],
		runs: [],
		reminders: [],
		configPath: "fixture",
	});
	expect(html).toContain("-webkit-line-clamp: 3");
	expect(html).toContain("max-height: 4.8em");
	expect(html).toContain('<td class="action"><div class="action-preview"');
	expect(html).toContain("END-OF-ACTION");
	expect(html).toContain("data-app-shell");
	expect(html).toContain('onclick="runJob(');
	expect(html).toContain('onclick="toggleJob(');
});
it("escapes action text and title and leaves reminder text outside the action-only clamp", () => {
	const attack = '"><img src=x onerror="bad()">';
	const html = eta.render("scheduled", {
		jobs: [{ id: "test", action: { type: "prompt", prompt: attack } }],
		runs: [],
		reminders: [{ status: "pending", text: "REMINDER-CONTENT" }],
		configPath: "fixture",
	});
	expect(html).not.toContain("<img");
	expect(html).toContain("&lt;img");
	expect(html).toContain('<td class="action">REMINDER-CONTENT</td>');
	expect(html.match(/class="action-preview"/g)).toHaveLength(1);
});
