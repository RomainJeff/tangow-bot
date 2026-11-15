import { ORPCError } from "@orpc/server";
import type { EncryptedSecretStore } from "@tangow/adapters";
import {
  listBotSecrets,
  normalizeSecretDestination,
  removeBotSecret,
  storeBotSecret,
} from "@tangow/adapters";
import type { Actor, BotSecretDestination, VaultPutInput } from "@tangow/contracts";
import type { PrismaClient } from "@tangow/db";

type VaultDeps = { prisma: PrismaClient; secrets: EncryptedSecretStore };

/** The person's credentials in the active space: names, sites and methods, never values. */
export async function listVault(deps: VaultDeps, actor: Actor): Promise<BotSecretDestination[]> {
  return (await listBotSecrets(deps.prisma, actor)).map(normalizeSecretDestination);
}

/** Adds a credential, or replaces the value of one with the same name and destination. */
export async function putVaultItem(
  deps: VaultDeps,
  actor: Actor,
  { value, ...destination }: VaultPutInput,
): Promise<BotSecretDestination> {
  try {
    await deps.prisma.$transaction((tx) =>
      storeBotSecret({
        tx,
        secretStore: deps.secrets,
        scope: actor,
        destination,
        plaintext: value,
      }),
    );
  } catch (error) {
    // The store's errors describe the destination or the limit, never the value.
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Could not save",
    });
  }
  return normalizeSecretDestination(destination);
}

export async function removeVaultItem(deps: VaultDeps, actor: Actor, name: string) {
  await removeBotSecret(deps.prisma, actor, name);
  return { ok: true as const };
}
