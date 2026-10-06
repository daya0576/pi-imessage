type MemoryRecord = Record<string, unknown> & { text: string; namespace: string };

/** Read-only UI projection; never changes records or implements memory writes. */
export function parseMemoryFile(contents: string, namespace: string) {
	const records: MemoryRecord[] = [];
	let invalidRecords = 0;
	for (const line of contents.split("\n").filter((line) => line.trim())) {
		try {
			const record: unknown = JSON.parse(line);
			if (
				!record ||
				typeof record !== "object" ||
				Array.isArray(record) ||
				!("text" in record) ||
				typeof record.text !== "string"
			) {
				invalidRecords++;
				continue;
			}
			records.push({
				...record,
				text: record.text,
				namespace:
					"namespace" in record && typeof record.namespace === "string" && record.namespace
						? record.namespace
						: namespace,
			});
		} catch {
			invalidRecords++;
		}
	}
	return { namespace, records, invalidRecords };
}

/** Filter complete records before returning one page, with supersession resolved across namespaces. */
export function memoryPage(files: ReturnType<typeof parseMemoryFile>[], parameters: URLSearchParams) {
	const requestedPage = parameters.get("page") ?? "1";
	if (!/^[1-9]\d*$/.test(requestedPage) || !Number.isSafeInteger(Number(requestedPage)))
		throw new Error("Invalid memory page");
	const query = {
		q: parameters.get("q") ?? "",
		namespace: parameters.get("namespace") ?? "",
		kind: parameters.get("kind") ?? "",
		status: parameters.get("status") ?? "active",
	};
	const records = files.flatMap((file) => file.records);
	const superseded = new Set(
		records.flatMap((record) =>
			typeof record.supersedes === "string"
				? [record.supersedes]
				: Array.isArray(record.supersedes)
					? record.supersedes.filter((id): id is string => typeof id === "string")
					: [],
		),
	);
	const search = query.q.toLowerCase();
	const filtered = records
		.map((record): MemoryRecord & { effectiveStatus: string } => ({
			...record,
			effectiveStatus:
				typeof record.id === "string" && superseded.has(record.id)
					? "superseded"
					: typeof record.status === "string" && record.status
						? record.status
						: "unknown",
		}))
		.filter(
			(record) =>
				(!query.namespace || record.namespace === query.namespace) &&
				(!query.kind || record.kind === query.kind) &&
				(!query.status || record.effectiveStatus === query.status) &&
				(!search || JSON.stringify(record).toLowerCase().includes(search)),
		)
		.sort((left, right) => String(right.created_at || "").localeCompare(String(left.created_at || "")));
	const pageSize = 20;
	const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
	const page = Math.min(Number(requestedPage), pages);
	return {
		records: filtered.slice((page - 1) * pageSize, page * pageSize),
		total: filtered.length,
		recordCount: records.length,
		page,
		pages,
		pageSize,
		query,
		namespaces: [
			...new Set(files.map((file) => file.namespace).concat(records.map((record) => record.namespace))),
		].sort(),
		kinds: [
			...new Set(
				records.flatMap((record) => (typeof record.kind === "string" && record.kind ? [record.kind] : [])),
			),
		].sort(),
		invalidRecords: files.reduce((total, file) => total + file.invalidRecords, 0),
	};
}
