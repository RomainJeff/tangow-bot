import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Field, FieldLabel, Input, UserAvatar } from "@rakazo/ui-web";
import { useId, useRef, useState } from "react";
import { SuccessPop } from "../components/ai/primitives";
import { authClient } from "../lib/auth";

const PROFILE_PHOTO_SIZE = 128;
// Mirrors the server guard in @rakazo/auth: the photo rides in every session payload.
const PROFILE_PHOTO_MAX_LENGTH = 32 * 1024;

/** Centre-cropped square WebP data URL, small enough to live on the session user. */
async function encodeProfilePhoto(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = PROFILE_PHOTO_SIZE;
  canvas.height = PROFILE_PHOTO_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    PROFILE_PHOTO_SIZE,
    PROFILE_PHOTO_SIZE,
  );
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/webp", 0.8);
  });
  if (!blob) throw new Error("Could not encode the photo");
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the photo"));
    reader.readAsDataURL(blob);
  });
}

export function ProfilePhoto({ initials }: { initials: string }) {
  const { t } = useLingui();
  const session = authClient.useSession();
  const photo = session.data?.user.image ?? null;
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(image: string | null) {
    setPending(true);
    setError(null);
    try {
      // better-auth signals its session store on /update-user, so every
      // useSession() subscriber picks the new photo up without a reload.
      const result = await authClient.updateUser({ image });
      if (result.error) setError(result.error.message ?? t`Could not update your photo`);
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      setPending(false);
    }
  }

  async function upload(file: File) {
    setError(null);
    let dataUrl: string;
    try {
      dataUrl = await encodeProfilePhoto(file);
    } catch {
      setError(t`That image could not be read`);
      return;
    }
    if (dataUrl.length > PROFILE_PHOTO_MAX_LENGTH) {
      setError(t`That image is too detailed to store, try a simpler one`);
      return;
    }
    await save(dataUrl);
  }

  return (
    <div className="mt-4 border-t border-border pt-4">
      <h4 className="text-[14px] font-medium text-foreground">
        <Trans>Profile photo</Trans>
      </h4>
      <div className="mt-3 flex items-center gap-4">
        <UserAvatar
          initials={initials}
          image={photo}
          className="size-14 text-title"
          data-testid="profile-photo-preview"
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            data-testid="profile-photo-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Clear the input so re-picking the same file fires change again.
              event.target.value = "";
              if (file) void upload(file);
            }}
          />
          <Button
            variant="secondary"
            className="rounded-full"
            disabled={pending}
            onClick={() => fileRef.current?.click()}
          >
            {photo ? <Trans>Change photo</Trans> : <Trans>Add photo</Trans>}
          </Button>
          {photo ? (
            <Button
              variant="ghost"
              className="rounded-full"
              disabled={pending}
              onClick={() => void save(null)}
            >
              <Trans>Remove</Trans>
            </Button>
          ) : null}
        </div>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function ChangePasswordSection({ email }: { email?: string | null }) {
  const { t } = useLingui();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function changePassword() {
    if (pending) return;
    if (newPassword !== confirmation) {
      setError(t`Passwords do not match`);
      return;
    }
    setPending(true);
    setSaved(false);
    setError(null);
    try {
      const result = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (result.error) {
        setError(result.error.message ?? t`Could not change password`);
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setSaved(true);
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded-xl border border-border px-4 py-4">
      <h3 className="text-[15px] font-medium text-foreground">
        <Trans>Password</Trans>
      </h3>
      <div className="mt-3 grid gap-3">
        <input
          type="text"
          name="username"
          autoComplete="username"
          value={email ?? ""}
          readOnly
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
        />
        <SettingsPasswordInput
          label={t`Current password`}
          autoComplete="current-password"
          value={currentPassword}
          onChange={setCurrentPassword}
        />
        <SettingsPasswordInput
          label={t`New password`}
          autoComplete="new-password"
          value={newPassword}
          onChange={setNewPassword}
        />
        <SettingsPasswordInput
          label={t`Confirm password`}
          autoComplete="new-password"
          value={confirmation}
          onChange={setConfirmation}
        />
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex items-center gap-3">
        <Button
          className="rounded-full"
          disabled={pending || currentPassword.length < 8 || newPassword.length < 8}
          onClick={() => void changePassword()}
        >
          {pending ? <Trans>Changing…</Trans> : <Trans>Change password</Trans>}
        </Button>
        {saved ? <SuccessPop label={t`Password updated`} /> : null}
      </div>
    </section>
  );
}

function SettingsPasswordInput({
  label,
  autoComplete,
  value,
  onChange,
}: {
  label: string;
  autoComplete: "current-password" | "new-password";
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="password"
        autoComplete={autoComplete}
        minLength={8}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
