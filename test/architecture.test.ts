import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { expect, it } from "vitest";

it("keeps source imports within a package or pointing down the architecture", async () => {
	const root = resolve("src");
	const layers: Record<string, number> = {
		host: 1,
		web: 2,
		agent: 3,
		extensions: 4,
		transport: 5,
		config: 6,
	};
	const packageName = (path: string) => (["main.ts", "cli.ts"].includes(path) ? "host" : path.split("/")[0]);
	const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".ts"));
	for (const file of files) {
		const sourcePackage = packageName(file);
		expect(layers[sourcePackage], file).toBeDefined();
		const source = await readFile(resolve(root, file), "utf8");
		expect(source, file).not.toMatch(/\b(?:import|require)\s*\(/);
		for (const match of source.matchAll(/\b(?:from\s*|import\s*)["']([^"']+)["']/g)) {
			const specifier = match[1];
			if (!specifier.startsWith(".")) {
				expect(specifier.startsWith("/"), file).toBe(false);
				continue;
			}
			expect(specifier.endsWith(".ts"), file).toBe(true);
			const target = relative(root, resolve(root, dirname(file), specifier));
			const targetPackage = packageName(target);
			expect(layers[targetPackage], target).toBeDefined();
			expect(
				targetPackage === sourcePackage || layers[targetPackage] > layers[sourcePackage],
				`${file} -> ${target}`,
			).toBe(true);
		}
	}
});
