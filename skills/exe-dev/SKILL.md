---
name: exe-dev
description: Use this skill when the user wants to interact with exe.dev via SSH — creating persistent Linux VMs, deploying small services/apps, exposing them over HTTPS, customizing images or setup scripts, sharing access, scaling resources, or automating with the HTTPS API. Triggers on tasks like "deploy to exe.dev", "create an exe VM", "put this app on exe.dev", "make my exe VM public", "ssh into my exe VM", "resize an exe VM", "add a custom domain to exe.dev", or "use the exe.dev HTTPS API".
compatibility: "Requires an SSH key registered with exe.dev and the ssh client on PATH. Verify with ssh exe.dev whoami; complete onboarding at https://exe.dev if prompted. For HTTPS API/CI, generate a short-lived bearer token with the SSH API-key command."
---

# exe.dev

Use exe.dev to run small services on persistent Linux VMs with automatic HTTPS at `https://<vm>.exe.xyz/`. It is SSH-native: there is no dedicated CLI binary. For current syntax and capabilities, consult the [docs index](https://exe.dev/docs.md), [agent skill](https://exe.dev/docs/agent-skill.md), or [all docs](https://exe.dev/docs/all.md) rather than relying on remembered flags.

## The critical SSH distinction

There are two different destinations:

- **The lobby (`ssh exe.dev`)** is a restricted command interface for VM and account operations. It is not a shell and does not support arbitrary commands, `scp`, or `sftp`.
- **A VM (`ssh <vm>.exe.xyz`)** is a normal Linux host. Use it for shells, copying files, port forwarding, building, and running services.

Targeting the lobby when you meant the VM is the most common source of SSH, copy, and remote-command failures. In scripts and CI, use `StrictHostKeyChecking=accept-new` on the first connection so host-key prompts do not block unattended work. Pin the intended identity for both host patterns in SSH config when multiple keys are available.

## Authentication and account model

Authentication uses the registered SSH key; there is no separate exe.dev password. Confirm access before making changes. Accounts are pinned to one VM region, and VMs share underlying capacity, so choose resource sizes based on the service rather than creating large machines by default.

For automation, the HTTPS API mirrors lobby operations through `POST https://exe.dev/exec` with a bearer token. Generate tokens with an explicit short expiry, restrict their allowed commands, and never put secrets in token payloads, logs, images, or committed files. The API has no interactive stdin/PTY and has request and timeout limits, so use direct VM SSH for work that needs a shell or long-running process.

## Durable deployment guidance

A typical deployment has these decisions, in this order:

1. **Discover before mutating.** Check whether a suitable VM already exists and inspect its status, image, region, and current sharing configuration. Use machine-readable output in scripts.
2. **Choose the customization path.** SSH in and build for a one-off or actively developed service; use a reproducible OCI image for repeatable deployments; use a bounded first-boot setup script for small bootstrap tasks. Treat setup scripts as one-time operations and keep them reviewable.
3. **Run and expose deliberately.** Make the service listen on the expected port, configure the proxy for that port, and verify the HTTPS endpoint. Keep the default authenticated/private visibility unless public access is explicitly required. Dev servers may need their host allow-list configured for `*.exe.xyz`.
4. **Share the minimum access.** Prefer named users or teams when access should be controlled. Public sharing removes authentication; links and team access still need explicit revocation planning.
5. **Operate and clean up.** Inspect resource metrics and service health before resizing. Persistent disks survive sessions, but disk growth is one-way. Deleting a VM is destructive; confirm the target and preserve data before teardown.

The lobby supports VM creation, inspection, sharing, domains, integrations, resource changes, and deletion; use its built-in help or the official docs for exact commands and flags. Integrations include HTTP proxies (including header injection), GitHub access, and a managed LLM gateway. Keep provider credentials in integrations or environment management rather than baking them into images.

## HTTPS, domains, and integrations

Every VM receives TLS termination and a hostname. A single selected port can be made public; alternate proxied ports remain authenticated. Reverse-proxy headers identify the original request and should be handled by the application appropriately.

A custom domain requires a correctly configured CNAME before registering it with exe.dev. Verify DNS and certificate status after the change. Integrations can attach to one VM, a tag, or all current and future VMs; review scope carefully, especially for integrations carrying credentials or disabling authentication.

The default LLM integration may provide provider access without storing API keys on the VM. Treat the VM identity and monthly allocation as the authorization boundary, and consult the [LLM gateway docs](https://exe.dev/docs/shelley/llm-gateway.md) for endpoint details.

## Safety checklist

- Separate lobby operations from commands inside the VM.
- Inspect names and machine-readable state before destructive or paid changes.
- Keep SSH/API credentials and application secrets out of transcripts, repos, images, and setup scripts where possible.
- Use private visibility by default and grant the narrowest sharing scope.
- Verify the live HTTPS endpoint after deployment or proxy changes.
- Use official help/docs when an option or behavior is uncertain; do not infer flags from another CLI.

## References

- [Documentation index](https://exe.dev/docs.md)
- [All documentation](https://exe.dev/docs/all.md)
- [Official agent skill](https://exe.dev/docs/agent-skill.md)
- [Customization](https://exe.dev/docs/customization.md)
- [Sharing](https://exe.dev/docs/sharing.md)
- [Integrations](https://exe.dev/docs/integrations.md)
- [HTTPS API](https://exe.dev/docs/https-api.md)
- [HTTPS VM tokens](https://exe.dev/docs/https-tokens-for-vms.md)
- [Regions](https://exe.dev/docs/regions.md)
- [LLM gateway](https://exe.dev/docs/shelley/llm-gateway.md)
