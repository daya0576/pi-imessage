import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Cron } from "croner";
import type { createBackgroundService, validateCompletionFile } from "./background.js";
import type { createCronService, parseCronConfig } from "./cron.js";
import type { createReminderService, parseReminderTime } from "./reminders.js";
import type { createSchedulerService, parseSchedulerInterval, parseSchedulerTime } from "./scheduler.js";

interface SchedulerBackend {
	createSchedulerService: typeof createSchedulerService;
	parseWhen: typeof parseSchedulerTime;
	parseDuration: typeof parseSchedulerInterval;
	createBackgroundService: typeof createBackgroundService;
	validateCompletionFile: typeof validateCompletionFile;
	createReminderService: typeof createReminderService;
	parseReminderTime: typeof parseReminderTime;
	createCronService: typeof createCronService;
	parseCronConfig: typeof parseCronConfig;
}
interface ServiceModule {
	apiVersion: 1;
	createServiceBackend(dependencies: { Database: typeof Database; Cron: typeof Cron }): SchedulerBackend;
}
const require = createRequire(import.meta.url);
/** No chat/session lifecycle and no fallback implementation or duplicate timers. */
export function schedulerBackend(): SchedulerBackend {
	const path = process.env.PI_SCHEDULER_SERVICE_PATH
		? resolve(process.env.PI_SCHEDULER_SERVICE_PATH)
		: fileURLToPath(new URL("./shared-scheduler/service.cjs", import.meta.url));
	let value: unknown;
	try {
		value = require(path);
	} catch (error) {
		throw new Error(`Shared Pi scheduler service unavailable at ${path}; build/copy the shared scheduler snapshot`, {
			cause: error,
		});
	}
	const service = value as Partial<ServiceModule> | null;
	if (service?.apiVersion !== 1 || typeof service.createServiceBackend !== "function") {
		throw new Error(`Unsupported shared Pi scheduler service API at ${path}`);
	}
	return service.createServiceBackend({ Database, Cron });
}
