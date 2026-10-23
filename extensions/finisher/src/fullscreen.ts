export const applyFullscreenDefault = (raw: string | undefined): { text: string; changed: boolean } | null => {
	if (raw === undefined || !raw.trim()) return { text: `${JSON.stringify({ tuiMode: "fullscreen" }, null, 2)}\n`, changed: true };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	if ("tuiMode" in (parsed as Record<string, unknown>)) return { text: raw, changed: false };
	return { text: `${JSON.stringify({ ...(parsed as Record<string, unknown>), tuiMode: "fullscreen" }, null, 2)}\n`, changed: true };
};
