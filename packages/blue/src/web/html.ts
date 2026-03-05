/** HTML utility functions. */

/** Format as "MM-DD HH:MM". */
export function formatTime(iso: string): string {
	const date = new Date(iso);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hour = String(date.getHours()).padStart(2, "0");
	const minute = String(date.getMinutes()).padStart(2, "0");
	return `${month}-${day} ${hour}:${minute}`;
}

export function anchorId(guid: string): string {
	return guid.replace(/[^a-zA-Z0-9]/g, "_");
}
