# Shuttle

End-to-end encrypted sync for Obsidian vaults through your own server or S3-compatible storage.
The goal is feature, performance and usability parity with Obsidian Sync, plus support for more than one kind of remote.

Status: pre-release (P1). The plugin and server work end to end, but test on a copy of your vault, not on the only copy.
S3-compatible storage works in the engine and the command-line client but is not in the plugin's setup screens yet.

## How it works

- Every device encrypts notes and attachments before they leave it. The server stores ciphertext and never sees your encryption password.
- The server is one small Docker container with a SQLite database. Devices keep a WebSocket open and get changes within seconds.
- Several devices can edit at once; text conflicts are merged, others keep both versions.

## 1. Run the server

You need a machine with Docker that your devices can reach, and an HTTPS address for it.

```sh
mkdir shuttle && cd shuttle
curl -fsSLO https://raw.githubusercontent.com/wangyu92/shuttle/main/deploy/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/wangyu92/shuttle/main/deploy/Caddyfile
curl -fsSL -o .env https://raw.githubusercontent.com/wangyu92/shuttle/main/deploy/.env.example
# edit .env: SHUTTLE_PUBLIC_URL (and SHUTTLE_DOMAIN for the https profile)
```

Pick one way to get HTTPS:

| Your situation | Command |
|---|---|
| A domain pointing at this machine, ports 80 and 443 open | `docker compose --profile https up -d` (Caddy gets a Let's Encrypt certificate) |
| You already run a reverse proxy (nginx, Traefik, Synology DSM, Tailscale serve) | `docker compose up -d`, then proxy your HTTPS address to `127.0.0.1:8787` with WebSocket upgrade allowed |
| Private network only (for example Tailscale) | `docker compose up -d`, then `tailscale serve --bg 8787` gives the server an HTTPS address inside your tailnet |

## 2. First device: set up the server from Obsidian

A new server has no account. It prints a one-time setup code in its log:

```sh
docker compose logs shuttle | grep SETUP
```

In Obsidian: install Shuttle, open its settings, choose **Set up**, enter the server address, choose **New server: first-run setup code**, and enter the code with the username and password you want for the server.
The same screen then creates the remote vault and its encryption password.
The code works once; after that the server only accepts sign-ins and enrollment codes.

## 3. More devices

On a device that is already set up: settings, **Add device**. It shows a QR code and an enrollment code valid for 15 minutes.
Scan the QR code with the new device, or paste the link or code into **Set up** there, then enter the vault's encryption password.

## Installing the plugin

Until it is in the community plugin list, install it with [BRAT](https://github.com/TfTHacker/obsidian42-brat): add the repository `wangyu92/shuttle`.

## Server administration

The container includes `shuttle-admin`:

```sh
docker compose exec shuttle shuttle-admin status
docker compose exec shuttle shuttle-admin user list
docker compose exec shuttle shuttle-admin enroll-code --user <name> --ttl 15m
docker compose exec shuttle shuttle-admin devices list
docker compose exec shuttle shuttle-admin devices revoke <deviceId>
```

Back up the whole `shuttle-data` volume with the server stopped (`docker compose stop shuttle`). The server also keeps a daily copy of its database (7 days) under `/data/backups`; that copy does not include the encrypted file contents in `/data/vaults`.

## What is in this repo

| Package | Purpose |
| --- | --- |
| `packages/plugin` | The Obsidian plugin |
| `packages/server` | Sync server (AGPL-3.0-only) |
| `packages/headless` | Command-line client for servers and NAS boxes (mirrors a folder, no Obsidian needed) |
| `packages/engine`, `packages/crypto`, `packages/protocol`, `packages/adapter-*` | Sync engine, encryption, wire format and remote adapters |
| `packages/sim`, `packages/testkit`, `packages/spike` | Simulator, test helpers and a platform probe |
| `deploy/` | Docker Compose example for the server |

## Network use

The plugin contacts only the server addresses you enter. Shuttle has no telemetry.

## License

MIT for everything except `packages/server`, which is AGPL-3.0-only. See `LICENSE-MIT`, `LICENSE-AGPL` and `NOTICE.md`.
