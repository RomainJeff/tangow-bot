// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ requestPasswordReset: vi.fn() }));
vi.mock("../lib/auth", () => ({ authClient: auth }));
vi.mock("../lib/rpc", () => ({ clearSpaceSelection: () => undefined }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@tangow/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Label: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

import { AuthPage } from "./Auth";

afterEach(() => {
  vi.unstubAllGlobals();
  auth.requestPasswordReset.mockReset();
  document.body.innerHTML = "";
});

async function renderForgot(capabilities: Promise<Response>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", () => capabilities);
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <MemoryRouter>
        <AuthPage mode="forgot" />
      </MemoryRouter>,
    );
  });
  const email = container.querySelector<HTMLInputElement>("#email")!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(email, "person@example.test");
    email.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const button = container.querySelector<HTMLButtonElement>("button[type=submit]")!;
  return { container, button };
}

it("waits for capabilities before sending a reset link", async () => {
  let respond!: (response: Response) => void;
  const { container, button } = await renderForgot(
    new Promise((resolve) => {
      respond = resolve;
    }),
  );
  auth.requestPasswordReset.mockResolvedValue({ error: null });

  await act(async () => button.click());
  expect(button.disabled).toBe(true);
  expect(container.querySelector("[role=alert]")).toBeNull();

  await act(async () => {
    respond(
      new Response(
        JSON.stringify({ passwordReset: true, resetUrl: "https://tangow.test/reset-password" }),
      ),
    );
  });
  expect(button.disabled).toBe(false);

  await act(async () => button.click());
  expect(auth.requestPasswordReset.mock.calls).toEqual([
    [{ email: "person@example.test", redirectTo: "https://tangow.test/reset-password" }],
  ]);
  expect(container.querySelector("h1")?.textContent).toBe("Check your email");
});

it("reports recovery as unavailable once capabilities fail to load", async () => {
  const { container, button } = await renderForgot(Promise.reject(new Error("offline")));

  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(container.querySelector("[role=alert]")?.textContent).toBe(
    "Password recovery is not configured for this server",
  );
});
