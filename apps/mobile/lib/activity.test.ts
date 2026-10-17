import { beforeEach, describe, expect, it, vi } from "vitest";
import { activityStatusLabel } from "./activity";
import { resetI18nForTests } from "./i18n";

vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

describe("activityStatusLabel", () => {
  beforeEach(() => resetI18nForTests("en"));

  it("says a run waiting on the person is waiting for them", () => {
    expect(activityStatusLabel("waiting_input")).toBe("Waiting for you");
    expect(activityStatusLabel("waiting_takeover")).toBe("Needs takeover");
  });
});
