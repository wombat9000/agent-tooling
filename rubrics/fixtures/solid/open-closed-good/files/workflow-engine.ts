import { PHASE_DEFINITIONS } from './phase-registry';
import type { CaseSnapshot } from './workflow-states';

export function advanceCase(snapshot: CaseSnapshot): CaseSnapshot {
  const definition = PHASE_DEFINITIONS[snapshot.phase];
  if (!definition.nextPhase || !definition.canAdvance(snapshot)) {
    throw new Error(`Case ${snapshot.id} cannot advance from ${snapshot.phase}`);
  }
  return { ...snapshot, phase: definition.nextPhase };
}

export function describeCasePhase(snapshot: CaseSnapshot): { readonly slaHours: number; readonly banner: string } {
  const definition = PHASE_DEFINITIONS[snapshot.phase];
  return {
    slaHours: definition.slaHours,
    banner: definition.statusBanner(snapshot),
  };
}
