import { randomBytes } from "node:crypto";
import { hostname, platform } from "node:os";
import type { DeviceAuthorizeResponse, DeviceLoginOrg, DeviceLoginResponse, DeviceTokenResponse, DeviceUser, EntitlementPayload, UsageBatchResult } from "@matchframe/cloud-contracts";
import type { EntitlementCheck } from "@matchframe/cloud-contracts/token";
import { verifyEntitlement } from "@matchframe/cloud-contracts/token";
import type { SecretStore } from "../auth.ts";
import type { SettingsRepo } from "../db/store.ts";
import type { Logger } from "../logger.ts";
import type { AutoDirectorMeter, UsageLedger } from "./meter.ts";

export type GateResult = { ok: true; free?: boolean } | { ok: false; code: "not_linked" | "no_entitlement" | "entitlement_expired" | "plan_excludes" | "hours_exhausted"; reason: string };

/**
 * Whether the program may be used. signed_in: linked with a valid (or offline-grace) licence.
 * unchecked: signed in but no licence downloaded yet. offline_expired: the licence could not be
 * refreshed within the offline grace period. not_required: development builds.
 */
export type SignInState = "not_required" | "signed_in" | "signed_out" | "revoked" | "unchecked" | "offline_expired" | "invalid";

export type LoginResult = { status: "signed_in"; user: DeviceUser; orgName: string } | { status: "choose_org"; orgs: DeviceLoginOrg[] };

interface LinkRecord {
  deviceId: string;
  orgId: string;
  orgName: string;
  linkedAt: string;
  /** Who this computer is signed in as (from sign-in, or from the licence after a link code). */
  user?: DeviceUser | null;
  method?: "password" | "code";
}

interface Linking {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: number;
  interval: number;
}

const REFRESH_MS = 15 * 60_000;
const SYNC_MS = 2 * 60_000;

/**
 * Connects this desktop install to a Matchframe cloud account: device-code linking, a signed
 * entitlement verified offline with pinned keys, background refresh, usage upload, and the
 * gate that decides whether automatic direction may be armed. Nothing here can stop a running
 * match: the gate is only consulted when automation is armed or re-armed.
 */
export class CloudLink {
  private linking: Linking | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  lastError: string | null = null;
  lastRefreshAt: string | null = null;
  lastSyncAt: string | null = null;
  revoked = false;

  constructor(
    private readonly deps: {
      settings: SettingsRepo;
      secrets: SecretStore;
      ledger: UsageLedger;
      meter: AutoDirectorMeter;
      logger: Logger;
      appVersion: string;
      wallNow?: () => Date;
      /** Build-time pinned public keys {kid: PEM}; when set, keys served by the cloud are not trusted. */
      pinnedKeys?: Record<string, string> | null;
      /** "off" disables enforcement (development builds only). */
      enforcement: "required" | "off";
      /** "required": the program must be signed in to a Matchframe account to be used (release builds). */
      signIn?: "required" | "off";
      /** Fixed website address from the build/environment; overrides the stored setting. */
      fixedUrl?: string | null;
      fetchImpl?: typeof fetch;
    },
  ) {}

  private get now(): Date {
    return this.deps.wallNow?.() ?? new Date();
  }

  private get fetch(): typeof fetch {
    return this.deps.fetchImpl ?? fetch;
  }

  get url(): string | null {
    return this.deps.fixedUrl ?? this.deps.settings.get<string | null>("cloud.url", null);
  }

  get urlFixed(): boolean {
    return !!this.deps.fixedUrl;
  }

  /** Changing the website unlinks this computer and forgets keys learned from the old address. */
  async setUrl(url: string | null): Promise<void> {
    if (this.urlFixed) throw Object.assign(new Error("the website address is fixed by this build"), { status: 409 });
    if (url !== null && !/^https?:\/\/[^\s/]+/.test(url)) throw Object.assign(new Error("the website address must start with https:// (or http:// for local testing)"), { status: 400 });
    const next = url ? url.replace(/\/+$/, "") : null;
    if (next === this.url) return;
    if (this.link) await this.unlink();
    this.cancelLink();
    this.deps.settings.set("cloud.publicKeys", {});
    this.deps.settings.set("cloud.url", next);
  }

  get enforcement(): "required" | "off" {
    return this.deps.enforcement;
  }

