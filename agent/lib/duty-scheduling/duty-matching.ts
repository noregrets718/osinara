/** Exact maximum matching with lexicographic costs; residual edges allow reassignment. */
import { AppError } from "../app-error.js";
import type { DutyPeriod } from "./duty-data.js";

export type DutyCost = readonly number[];
export type DutyMatchDemand = Readonly<{ objectId: string; people: number }>;
export type DutyMatchChoice = Readonly<{ residentId: string; objectId: string; period: DutyPeriod; cost: DutyCost }>;

type Edge = { to: number; reverse: number; capacity: number; cost: DutyCost };

/** Internal interface: unique demands/choices, integer capacities and equally sized costs. */
export function matchDutySlots<T extends DutyMatchChoice>(
  demands: readonly DutyMatchDemand[], capacities: ReadonlyMap<string, number>, choices: readonly T[], visit: () => void,
): T[] {
  const residents = [...capacities.keys()].sort();
  const objects = [...demands].sort((left, right) => compareText(left.objectId, right.objectId));
  const residentNodes = new Map(residents.map((id, index) => [id, index + 2]));
  const objectNodes = new Map(objects.map((item, index) => [item.objectId, index + residents.length + 2]));
  const graph: Edge[][] = Array.from({ length: residents.length + objects.length + 2 }, () => []);
  const source = 0;
  const sink = 1;
  const zero = Array<number>(choices[0]?.cost.length ?? 0).fill(0);

  function addEdge(from: number, to: number, capacity: number, cost: DutyCost): Edge {
    const forward = { to, reverse: graph[to].length, capacity, cost };
    const reverse = { to: from, reverse: graph[from].length, capacity: 0, cost: cost.map((part) => -part) };
    graph[from].push(forward);
    graph[to].push(reverse);
    return forward;
  }

  for (const [id, node] of residentNodes) addEdge(source, node, capacities.get(id) ?? 0, zero);
  objects.forEach((object, index) => addEdge(residents.length + index + 2, sink, object.people, zero));
  const tracked = [...choices].sort((left, right) =>
    compareText(left.residentId, right.residentId) || compareText(left.objectId, right.objectId)
  ).map((choice) => {
    const from = residentNodes.get(choice.residentId);
    const to = objectNodes.get(choice.objectId);
    if (from === undefined || to === undefined) throw new AppError("AGENT_DUTY_MATCH_INVALID", "Неизвестный участник подбора");
    return { choice, edge: addEdge(from, to, 1, choice.cost) };
  });

  while (true) {
    visit();
    const distance: (DutyCost | undefined)[] = Array(graph.length).fill(undefined);
    const previous: ({ from: number; edge: number } | undefined)[] = Array(graph.length).fill(undefined);
    distance[source] = zero;
    // Bellman–Ford also handles negative reverse edges after earlier assignments.
    for (let pass = 0; pass < graph.length - 1; pass += 1) {
      let changed = false;
      for (let from = 0; from < graph.length; from += 1) {
        const before = distance[from];
        if (before === undefined) continue;
        graph[from].forEach((edge, index) => {
          if (edge.capacity <= 0) return;
          const next = addDutyCosts(before, edge.cost);
          const old = distance[edge.to];
          if (old === undefined || compareDutyCosts(next, old) < 0) {
            distance[edge.to] = next;
            previous[edge.to] = { from, edge: index };
            changed = true;
          }
        });
      }
      if (!changed) break;
    }
    if (distance[sink] === undefined) break;
    for (let node = sink; node !== source;) {
      const step = previous[node];
      if (step === undefined) throw new AppError("AGENT_DUTY_MATCH_INVALID", "Не удалось восстановить путь подбора");
      const edge = graph[step.from][step.edge];
      edge.capacity -= 1;
      graph[node][edge.reverse].capacity += 1;
      node = step.from;
    }
  }
  return tracked.filter((item) => item.edge.capacity === 0).map((item) => item.choice);
}

export function addDutyCosts(left: DutyCost, right: DutyCost): DutyCost {
  if (left.length !== right.length) throw new AppError("AGENT_DUTY_COST_INVALID", "Несовместимые критерии подбора");
  return left.map((part, index) => {
    const value = part + right[index];
    if (!Number.isSafeInteger(value)) throw new AppError("AGENT_DUTY_COST_INVALID", "Числовые показатели слишком велики для точного подбора");
    return value;
  });
}

export function compareDutyCosts(left: DutyCost, right: DutyCost): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
