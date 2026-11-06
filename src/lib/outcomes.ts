/** Call outcome labels (plain module: usable from any component). */
export const OUTCOME_LABEL: Record<string, { label: string; cls: string }> = {
  booked: { label: "Booked", cls: "badge-sent" },
  emergency: { label: "Emergency · team alerted", cls: "badge-failed" },
  safety: { label: "Safety · team alerted", cls: "badge-failed" },
  handoff: { label: "Callback requested", cls: "badge-scheduled" },
  texted_back: { label: "Texted back", cls: "badge-scheduled" },
  hung_up: { label: "Hung up", cls: "badge-skipped" },
  closed: { label: "Not a service call", cls: "badge-skipped" },
  inactive: { label: "Line inactive", cls: "badge-skipped" },
};