  get installId(): string {
    let id = this.deps.settings.get<string | null>("cloud.installId", null);
    if (!id) {
      id = randomBytes(18).toString("base64url");
      this.deps.settings.set("cloud.installId", id);
    }
    return id;
  }

  get link(): LinkRecord | null {
    return this.deps.settings.get<LinkRecord | null>("cloud.link", null);
  }

  private get publicKeys(): Record<string, string> {
    return this.deps.pinnedKeys ?? this.deps.settings.get<Record<string, string>>("cloud.publicKeys", {});
  }

  // ------------------------------------------------------------------ HTTP

  private async call<T>(method: string, path: string, body?: unknown, auth = false): Promise<{ status: number; data: T }> {
    const url = this.url;
    if (!url) throw Object.assign(new Error("set the Matchframe website address first"), { status: 409 });
    const headers: Record<string, string> = { "content-type": "application/json", "x-matchframe-version": this.deps.appVersion };
    if (auth) {
      const token = this.deps.secrets.getSecret("cloud.deviceToken");
      if (!token) throw Object.assign(new Error("this computer is not linked"), { status: 409 });
      headers.authorization = `Bearer ${token}`;
    }
    const res = await this.fetch(url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: "bad_response", message: text.slice(0, 200) };
    }
    return { status: res.status, data: data as T };
  }

  // ------------------------------------------------------------------ signing in

  /**
   * Signs this computer in with the website's email and password. The password is sent once to the
   * website over its pinned address and never stored; the computer keeps only its own credential.
   */
  async login(input: { email: string; password: string; orgId?: string; deviceName?: string }): Promise<LoginResult> {
    const fail = (status: number, message: string, code: string, detail: unknown = null) => Object.assign(new Error(message), { status, code, detail });
    if (!this.url) throw fail(409, "set the Matchframe website address first", "no_website");
    this.cancelLink();
    if (this.link) {
      // Signing in again replaces this computer's credential on the website: upload what the current one recorded first.
      this.deps.meter.flush();
      await this.sync();
    }
    let r: { status: number; data: DeviceLoginResponse & { error?: string; message?: string; detail?: { orgs?: DeviceLoginOrg[] } } };
    try {
      r = await this.call("POST", "/v1/device/login", {
        email: input.email,
        password: input.password,
        orgId: input.orgId,
        deviceName: (input.deviceName ?? hostname()).slice(0, 80) || "Matchframe PC",
        platform: platform(),
        appVersion: this.deps.appVersion,
        installId: this.installId,
      });
    } catch (e) {
      throw fail(502, `cannot reach the Matchframe website (${this.url}): ${e instanceof Error ? e.message : String(e)}`, "unreachable");
    }
    if (r.status === 409 && r.data?.error === "choose_org") return { status: "choose_org", orgs: r.data.detail?.orgs ?? [] };
    if (r.status !== 200 || !r.data?.deviceToken) {
      const message = r.data?.message ?? `the website refused the sign-in (HTTP ${r.status})`;
      // 401 from the engine means "operator token rejected" to the console, so wrong passwords are 400 here.
      throw fail(r.status === 401 ? 400 : r.status >= 500 ? 502 : r.status, message.charAt(0).toUpperCase() + message.slice(1), r.data?.error ?? "sign_in_failed");
    }
    this.deps.secrets.setSecret("cloud.deviceToken", r.data.deviceToken);
    this.deps.settings.set("cloud.link", { deviceId: r.data.deviceId, orgId: r.data.orgId, orgName: r.data.orgName, linkedAt: this.now.toISOString(), user: r.data.user, method: "password" } satisfies LinkRecord);
    this.deps.settings.set("cloud.entitlement", null);
    this.checkCache = null;
    this.revoked = false;
    this.lastError = null;
    await this.fetchKeys().catch(() => undefined);
    await this.refresh();
    this.startBackground();
    this.deps.logger.info("signed in to Matchframe", { orgId: r.data.orgId, deviceId: r.data.deviceId, user: r.data.user.email });
    return { status: "signed_in", user: r.data.user, orgName: r.data.orgName };
  }

  get signInRequired(): boolean {
    return this.deps.signIn === "required" && this.enforcement === "required";
  }

  /** The account this computer is signed in as: the licence's (current) value, else the one stored at sign-in. */
  get user(): DeviceUser | null {
    return this.entitlementCheck()?.payload?.user ?? this.link?.user ?? null;
  }

  signInState(): SignInState {
    if (!this.signInRequired) return "not_required";
    if (!this.link) return this.revoked ? "revoked" : "signed_out";
    const check = this.entitlementCheck();
    if (!check) return "unchecked";
    if (check.ok) return "signed_in";
    return check.reason === "expired" ? "offline_expired" : "invalid";
  }

  // ------------------------------------------------------------------ linking

  async startLink(deviceName = hostname()): Promise<{ userCode: string; verificationUri: string; verificationUriComplete: string; expiresAt: string }> {
    this.cancelLink();
    const r = await this.call<DeviceAuthorizeResponse & { message?: string }>("POST", "/v1/device/authorize", { deviceName: deviceName.slice(0, 80) || "Matchframe PC", platform: platform(), appVersion: this.deps.appVersion, installId: this.installId });
    if (r.status !== 200) throw Object.assign(new Error(r.data?.message ?? `the website refused to start linking (HTTP ${r.status})`), { status: 502 });
    this.linking = { deviceCode: r.data.deviceCode, userCode: r.data.userCode, verificationUri: r.data.verificationUri, verificationUriComplete: r.data.verificationUriComplete, expiresAt: Date.now() + r.data.expiresIn * 1000, interval: r.data.interval };
    this.schedulePoll();
    return { userCode: this.linking.userCode, verificationUri: this.linking.verificationUri, verificationUriComplete: this.linking.verificationUriComplete, expiresAt: new Date(this.linking.expiresAt).toISOString() };
  }

  cancelLink(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.linking = null;
  }

  private schedulePoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (!this.linking) return;
    this.pollTimer = setTimeout(() => void this.pollOnce(), this.linking.interval * 1000);
  }

  /** One poll of the device token endpoint (exposed for tests). */
  async pollOnce(): Promise<"pending" | "linked" | "failed"> {
    const l = this.linking;
    if (!l) return "failed";
    if (Date.now() > l.expiresAt) {
      this.lastError = "the link code expired; start linking again";
      this.cancelLink();
      return "failed";
    }
    try {
      const r = await this.call<DeviceTokenResponse & { error?: string }>("POST", "/v1/device/token", { deviceCode: l.deviceCode });
      if (r.status === 200 && r.data.deviceToken) {
        this.deps.secrets.setSecret("cloud.deviceToken", r.data.deviceToken);
        this.deps.settings.set("cloud.link", { deviceId: r.data.deviceId, orgId: r.data.orgId, orgName: r.data.orgName, linkedAt: this.now.toISOString(), method: "code" } satisfies LinkRecord);
        this.revoked = false;
        this.cancelLink();
        await this.fetchKeys();
        await this.refresh();
        this.startBackground();
        this.deps.logger.info("computer linked to Matchframe account", { orgId: r.data.orgId, deviceId: r.data.deviceId });
        return "linked";
      }
      if (r.data?.error === "slow_down") l.interval += 5;
      if (r.data?.error === "authorization_pending" || r.data?.error === "slow_down") {
        this.schedulePoll();
        return "pending";
      }
      this.lastError = r.data?.error === "access_denied" ? "the link request was refused on the website" : "the link code expired; start linking again";
      this.cancelLink();
      return "failed";
    } catch (e) {
      // Network trouble while linking: keep polling until the code expires.
      this.lastError = `cannot reach the website: ${e instanceof Error ? e.message : String(e)}`;
      this.schedulePoll();
      return "pending";
    }
  }

  private async fetchKeys(): Promise<void> {
    if (this.deps.pinnedKeys) return;
    const r = await this.call<{ keys: Record<string, string> }>("GET", "/v1/keys");
    if (r.status === 200 && r.data?.keys) this.deps.settings.set("cloud.publicKeys", { ...this.deps.settings.get<Record<string, string>>("cloud.publicKeys", {}), ...r.data.keys });
  }

  // ------------------------------------------------------------------ entitlement

  private checkCache: { at: number; value: EntitlementCheck | null } | null = null;

  /** Offline verification of the stored licence (cached briefly: the operator snapshot asks often). */
  entitlementCheck(): EntitlementCheck | null {
    const t = this.now.getTime();
    if (this.checkCache && t - this.checkCache.at < 1000 && t >= this.checkCache.at) return this.checkCache.value;
    const token = this.deps.settings.get<string | null>("cloud.entitlement", null);
    const link = this.link;
    const value = token && link ? verifyEntitlement(token, this.publicKeys, this.now, link.deviceId) : null;
    this.checkCache = { at: t, value };
    return value;
  }

  /** Uploads pending usage first so the new licence accounts for it, then fetches and verifies the licence. */
  async refresh(): Promise<EntitlementPayload | null> {
    await this.sync();
    if (!this.link) return null;
    try {
      const requestedAt = this.now.toISOString();
      const r = await this.call<{ token?: string; error?: string; message?: string }>("POST", "/v1/device/entitlement", undefined, true);
      if (r.status === 401) {
        this.markRevoked(r.data?.message ?? "this computer was signed out on the website");
        return null;
      }
      if (r.status !== 200 || !r.data?.token) throw new Error(r.data?.message ?? `HTTP ${r.status}`);
      let check = verifyEntitlement(r.data.token, this.publicKeys, this.now, this.link.deviceId);
      if (!check.ok && check.reason === "unknown_key" && !this.deps.pinnedKeys) {
        // Key rotation on the server: fetch the published keys once and verify again.
        await this.fetchKeys();
        check = verifyEntitlement(r.data.token, this.publicKeys, this.now, this.link.deviceId);
      }
      if (!check.ok) throw new Error(`the website's licence did not verify (${check.reason})`);
      this.deps.settings.set("cloud.entitlement", r.data.token);
      this.deps.settings.set("cloud.entitlementRequestedAt", requestedAt);
      this.checkCache = null;
      this.lastRefreshAt = this.now.toISOString();
      this.lastError = null;
      return check.payload;
    } catch (e) {
      this.lastError = `licence refresh failed: ${e instanceof Error ? e.message : String(e)}`;
      return null;
    }
  }

  private markRevoked(message: string): void {
    this.revoked = true;
    this.lastError = message;
    this.deps.meter.flush();
    this.deps.ledger.abandonPending("computer was unlinked before this record was uploaded");
    this.deps.secrets.setSecret("cloud.deviceToken", null);
    this.deps.settings.set("cloud.entitlement", null);
    this.deps.settings.set("cloud.link", null);
    this.checkCache = null;
    this.stopBackground();
    this.deps.logger.warn("computer unlinked by the website", { message });
  }

  async unlink(): Promise<void> {
    if (this.link) await this.call("POST", "/v1/device/unlink", undefined, true).catch(() => undefined);
    this.deps.meter.flush();
    this.deps.ledger.abandonPending("computer was unlinked before this record was uploaded");
    this.revoked = false;
    this.deps.secrets.setSecret("cloud.deviceToken", null);
    this.deps.settings.set("cloud.entitlement", null);
    this.deps.settings.set("cloud.link", null);
    this.checkCache = null;
    this.stopBackground();
  }

  // ------------------------------------------------------------------ usage sync

  async sync(): Promise<UsageBatchResult | null> {
    if (!this.link) return null;
    const total: UsageBatchResult = { accepted: [], duplicates: [], rejected: [] };
    for (let round = 0; round < 20; round++) {
      const records = this.deps.ledger.pending(500);
      if (records.length === 0) {
        if (round === 0) this.lastSyncAt = this.now.toISOString();
        break;
      }
      try {
        const r = await this.call<UsageBatchResult & { error?: string; message?: string }>("POST", "/v1/device/usage", { records }, true);
        if (r.status === 401) {
          this.markRevoked(r.data?.message ?? "this computer was unlinked on the website");
          return total;
        }
        if (r.status !== 200) throw new Error(r.data?.message ?? `HTTP ${r.status}`);
        const at = this.now.toISOString();
        this.deps.ledger.markUploaded([...r.data.accepted, ...r.data.duplicates], at);
        for (const rej of r.data.rejected) this.deps.ledger.markRejected(rej.recordId, rej.reason);
        total.accepted.push(...r.data.accepted);
        total.duplicates.push(...r.data.duplicates);
        total.rejected.push(...r.data.rejected);
        this.lastSyncAt = at;
      } catch (e) {
        this.lastError = `usage upload failed (kept locally, will retry): ${e instanceof Error ? e.message : String(e)}`;
        break;
      }
    }
    return total;
  }

  // ------------------------------------------------------------------ gate

  /** Local estimate between refreshes: the licence's remaining hours minus usage the website had not seen when it was issued. */
  localRemainingSeconds(p: EntitlementPayload): number {
    const requestedAt = this.deps.settings.get<string | null>("cloud.entitlementRequestedAt", null) ?? p.issuedAt;
    return p.autoDirector.remainingSeconds - this.deps.ledger.secondsNotUploadedBefore(requestedAt) - this.deps.meter.openSeconds();
  }

  canArm(simulated: boolean): GateResult {
    if (simulated) return { ok: true, free: true };
    if (this.enforcement === "off") return { ok: true, free: true };
    if (!this.link) return { ok: false, code: "not_linked", reason: this.revoked ? "This computer was signed out on the website. Sign in again (Account & Hours) to use automatic direction on live matches." : "Sign in to your Matchframe account (Account & Hours) to use automatic direction on live matches. Manual and advisory direction stay available." };
    const check = this.entitlementCheck();
    if (!check) return { ok: false, code: "no_entitlement", reason: "No licence has been downloaded yet. Connect to the internet and press Refresh on the Account screen." };
    if (!check.ok) {
      if (check.reason === "expired") return { ok: false, code: "entitlement_expired", reason: `The licence could not be refreshed for too long (offline grace ended ${check.payload?.graceUntil ?? ""}). Connect to the internet and refresh.` };
      return { ok: false, code: "no_entitlement", reason: `The stored licence is not valid (${check.reason}). Refresh it on the Account screen.` };
    }
    if (!check.payload.features.autoDirector) return { ok: false, code: "plan_excludes", reason: `The ${check.payload.plan.name} plan does not include automatic direction.` };
    if (this.localRemainingSeconds(check.payload) <= 0 && !check.payload.autoDirector.overageAllowed) return { ok: false, code: "hours_exhausted", reason: "No auto-director hours left this period. Buy an hour pack or change plan on the website, then press Refresh. Matches already running are never cut off." };
    return { ok: true };
  }

  // ------------------------------------------------------------------ lifecycle / status

  startBackground(): void {
    if (!this.link || this.refreshTimer) return;
    this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.syncTimer = setInterval(() => void this.sync(), SYNC_MS);
  }

  stopBackground(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.refreshTimer = null;
    this.syncTimer = null;
  }

  async start(): Promise<void> {
    if (!this.link || !this.url) return;
    this.startBackground();
    await this.refresh();
  }

  async stop(): Promise<void> {
    this.cancelLink();
    this.stopBackground();
    this.deps.meter.flush();
    if (this.link && this.url) await Promise.race([this.sync(), new Promise((r) => setTimeout(r, 3000))]);
  }

  status(simulated: boolean) {
    const check = this.entitlementCheck();
    const payload = check?.payload ?? null;
    return {
      url: this.url,
      urlFixed: this.urlFixed,
      enforcement: this.enforcement,
      keysPinned: !!this.deps.pinnedKeys,
      linkState: this.linking ? "linking" : this.link ? "linked" : this.revoked ? "revoked" : "unlinked",
      signIn: { required: this.signInRequired, state: this.signInState(), user: this.user, method: this.link?.method ?? null },
      linking: this.linking ? { userCode: this.linking.userCode, verificationUri: this.linking.verificationUri, verificationUriComplete: this.linking.verificationUriComplete, expiresAt: new Date(this.linking.expiresAt).toISOString() } : null,
      device: this.link,
      entitlement: payload
        ? { state: check!.ok ? check!.state : check!.reason, plan: payload.plan, subscriptionStatus: payload.subscriptionStatus, features: payload.features, autoDirector: payload.autoDirector, issuedAt: payload.issuedAt, expiresAt: payload.expiresAt, graceUntil: payload.graceUntil, localRemainingSeconds: this.localRemainingSeconds(payload) }
        : null,
      gate: this.canArm(simulated),
      usage: { ...this.deps.ledger.stats(), openSeconds: this.deps.meter.openSeconds(), metering: this.deps.meter.active },
      lastRefreshAt: this.lastRefreshAt,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
    };
  }
}
