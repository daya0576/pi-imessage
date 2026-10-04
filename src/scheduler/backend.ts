import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import Database from "better-sqlite3";
import { Cron } from "croner";
import type { createBackgroundService, validateCompletionFile } from "./background.ts";
import type { createCronService, parseCronConfig } from "./cron.ts";
import type { createReminderService, parseReminderTime } from "./reminders.ts";
import type { createSchedulerService, parseSchedulerInterval, parseSchedulerTime } from "./scheduler.ts";

interface SchedulerBackend {
	createBackgroundService: typeof createBackgroundService;
	validateCompletionFile: typeof validateCompletionFile;
	createCronService: typeof createCronService;
	parseCronConfig: typeof parseCronConfig;
	createReminderService: typeof createReminderService;
	parseReminderTime: typeof parseReminderTime;
	createSchedulerService: typeof createSchedulerService;
	parseWhen: typeof parseSchedulerTime;
	parseDuration: typeof parseSchedulerInterval;
}

// External, installed CommonJS service boundary; never load SDK extension entry points or a local copy.
const loadService = createRequire(import.meta.url);
export function schedulerBackend(): SchedulerBackend {
	const path = process.env.PI_SCHEDULER_SERVICE_PATH
		? resolve(process.env.PI_SCHEDULER_SERVICE_PATH)
		: join(getAgentDir(), "extensions", "scheduler", "service.cjs");
	const service = loadService(path) as {
		apiVersion?: number;
		createServiceBackend?: (dependencies: {
			Database: typeof Database;
			Cron: typeof Cron;
		}) => SchedulerBackend;
	};
	if (service?.apiVersion !== 1 || typeof service.createServiceBackend !== "function")
		throw new Error(`Unsupported shared scheduler API at ${path}`);
	return service.createServiceBackend({ Database, Cron });
}
