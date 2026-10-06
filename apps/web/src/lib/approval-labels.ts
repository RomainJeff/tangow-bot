import { t } from "@lingui/core/macro";

type ApprovalAction = { id: string; label: string; outcome?: "created" | "cancelled" };

// A card that names an outcome carries its own server label; the client only
// translates the labels it knows and shows any other one as sent.
function serverLabel(label: string): string {
  switch (label) {
    case "Create space":
      return t`Create space`;
    case "Create bot":
      return t`Create bot`;
    case "Cancel":
      return t`Cancel`;
    default:
      return label;
  }
}

/** The button label of an approval action, shared by the thread card and the voice call. */
export function approvalActionLabel(action: ApprovalAction): string {
  if (action.outcome) return serverLabel(action.label);
  if (action.id === "allow") return t`Allow once`;
  if (action.id === "always") return t`Always allow this tool`;
  if (action.id === "deny") return t`Deny`;
  return action.label;
}
