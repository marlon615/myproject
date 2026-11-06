/**
 * Owner-dashboard chart colors (plain module so server and client components can both import it).
 * Checked with the dataviz palette validator against the white card surface (#ffffff):
 * terracotta + blue → CVD ΔE 24.2, normal-vision ΔE 27.9, both ≥ 3:1 contrast. All checks pass.
 */
export const SERIES = { terracotta: "#b45c33", blue: "#2a78d6" } as const;
