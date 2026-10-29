# Releasing AgentsCircle

Pushing a version tag builds the Mac and Windows installers on GitHub, uploads them to a GitHub Release, and every installed AgentsCircle updates itself.

## One-time setup

### 1. Put the code on GitHub
Create a repository (for example `agentscircle`) and push this folder to it. The release workflow (`.github/workflows/release.yml`) is already included and fills in your repository name automatically.

### 2. Mac signing and notarization (strongly recommended)
Without it, macOS warns users that the app is from an unidentified developer, and **auto-update on Mac doesn't work for unsigned apps**.

1. Join the Apple Developer Program (99 USD/year).
2. In Xcode or developer.apple.com, create a **Developer ID Application** certificate and export it as a `.p12` file with a password.
3. Create an **App Store Connect API key** (Users and Access → Integrations → Keys) and download the `.p8` file. Note its Key ID and Issuer ID.
4. In your GitHub repository → Settings → Secrets and variables → Actions, add:

| Secret | Value |
|---|---|
| `MAC_CERT_P12_BASE64` | `base64 -i certificate.p12` output |
| `MAC_CERT_PASSWORD` | the .p12 password |
| `APPLE_API_KEY_BASE64` | `base64 -i AuthKey_XXXX.p8` output |
| `APPLE_API_KEY_ID` | the key ID |
| `APPLE_API_ISSUER` | the issuer ID |

### 3. Windows signing (recommended)
Without it, Windows SmartScreen shows a warning the first time people install. Buy a code-signing certificate (or use Azure Trusted Signing), export it as `.pfx`, and add `WIN_CERT_PFX_BASE64` and `WIN_CERT_PASSWORD` secrets. The app works unsigned; updates work either way on Windows.

### 4. Signed agent-settings fixes (optional, recommended)
Lets you fix every installed app within hours when an agent CLI changes its flags, without a full release.

```bash
npm run tools:keygen          # once; keeps the private key in ~/.agentscircle-signing/
```
Paste the printed public key into `package.json` → `agentscircle.toolsPublicKey`, and set `agentscircle.toolsUrl` to
`https://raw.githubusercontent.com/YOUR-USER/agentscircle/main/tools.json`. Release once so apps contain the key.

To ship a fix later: edit `tools.json`, bump `"revision"`, run `npm run tools:sign`, and commit `tools.json` and `tools.json.sig`. Apps check every 6 hours (or Settings → About → Check for fixes). Only flags and output formats can change this way; the commands AgentsCircle runs never can, and anything not signed with your key is ignored.

## Every release

```bash
git tag v1.0.1 && git push origin v1.0.1          # stable
git tag v1.1.0-beta.1 && git push origin v1.1.0-beta.1   # beta (pre-release)
```

Or without a terminal: on GitHub open **Actions → Release → Run workflow**, type the version (for example `1.3.1`, or `1.4.0-beta.1` for a beta) and click **Run workflow**. Leave **Publish** off to get a draft release you can check first, then publish it from the Releases page.

The tag sets the version. GitHub Actions builds macOS (Apple Silicon and Intel), Windows (x64 and ARM) and Linux, then publishes the release. Stable users get stable tags; people who picked the Beta channel in Settings → About also get `-beta` tags.

## Changing how data is stored
User data lives in `~/.agentscircle`, never inside the app, so updates keep it. If a new version needs a different format, add a step to `MIGRATIONS` in `src/platform.js` and bump `DATA_VERSION`. AgentsCircle backs everything up to `~/.agentscircle/backups/` before converting.

## Building locally
```bash
npm install
npm run app          # run the desktop app from source
npm run dist:mac     # build on a Mac (signs if your certificate is in the keychain)
npm run dist:win     # build on Windows
```

## Download links that always point at the newest version

Installers have the same file name in every release, so these links never change
(they download from the release marked Latest):

- Mac (Apple Silicon): https://github.com/haythamat/agentscircle/releases/latest/download/AgentsCircle-mac-arm64.dmg
- Mac (Intel): https://github.com/haythamat/agentscircle/releases/latest/download/AgentsCircle-mac-x64.dmg
- Windows: https://github.com/haythamat/agentscircle/releases/latest/download/AgentsCircle-Setup-Windows.exe
- Linux: https://github.com/haythamat/agentscircle/releases/latest/download/AgentsCircle-Linux.AppImage
