import type { Routine } from "@rakazo/contracts";
import { RoutineListHeader, RoutineListRow } from "../RoutineEditor";

/** The bot's routines; each one, and a new one, opens in the routine editor. */
export function RoutinesTab({
  routines,
  runningRoutineId,
  onOpen,
  onStop,
}: {
  routines: Routine[];
  runningRoutineId: string | null;
  /** `null` writes a new routine. */
  onOpen: (routine: Routine | null) => void;
  onStop: () => void;
}) {
  return (
    <div data-testid="bot-routines">
      <RoutineListHeader onCreate={() => onOpen(null)} />
      {routines.map((routine) => (
        <RoutineListRow
          key={routine.id}
          routine={routine}
          running={routine.id === runningRoutineId}
          onOpen={() => onOpen(routine)}
          onStop={onStop}
        />
      ))}
    </div>
  );
}
