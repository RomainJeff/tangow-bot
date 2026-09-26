// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider, useNavigate } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { useMemoryDraftGuard } from "./use-memory-draft-guard";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Editor() {
  const navigate = useNavigate();
  const saved = useMemoryDraftGuard(true, "Discard draft?");
  return (
    <button
      type="button"
      onClick={() => {
        saved();
        void navigate("/done");
      }}
    >
      Save
    </button>
  );
}

it("preserves a dirty editor on canceled history navigation, then allows explicit discard", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const router = createMemoryRouter(
    [
      { path: "/edit", element: <Editor /> },
      { path: "/done", element: <p>Done</p> },
    ],
    { initialEntries: ["/done", "/edit"] },
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<RouterProvider router={router} />);
    });
    await act(async () => {
      await router.navigate(-1);
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(router.state.location.pathname).toBe("/edit");
    expect(container.textContent).toBe("Save");
    confirm.mockReturnValue(true);
    await act(async () => {
      await router.navigate(-1);
    });
    expect(router.state.location.pathname).toBe("/done");
  } finally {
    await act(async () => root.unmount());
    router.dispose();
  }
});

it("does not ask to discard a successfully saved draft", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const confirm = vi.spyOn(window, "confirm");
  const router = createMemoryRouter(
    [
      { path: "/edit", element: <Editor /> },
      { path: "/done", element: <p>Done</p> },
    ],
    { initialEntries: ["/edit"] },
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<RouterProvider router={router} />);
    });
    await act(async () => {
      container.querySelector("button")!.click();
    });
    expect(router.state.location.pathname).toBe("/done");
    expect(confirm).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    router.dispose();
  }
});
