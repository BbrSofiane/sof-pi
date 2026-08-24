---
name: fly-io
description: Use this skill when the user wants to interact with Fly.io via the `flyctl` CLI — deploying apps, launching from source, inspecting app and Machine health, scaling resources, and managing volumes, secrets, networking, certificates, or Managed Postgres (MPG). Also covers Fly.io resources provisioned through Stripe Projects and their macaroon-token handoff. Triggers on tasks like "deploy to fly", "launch a fly app", "check fly app status", "view fly logs", "scale my fly app", "set a fly secret", "manage my fly machines", or "set up a managed postgres cluster".
compatibility: "Requires the `flyctl` CLI installed (for example via mise as `flyctl`) and authenticated. Verify with `flyctl auth whoami`; use interactive login or FLY_API_TOKEN for headless/CI use. Stripe Projects resources use their documented macaroon tokens."
---

# Fly.io (`flyctl`)

Use `flyctl` to deploy and operate Fly.io apps, Machines, persistent volumes, networking, and Managed Postgres (MPG). Consult the [flyctl documentation](https://fly.io/docs/flyctl/) and command help for current syntax; this skill focuses on durable decisions and recurring pitfalls rather than a command catalog.

> **Use `flyctl`, not `fly`.** `flyctl` is the portable binary expected by this skill. In agentic or CI work, identify the target explicitly instead of relying on the current directory's configuration.

## Authentication and targeting

- Verify the active account before changing infrastructure.
- Use `FLY_API_TOKEN` or an explicitly supplied token in headless environments; treat tokens as secrets and never commit, print, or bake them into images.
- Pass the app and organization explicitly when more than one target is possible. A local `fly.toml` is useful context, not a sufficient target selector for automation.
- Prefer structured output where the command supports it, and inspect output before following up with a mutation.

### Stripe Projects macaroon tokens

Apps and MPG clusters provisioned through Stripe Projects use scoped macaroon credentials rather than interactive login. An app's `deploy_token` is app-scoped and requires the `FlyV1 ` prefix in `FLY_API_TOKEN`. An MPG `org_token` is organization-scoped and does not use that prefix; it covers MPG operations and apps in the same organization. Preserve the distinction and store the associated app/cluster identifiers with the credential.

Rotate these credentials through Stripe Projects, then replace the environment variable with the new token. Do not use a token outside its intended scope or assume that a successful identity check grants access to every app.

## App decision flow

1. **Inspect the repository and live state.** Find the intended `fly.toml` (including environment-specific variants), read its app name, and determine whether the app exists and has ever deployed. An existing app with no image is a first-deploy state; a live image indicates a normal subsequent deploy.
2. **Choose the creation path.** Let `flyctl launch` scaffold configuration from source when no config exists. Reuse an existing config only after reviewing its app ownership, build, services, regions, and secrets. Do not hand-write a replacement config when the launcher can safely generate one.
3. **Deploy deliberately.** Confirm the target app, build context, image, and deployment strategy. Review generated Dockerfiles and configuration before a first deploy, especially when source or a copied config is untrusted.
4. **Verify.** Check release/app status, Machine health, logs, routing, and the actual service endpoint. For a failed deploy, narrow the diagnosis from app/release state to the affected Machine and then its logs; do not repeatedly redeploy without identifying the failure.

## Resources and operational constraints

- **Machines:** app deploys are the normal path; use Machine-level operations only when granular start/stop/restart/exec or placement control is needed. Confirm the Machine ID and app before acting.
- **Scaling:** choose VM size, count, regions, and redundancy based on workload and availability requirements. Consider cost and data locality before changing them.
- **Volumes:** a volume is attached to a Machine in a region and is not shared like a network filesystem. Plan backups, region placement, and migration before changing Machines or deleting resources.
- **Secrets:** store runtime credentials in Fly secrets, never in `fly.toml` or images. Secret changes can create a new release/restart unless staged; tell the user when that operational effect matters.
- **Networking and certificates:** verify internal ports, service exposure, IP allocation, DNS, and certificate status together. A healthy Machine does not prove that the public route works.

## Managed Postgres (MPG)

Use **MPG** for Fly's fully managed Postgres. `flyctl postgres` refers to unmanaged Postgres apps on Machines and is not the managed service or the supported path.

MPG operations require the cluster's hashid. Treat the cluster ID, app name, region, and organization as separate identifiers and verify each before attaching or modifying a cluster. MPG is available only in a subset of Fly regions; choose a supported region close to the app, preferably the app's primary region when supported, to reduce latency.

For a new app and database, create/register the app first, create the MPG cluster second, attach it to the app so `DATABASE_URL` is injected, set remaining secrets, and deploy. Attaching or setting secrets against an app that does not exist produces misleading not-found failures. Keep billing and lifecycle ownership consistent: if Stripe Projects provisioned the resource, use Stripe Projects for creation, plan changes, credential rotation, and removal; use Fly tooling for day-to-day status, connections, databases, users, backups, and proxying.

## Regions and configuration

Fly region identifiers are airport-style codes, not arbitrary country or city names. Resolve a user's location against the current platform region list. Do not set an explicit primary region before the first launch unless there is a clear data-residency or co-location requirement; allowing Fly to choose can provide better initial latency. For MPG, choose only from the current supported subset and account for application/database locality.

`fly.toml` is the durable source for build, service, VM, volume, environment, and deployment configuration. Inspect and validate it before deployment. Keep environment-specific config explicit and avoid accidentally deploying a neighboring app because the working directory or config was wrong.

## Sprites

Fly also offers Sprites, managed browser sandboxes exposed through a separate `sprite` CLI. Treat Sprite credentials as secrets, use the resource token supplied by Stripe Projects when applicable, and always identify the requested Sprite explicitly. See the [Sprites docs](https://docs.sprites.dev/) for current installation and command usage.

## Safety checklist

- Confirm account, organization, app, Machine, cluster, and region before mutations.
- Use structured output and official help/docs when behavior or flags are uncertain.
- Keep tokens, secrets, and generated credential files out of transcripts and version control.
- Prefer staged or reviewable changes when a secret update, deploy, restart, or scaling change has operational impact.
- Treat deletion, volume changes, database detach/destroy, and public exposure as destructive or high-impact; obtain explicit intent and verify the target first.
- After changes, validate both control-plane state and the user-visible service.

## References

- [flyctl documentation](https://fly.io/docs/flyctl/)
- [Configuration reference](https://fly.io/docs/reference/configuration/)
- [Machines guide](https://fly.io/docs/machines/guides-examples/machines-app-using-flyctl/)
- [Managed Postgres overview](https://fly.io/docs/mpg/overview/)
- [Machines API](https://api.machines.dev/)
- [Provider LLM context](https://fly.io/provisioning/llm_context.md)
- [Fly community](https://community.fly.io/)
