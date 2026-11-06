/**
 * Owner-dashboard chart colors (plain module so server and client components can both import it).
 * Orange / blue / green chosen to stay distinct for common color-vision deficiencies on white,
 * each ≥ 3:1 contrast against #ffffff. Every chart also has a table view.
 */
export const SERIES = { orange: "#d9531e", blue: "#2a6fd6", green: "#1f8a5a" } as const;
