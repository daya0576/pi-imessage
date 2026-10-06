import type { JsonValue } from "@earendil-works/chord";
import { type ConversationId, defineDoc, type Extension, type Tx } from "@earendil-works/pi-durable";

/** A workspace extension declares cadence; the host owns admission and delivery. */
export type WorkspaceSchedule = {
	id: string;
	name: string;
	kind?: string;
	enabled: boolean;
	task: string;
	time?: string;
	intervalMs?: number;
	chatGuid?: string;
	input?: JsonValue;
	initialize?(tx: Tx, conversationId: ConversationId): Promise<void>;
};

export type WorkspaceExtension = Extension & { schedules?: readonly WorkspaceSchedule[] };

/** Business state and outgoing items can be committed together by a native extension task. */
export const ScheduledOutbox = defineDoc<{
	items: { chatGuid: string; requestId: string; text: string }[];
}>({
	kind: "imessage.scheduled-outbox",
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
});

export function validateSchedules(extensions: readonly WorkspaceExtension[]) {
	const ids = new Set(["compact-chats"]);
	for (const extension of extensions) {
		for (const schedule of extension.schedules ?? []) {
			if (!schedule.id?.trim() || !schedule.name?.trim() || typeof schedule.enabled !== "boolean")
				throw new Error("Schedule requires id, name and enabled");
			if (ids.has(schedule.id)) throw new Error(`Duplicate schedule ID: ${schedule.id}`);
			ids.add(schedule.id);
			if (!extension.tasks?.some((task) => task.definition.name === schedule.task))
				throw new Error(`Schedule task is not owned by extension: ${schedule.task}`);
			if (
				(schedule.time === undefined) === (schedule.intervalMs === undefined) ||
				(schedule.time !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) ||
				(schedule.intervalMs !== undefined &&
					(!Number.isSafeInteger(schedule.intervalMs) || schedule.intervalMs <= 0))
			)
				throw new Error("Schedule requires either HH:MM time or a positive intervalMs");
		}
	}
}
