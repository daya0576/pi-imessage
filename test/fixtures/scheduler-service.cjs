// External service boundary fixture. It supplies API callbacks, not a clock or scheduler implementation.
exports.apiVersion = 1;
exports.createServiceBackend = () => {
	const worker = { start() {}, async stop() {} };
	return {
		parseWhen: () => 4102444800000,
		parseDuration: () => 3600000,
		createReminderService: () => {
			const records = [];
			return {
				...worker,
				create(input) {
					const reminder = { ...input, id: "fixture-reminder", status: "pending" };
					records.push(reminder);
					return { reminder, created: true };
				},
				list: () => records,
				cancel(id) {
					const row = records.find((row) => row.id === id);
					if (row) row.status = "cancelled";
					return row;
				},
			};
		},
		createSchedulerService: () => ({
			...worker,
			schedule(input) {
				return { ...input, id: "fixture-task" };
			},
			list: () => [],
			cancel: () => null,
			history: () => [],
		}),
		createBackgroundService: () => ({
			...worker,
			list: () => [],
			history: () => [],
			create: (input) => ({ ...input, id: "fixture-background" }),
			async tick() {},
		}),
		createCronService: (config) => {
			const runs = [];
			const job = {
				id: "fixture-cron",
				enabled: true,
				action: { type: "prompt", chatGuid: "chat", command: ["/bin/echo", "Cron-only request"] },
			};
			return {
				...worker,
				list: () => [job],
				listRuns: () => runs,
				async runNow(id) {
					if (id !== job.id) throw new Error("Missing job");
					const run = { id: `fixture-run-${runs.length}`, jobId: id, status: "running" };
					runs.unshift(run);
					await config.execute(job, new AbortController().signal);
					run.status = "success";
					return run;
				},
				setEnabled(_id, enabled) {
					job.enabled = enabled;
					return job;
				},
				reload() {},
			};
		},
	};
};
