/** Semantic matching tests, including an independent exhaustive oracle for small graphs. */
import { describe, expect, it } from "vitest";

import { matchDutySlots, type DutyMatchChoice } from "./duty-matching.js";

function choice(residentId: string, objectId: string, cost = [0, 0]): DutyMatchChoice {
  return { residentId, objectId, period: "morning", cost };
}

const visit = () => {};

describe("matchDutySlots", () => {
  it("reassigns the flexible first choice to fill a constrained second object", () => {
    const selected = matchDutySlots([{ objectId: "a", people: 1 }, { objectId: "b", people: 1 }],
      new Map([["r1", 1], ["r2", 1]]), [choice("r1", "a"), choice("r2", "a"), choice("r1", "b")], visit);
    expect(selected.map((item) => `${item.objectId}/${item.residentId}`).sort()).toEqual(["a/r2", "b/r1"]);
  });

  it("keeps the primary criterion ahead of any secondary score", () => {
    const selected = matchDutySlots([{ objectId: "a", people: 1 }], new Map([["r1", 1], ["r2", 1]]),
      [choice("r1", "a", [1, 0]), choice("r2", "a", [0, 999])], visit);
    expect(selected[0].residentId).toBe("r2");
  });

  it("minimizes actual combined workload rather than sums of candidate positions", () => {
    const selected = matchDutySlots([{ objectId: "a", people: 1 }, { objectId: "b", people: 1 }],
      new Map([["r1", 1], ["r2", 1], ["r3", 1]]),
      [choice("r1", "a", [0, 0]), choice("r2", "a", [100, 0]), choice("r1", "b", [0, 0]), choice("r3", "b", [1, 0])], visit);
    expect(selected.map((item) => `${item.objectId}/${item.residentId}`).sort()).toEqual(["a/r1", "b/r3"]);
  });

  it("respects daily capacity but never puts the same person twice on one object", () => {
    const capacity = new Map([["r1", 2]]);
    expect(matchDutySlots([{ objectId: "a", people: 1 }, { objectId: "b", people: 1 }], capacity,
      [choice("r1", "a"), choice("r1", "b")], visit)).toHaveLength(2);
    expect(matchDutySlots([{ objectId: "a", people: 2 }], capacity, [choice("r1", "a")], visit)).toHaveLength(1);
  });

  it("rejects unsafe numeric costs instead of rounding a fairness decision", () => {
    expect(() => matchDutySlots([{ objectId: "a", people: 1 }], new Map([["r1", 1]]),
      [choice("r1", "a", [Number.MAX_SAFE_INTEGER + 1, 0])], visit)).toThrow("AGENT_DUTY_COST_INVALID");
  });

  it("matches an independent brute-force optimum for all 64 three-person/two-object graphs", () => {
    const residents = ["r0", "r1", "r2"];
    const objects = ["a", "b"];
    const edges = residents.flatMap((residentId, row) => objects.map((objectId, column) => choice(residentId, objectId, [row, (row + column) % 2])));
    for (let mask = 0; mask < 64; mask += 1) {
      const available = edges.filter((_edge, index) => (mask & (1 << index)) !== 0);
      let optimum = [-1, Infinity, Infinity];
      for (const first of [undefined, ...available.filter((edge) => edge.objectId === "a")]) {
        for (const second of [undefined, ...available.filter((edge) => edge.objectId === "b")]) {
          if (first && second && first.residentId === second.residentId) continue;
          const count = Number(first !== undefined) + Number(second !== undefined);
          const primary = (first?.cost[0] ?? 0) + (second?.cost[0] ?? 0);
          const secondary = (first?.cost[1] ?? 0) + (second?.cost[1] ?? 0);
          if (count > optimum[0] || (count === optimum[0] && (primary < optimum[1] || (primary === optimum[1] && secondary < optimum[2])))) {
            optimum = [count, primary, secondary];
          }
        }
      }
      const result = matchDutySlots(objects.map((objectId) => ({ objectId, people: 1 })),
        new Map(residents.map((id) => [id, 1])), available, visit);
      expect([result.length, result.reduce((sum, edge) => sum + edge.cost[0], 0), result.reduce((sum, edge) => sum + edge.cost[1], 0)]).toEqual(optimum);
    }
  });
});
