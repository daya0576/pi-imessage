import { cpSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
for (const relative of ["web/templates", "shared-scheduler"]) {
	const destination = fileURLToPath(new URL(`dist/${relative}/`, root));
	mkdirSync(destination, { recursive: true });
	cpSync(fileURLToPath(new URL(`src/${relative}/`, root)), destination, { recursive: true });
}
