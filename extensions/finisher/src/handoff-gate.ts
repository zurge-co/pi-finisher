export const HANDOFF_ENABLED = false;

export const HANDOFF_OFF_NOTE = "handoff: parked — the stack stays empty until it is switched on";

export const handoffOff = (): boolean => !HANDOFF_ENABLED;

export const emptyHandoff = <T>(): T[] => [];

export const handoffStackFor = <T>(items: T[] | undefined): T[] => (HANDOFF_ENABLED ? (items ?? []) : emptyHandoff<T>());

export const handoffInjectionFor = (body: string | undefined): string | undefined => (HANDOFF_ENABLED ? body : undefined);
