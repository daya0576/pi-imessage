/** Calendar dates follow the service process timezone, including an explicit TZ override. */
export function localDate(timestamp: number) {
	const date = new Date(timestamp);
	return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
		.map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0"))
		.join("-");
}

/** Date applies local daylight-saving rules: shift gaps forward and choose the first repeated time. */
export function dailyTime(time: string, timestamp: number, dayOffset = 0) {
	const date = new Date(timestamp);
	const [hours, minutes] = time.split(":").map(Number);
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset, hours, minutes).getTime();
}

/** Advance by a calendar day, which need not be 24 elapsed hours. */
export function nextDaily(time: string, after: number) {
	const today = dailyTime(time, after);
	return today > after ? today : dailyTime(time, after, 1);
}
