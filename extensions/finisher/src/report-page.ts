import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { goalPageMaxOffset, goalPageWindow } from "./goal-page.ts";

export const REPORT_HIT = -2;
export const REPORT_MARK = "📄";
export const REPORT_PAGE_KEYS = "Esc close · ↑↓ scroll · PgUp/PgDn page · g/G top/bottom";
export const REPORT_PAGE_MIN_ROWS = 4;

export interface HudReport {
	outcome?: string;
	laps?: number;
	at?: number;
	goal?: string;
}

export const reportRowText = (r: HudReport): string => `${REPORT_MARK} report · ${r.outcome ?? "closed"} · ${r.laps ?? 0} laps · click to read`;

export const reportIdleTail = (r: HudReport): string => ` · ${REPORT_MARK} report`;

export const withReportTail = (line: string, tail: string, width: number): string => {
	const room = Math.max(0, Math.floor(width));
	if (!room) return "";
	if (visibleWidth(tail) >= room) return truncateToWidth(tail, room, "…");
	return truncateToWidth(line, room - visibleWidth(tail), "…") + tail;
};

export const reportPageTitle = (r: HudReport): string => `${REPORT_MARK} report · ${r.outcome ?? "closed"} · ${r.laps ?? 0} laps`;

const pad = (n: number): string => String(n).padStart(2, "0");

export const reportWrittenLabel = (at: number | undefined): string => {
	if (!at) return "";
	const d = new Date(at);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const reportPageSummary = (r: HudReport): string => {
	const written = reportWrittenLabel(r.at);
	return [r.goal ?? "", written ? `written ${written}` : ""].filter(Boolean).join(" · ");
};

export const reportPageLines = (text: string): string[] => {
	const lines = text.split(/\r?\n/);
	while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
	return lines;
};

export const reportPageWindow = (total: number, rows: number, offset: number, size = REPORT_PAGE_MIN_ROWS): { from: number; to: number } =>
	goalPageWindow(total, rows, offset, size);

export const reportPageMaxOffset = (total: number, rows: number): number => goalPageMaxOffset(total, rows);
