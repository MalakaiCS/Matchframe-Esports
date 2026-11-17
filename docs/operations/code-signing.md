# Code signing: setup for the owner

Signing puts your verified name on the MatchFrame installer and program, so Windows shows **your name as the publisher** instead of "Unknown publisher". The Windows workflow (`.github/workflows/windows-program.yml`) signs as soon as you add the secrets below. Until then it builds unsigned, exactly as before, and every check still runs. Background and decisions: ADR-076 in `docs/architecture/decisions.md`.

## What only you can do

- **Prove who you are.** The provider checks your identity (yours as a person, or your business's) before it issues a certificate. The name it verifies is the name Windows shows.
- **Pay the provider** and keep the account in good standing.
- **Add the secrets and variables to GitHub** (below). Never put them in the repository, an issue, a chat or a file.
- **Keep it renewed.** When a client secret, password or certificate expires, signed builds fail until you replace it: the workflow stops rather than releasing a half-signed program.

## The options

1. **Azure Artifact Signing** (recommended, below): Microsoft keeps the certificate in its cloud and signs for the workflow. There's no file to look after.
2. **A certificate authority's cloud signing tool**: the workflow has a hook for it (below).
3. **A PFX certificate file you already have** (below).

If more than one is set up, the workflow uses the first in this list.

## Option 1: Azure Artifact Signing

Microsoft renamed the service from **Trusted Signing** to **Azure Artifact Signing**. electron-builder (the tool that packages MatchFrame) still calls its setting `azureSignOptions`, and its build log may show the old name.

Microsoft's step-by-step guide: <https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart>.

### Check before you create anything

- **Eligibility. Check it before creating the account.** Individual developers can currently sign up only in the **USA and Canada**; organisations in the **USA, Canada, the European Union and the United Kingdom**. Microsoft changes these rules, so check its page.
- **Subscription:** Artifact Signing doesn't work on free, trial or sponsored Azure subscriptions. A paid (pay-as-you-go) subscription is needed.
- **Billing starts when the signing account is created**, not when you first sign. Microsoft listed the Basic plan at about US$9.99 a month when this was written; check the current price on its product and pricing pages: <https://azure.microsoft.com/en-us/products/artifact-signing/> and <https://azure.microsoft.com/pricing/details/artifact-signing/>.
- **Identity validation** happens in the Azure portal, with a photo ID and a selfie through Microsoft Entra Verified ID. It can take from 1 to 20 business days.

### Steps in the Azure portal (portal.azure.com)

1. **Register the resource provider.** Open **Subscriptions** → your subscription → **Resource providers**, search for `Microsoft.CodeSigning`, select it and choose **Register**. Wait until it shows **Registered**.
2. **Create the signing account.** Search the portal for **Artifact Signing** and create an account: your subscription, a resource group (for example a new one called `matchframe-signing`), an account name, a region, and the **Basic** plan. When it's created, note the **account name** and the **Account URI** on its Overview page (it looks like `https://eus.codesigning.azure.net/`; the start depends on the region).
3. **Give yourself the Identity Verifier role.** On the signing account: **Access control (IAM)** → **Add** → **Add role assignment** → role **Artifact Signing Identity Verifier** → members: your own account → **Review + assign**. Without this role the **New identity** button stays greyed out, even for the subscription's Owner.
4. **Validate your identity.** On the signing account, open **Identity validations** → **New identity** → **Public**, then **Individual** or **Organization**. Enter your legal details exactly as on your documents and follow the Entra Verified ID steps (photo ID and selfie). Wait until the validation is **Completed**.
5. **Create a certificate profile.** On the signing account, open **Certificate profiles** → **Create** → **Public Trust**. Give it a name (for example `matchframe-public`) and choose your completed identity validation. Note the **profile name**, and the **name on the certificate** (your verified name, as the identity validation shows it): Windows shows it as the publisher, and GitHub needs it exactly.
6. **Let GitHub sign.** Open **Microsoft Entra ID** → **App registrations** → **New registration**, name it (for example `MatchFrame GitHub signing`), keep "this organizational directory only" and register it. On its Overview page note the **Directory (tenant) ID** and the **Application (client) ID**. Under **Certificates & secrets** → **New client secret**, choose an expiry, add it and copy its **Value** straight away (Azure shows it once); note when it expires. Then on the signing account: **Access control (IAM)** → **Add role assignment** → role **Artifact Signing Certificate Profile Signer** → members: **User, group, or service principal** → select the app registration by its name → **Review + assign**.
7. **Add the secrets and variables to GitHub** (next section).

### GitHub secrets and variables for Azure Artifact Signing

On github.com, open the **MalakaiCS/Matchframe-Esports** repository → **Settings** → **Secrets and variables** → **Actions**. There are two tabs: **Secrets** (hidden once saved) and **Variables** (visible). Choose **New repository secret** or **New repository variable**, type the name exactly as below, paste the value and save.

| Name | Tab | Value |
|---|---|---|
| `AZURE_TENANT_ID` | Secrets | the app registration's Directory (tenant) ID |
| `AZURE_CLIENT_ID` | Secrets | the app registration's Application (client) ID |
| `AZURE_CLIENT_SECRET` | Secrets | the client secret's Value |
| `AZURE_SIGNING_ENDPOINT` | Variables | the signing account's Account URI, e.g. `https://eus.codesigning.azure.net/` |
| `AZURE_SIGNING_ACCOUNT_NAME` | Variables | the signing account's name |
| `AZURE_SIGNING_CERTIFICATE_PROFILE` | Variables | the certificate profile's name |
| `AZURE_SIGNING_PUBLISHER_NAME` | Variables | the name on the certificate, exactly (capitals, punctuation and spaces included) |

The four variables may be secrets instead if you prefer; the workflow reads either. All seven are needed: with only some of them the build stops and lists the missing names, so a release is never published unsigned by mistake.

Before the client secret expires, make a new one in the app registration and replace `AZURE_CLIENT_SECRET`.

## Option 2: a certificate authority's cloud signing tool

Since mid-2023, newly issued code-signing certificates (OV and EV) must keep their private key on secure hardware: a USB token, or the certificate authority's cloud service. So a new certificate usually can't be a file in a GitHub secret. Authorities that keep the key in their cloud give you a command-line tool that signs a file.

The workflow has a hook for such a tool:

| Name | Tab | Value |
|---|---|---|
| `WIN_SIGN_COMMAND` | Variables (Secrets if it contains a password or key) | the command that signs one file; write `{file}` where the file goes, e.g. `signtool-of-your-ca sign --input {file}` |
| `WIN_SIGN_PUBLISHER_NAME` | Variables | the name on the certificate, exactly |

The build runs the command once for each file it signs (the program, its helpers, the uninstaller and the installer), with `{file}` replaced by the file's path in quotes. MatchFrame never prints the command. What depends on the authority, and isn't in the workflow yet: installing its tool on GitHub's build machine and giving the tool its login (usually its own secrets). That's a short addition to the workflow once you've chosen an authority. A certificate that lives only on a USB token can't be used by GitHub's build machines.

## Option 3: a PFX certificate file you already have

Only if you already have the certificate as a `.pfx` (or `.p12`) file with its password:

| Name | Tab | Value |
|---|---|---|
| `CSC_LINK` | Secrets | the `.pfx` file as base64 text (below) |
| `CSC_KEY_PASSWORD` | Secrets | the `.pfx` file's password |

To turn the file into base64 text on Windows, open PowerShell and run this with your file's path; it copies the text to the clipboard, ready to paste into the secret:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\certificate.pfx")) | Set-Clipboard
```

Don't save the text in a file or send it anywhere else. A self-signed certificate doesn't help: Windows doesn't trust it, and the workflow's check rejects it.

## How to tell it worked

1. **Run a test build.** On GitHub: **Actions → Windows program (.exe) → Run workflow**, choose your branch, leave the tag empty and start it. (A push that changes the program also starts one.)
2. **Read the build log.** In the run, open the job and look at:
   - **Choose code signing:** it says which method it uses, for example "Signing with Azure Artifact Signing (publisher: …)". "No signing secrets: building unsigned" means GitHub didn't see the settings (check the names).
   - **Check the code signature (signed builds):** the installer and the program each show `Valid, signed by CN=<your name>…`. The step fails if either isn't validly signed, or if the publisher name you typed doesn't match the certificate; the message then says the exact name to use.
   - **Install the program silently:** `Installed program: Valid, signed by …`.
3. **Check the installer on a Windows computer.** Download the installer from the run's artifacts (or from a release). Right-click it → **Properties** → **Digital Signatures**: your name is listed. Run it: if Windows shows the blue SmartScreen box, **More info** shows **Publisher: <your name>** instead of **Unknown publisher**.

SmartScreen can still show its box for a while after signing, because Microsoft also weighs how many people have downloaded and run a program before it stops warning. The change you can check straight away is the publisher name.

## Once you sign, keep signing

A signed program accepts updates only when they're signed with the **same publisher name**: the build writes the name into the program and the updater checks it. So:

- Keep the settings valid for every release. If signing lapses, programs installed from a signed release won't take the next update until it's signed again (they keep working, and operators can install the new version by hand).
- Switching between options is fine only if the name on the certificate stays exactly the same.
- Programs installed from unsigned releases (every release so far) update to a signed release normally.

Signatures are time-stamped when they're made, so a release signed while the certificate was valid stays valid after the certificate expires.
