export interface HealthStatus { readonly ok: boolean; }
export function checkHealth(): HealthStatus { return { ok: true }; }
