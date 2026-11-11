# Computer template for E2B

Builds the E2B template of the computer from the canonical image in [`../Dockerfile`](../Dockerfile), the same image the Docker computer runs. It needs no change to E2B.

The product creates computers from the template named `desktop`, the `@e2b/desktop` SDK default, so `desktop` is the default name here.

## What the template adds to the image

- `template.ts` starts from the image by digest. The SDK cannot build a multi-stage Dockerfile, so Docker builds the image first.
- E2B's sandbox user is `user`; the image runs as `rakazo` 1000:1000. The build gives `user` uid/gid 1000 and moves the image's home to `/home/user`.
- It creates `/workspace`, where the bot and shared volumes mount.
- It copies the managed skills from `skills/agent` and `skills/computer` to `/managed-skills`, read-only.
- It keeps the image's start command and waits for X and noVNC.
- The profile is 2 vCPU and 4096 MiB.

Each bot's Chrome profile stays on the machine's own disk, under `/home/user/.browser-profiles/<botId>`, because Chrome's file locks do not work on the NFS volumes. A pause keeps that disk. Before an update or a recover replaces the machine, the product archives each profile to `.rakazo/browser-profiles.tgz` on the bot's private volume; the new machine restores it.

## Build

1. Build the image for amd64. Push it to a registry the E2B host can pull from, then keep the digest:

   ```bash
   docker build --platform linux/amd64 -t <registry>/rakazo-computer infra/sandboxes/computer
   docker push <registry>/rakazo-computer
   docker inspect --format '{{index .RepoDigests 0}}' <registry>/rakazo-computer
   ```

   A registry bound to the host's loopback works: the template builder pulls from the host network.

2. Build the template. Run this where the E2B API and its file upload port are reachable, which on a self-hosted deployment usually means the host itself:

   ```bash
   pnpm install
   pnpm --filter @tangow/computer-e2b-template template:build --image <registry>/rakazo-computer@sha256:<digest>
   ```

   The SDK reads `E2B_API_KEY`, and `E2B_API_URL` or `E2B_DOMAIN`. Pass `--name <name>` to build a test template instead of `desktop`.

Building again under the same name adds a new build to that template, and new computers use it.

## Check

In a sandbox of the new template, `id user` prints uid and gid 1000. The worker live lanes take the template with `--computer-template <name>`; lane `h-product-recreate` checks that a browser profile survives a replacement.
