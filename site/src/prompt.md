These are the official instructions to install and set up the **Acrowly** personal AI coordinator harness on the user's machine.

> **Architecture principle**: Acrowly runs 100% independently on the user's own hardware. Just as Git works without GitHub, neither `acrowly.com` nor any hosted relay is a required dependency — this site is merely a convenient bootstrap entrypoint, and users can run offline/LAN, direct IP, or their own `acl relay` server at any time.

Complete all installation, build, linking, and key-generation steps yourself by running shell commands directly. Do not ask the user to manually clone or build anything. **Never invent or fabricate an LLM API key** — leave the one-time provider and API key entry for the user when they run `acl`.

---

## Step 1 — Check Prerequisites (`Node.js >= 20` and `git`)

Run:

```bash
node -v
git --version
```

- **Node.js 20.0.0 or higher** is required.
- If `node` is missing or below v20, install Node.js LTS before continuing (ask for permission only if privilege elevation is needed):
  - **Windows (PowerShell)**:
    ```powershell
    winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements
    ```
  - **macOS (Homebrew)**: `brew install node`
  - **Linux**: install Node.js 20+ via `nvm` or the system package manager.
- If `git` is missing, install `git` first (`winget install --id Git.Git -e --source winget`, `brew install git`, or `apt`/`dnf`).

---

## Step 2 — Clone or Update Acrowly

Choose the default install directory:
- **macOS / Linux**: `~/.acrowly`
- **Windows**: `$env:USERPROFILE\.acrowly`

Important safety check:
- If the directory **does not exist**, clone the repository:
  - **macOS / Linux**:
    ```bash
    git clone https://github.com/chess20000/acrowly.git ~/.acrowly
    ```
  - **Windows (PowerShell)**:
    ```powershell
    git clone https://github.com/chess20000/acrowly.git "$env:USERPROFILE\.acrowly"
    ```
- If the directory **already contains an existing Acrowly git clone**, update it without touching `data/`, `webui/`, `id_ed25519`, or `id_ed25519.pub`:
  ```bash
  git -C ~/.acrowly pull --ff-only
  ```
- If `~/.acrowly` already exists **without** `package.json` (for example, it currently only holds `id_ed25519` client keys), clone the repository into `~/.acrowly-app` (or `%USERPROFILE%\.acrowly-app`) instead so existing key files stay intact.

---

## Step 3 — Install Dependencies, Build, Verify, and Link `acl`

Inside the cloned Acrowly directory:

```bash
npm install --no-audit --no-fund
npm run typecheck
npm run build
npm test
```

Ensure all built-in tests in `dist/test/*.test.js` pass before linking.

Next, register the global `acl` (and `acrowly`) CLI commands:

```bash
npm link
```

- On Windows, confirm `acl.ps1` / `acl` resolves (`Get-Command acl`). If PowerShell blocks script execution, mention `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` or `acl.cmd`.
- On macOS / Linux, if `npm link` fails with `EACCES` permissions, configure a user-writable npm prefix (`~/.npm-global`) or symlink `dist/index.js` into `~/.local/bin/acl` (`chmod +x dist/index.js`) and ensure `~/.local/bin` is in `PATH`. Do **not** run `sudo` silently without telling the user.

---

## Step 4 — Generate the Client Ed25519 Identity (`acl keygen`)

Acrowly uses **pure SSH-style Ed25519 public-key challenge-signature auth** (no passcodes, no static API tokens). Private keys never leave the client device.

Run:

```bash
acl keygen
```

Verify that `acl keygen` prints:
- Private key path (under `~/.acrowly/id_ed25519`)
- Public key fingerprint (`SHA256:...`)
- Public key line (`ssh-ed25519 AAAA...`)

Also verify `acl --help` succeeds with exit code `0`.

---

## Step 5 — Hand Off to the User

Once verified, do **not** create `data/config.json` with a fake API key. Tell the user clearly:

```text
┌─ Acrowly Harness Installed ──────────────────────────────────┐
│  ✓ Source & Build  <install-dir>                             │
│  ✓ Global CLI      acl (verified with tests passing)         │
│  ✓ Client Key      <SHA256 fingerprint from acl keygen>      │
│                                                              │
│  ▶ Next step: run `acl` in your terminal to pick your LLM    │
│    provider, enter your API key once, auto-authorize this    │
│    device's Ed25519 key, and start chatting.                 │
└──────────────────────────────────────────────────────────────┘
```

Remind the user of the core workflow once inside `acl`:
- `acl` — First-boot setup (provider + API key, auto-authorizes `local-cli` key) + starts headless daemon + enters plain-text Coordinator chat.
- `acl keygen` — View or generate this device's Ed25519 public key.
- `acl add-key "<ssh-ed25519 ...>" --label "<device>"` — Authorize another client (phone, browser, laptop), or simply paste the public key directly into chat with the Coordinator.
- `acl chat --url <url>` — Connect from any device over LAN or `acrowly.com` relay using Ed25519 signature auth.

---

Source repository: https://github.com/chess20000/acrowly
API specification: https://github.com/chess20000/acrowly/blob/main/docs/API_SPEC.md
Published at: https://acrowly.com/prompt.md
