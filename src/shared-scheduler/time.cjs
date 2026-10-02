// Shared parser. Preserve the interactive scheduler's accepted forms and local-clock semantics.
function parseDuration(spec) {
	const m = spec.match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
	if (!m || !m[0]) return null;
	if (!m[1] && !m[2] && !m[3] && !m[4]) return null;
	const d = Number(m[1] ?? 0);
	const h = Number(m[2] ?? 0);
	const min = Number(m[3] ?? 0);
	const sec = Number(m[4] ?? 0);
	return (d * 86400 + h * 3600 + min * 60 + sec) * 1000;
}
function parseWhen(spec, now) {
	const s = spec.trim();
	if (s.startsWith("@")) {
		const n = Number(s.slice(1));
		if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
		throw new Error(`invalid epoch: ${s}`);
	}
	const dur = parseDuration(s);
	if (dur != null) return now + dur;
	const tomorrow = s.match(/^tomorrow[\s-]+(\d{1,2}):(\d{2})$/i);
	if (tomorrow) {
		const date = new Date(now);
		date.setDate(date.getDate() + 1);
		date.setHours(Number(tomorrow[1]), Number(tomorrow[2]), 0, 0);
		return date.getTime();
	}
	const hm = s.match(/^(\d{1,2}):(\d{2})$/);
	if (hm) {
		const hours = Number(hm[1]);
		const mins = Number(hm[2]);
		if (hours > 23 || mins > 59) throw new Error(`invalid time: ${s}`);
		const date = new Date(now);
		date.setHours(hours, mins, 0, 0);
		if (date.getTime() <= now) date.setDate(date.getDate() + 1);
		return date.getTime();
	}
	if (/[-/T]/.test(s)) {
		const t = new Date(s).getTime();
		if (Number.isFinite(t)) return t;
	}
	throw new Error(`could not parse "${spec}". Try a duration (3h, 90m, 1h30m), a time (14:30), or an ISO datetime.`);
}
function formatDuration(ms) {
	let s = Math.round(Math.max(0, ms) / 1000);
	const d = Math.floor(s / 86400);
	s -= d * 86400;
	const h = Math.floor(s / 3600);
	s -= h * 3600;
	const m = Math.floor(s / 60);
	s -= m * 60;
	const parts = [];
	if (d) parts.push(`${d}d`);
	if (h) parts.push(`${h}h`);
	if (m) parts.push(`${m}m`);
	if (s && !d && !h) parts.push(`${s}s`);
	return parts.join("") || "0s";
}
module.exports = { parseWhen, parseDuration, formatDuration };
