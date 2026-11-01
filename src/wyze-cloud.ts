import crypto from 'crypto';

/**
 * Minimal Wyze cloud client.
 *
 * The cloud is used for exactly two things:
 *  1. signing in and reading the camera list (each camera's P2P id, local IP and
 *     encryption key, which go2rtc needs to connect locally), and
 *  2. reading motion events, which Wyze cameras report to the cloud, not over the
 *     local connection.
 * Video never goes through the cloud.
 *
 * Endpoints and payloads follow go2rtc's pkg/wyze/cloud.go (MIT) and the public
 * behavior of docker-wyze-bridge; this is an independent implementation.
 */

export const AUTH_API = 'https://auth-prod.api.wyze.com';
export const WYZE_API = 'https://api.wyzecam.com/app';
export const CLOUD_API = 'https://app-core.cloud.wyze.com/app';

const APP_NAME = 'com.hualai.WyzeCam';
const APP_VERSION = '3.1.6.1';
const IOS_VERSION = '17.1.1';
// app id and secret used by the Wyze app to sign v4 requests.
const SIGNING_APP_ID = '9319141212m2ik';
const SIGNING_APP_SECRET = 'wyze_app_secret_key_132';

const SC_SV: Record<string, { sc: string; sv: string }> = {
    default: { sc: '9f275790cab94a72bd206c8876429f3c', sv: 'e1fe392906d54888a9b99b88de4162d7' },
    get_object_list: { sc: '9f275790cab94a72bd206c8876429f3c', sv: '9d74946e652647e9b6c9d59326aef104' },
};

export interface WyzeTokens {
    accessToken: string;
    refreshToken?: string;
    userId?: string;
    phoneId: string;
}

export interface WyzeCamera {
    mac: string;
    p2pId: string;
    enr: string;
    ip: string;
    nickname: string;
    model: string;
    firmware?: string;
    dtls: boolean;
    online: boolean;
}

export interface WyzeEvent {
    eventId: string;
    mac: string;
    timestampMs: number;
    eventValue?: string;
    eventCategory?: string;
    tags: string[];
    raw: any;
}

export class WyzeApiError extends Error {
    constructor(public code: string, message: string) {
        super(message);
    }
}

export class WyzeAuthError extends WyzeApiError {
}

export class WyzeRateLimitError extends Error {
    constructor(public retryAfterMs: number, message: string) {
        super(message);
    }
}

/**
 * Wyze hashes the password with MD5 three times before sending it.
 * A value starting with "md5:" is treated as already hashed.
 */
export function hashPassword(password: string): string {
    let encoded = password.trim();
    if (encoded.toLowerCase().startsWith('md5:'))
        return encoded.substring(4);
    for (let i = 0; i < 3; i++)
        encoded = crypto.createHash('md5').update(encoded, 'utf8').digest('hex');
    return encoded;
}

/**
 * JSON with keys sorted at every level and no whitespace, matching
 * Python's json.dumps(sort_keys=True, separators=(",", ":")) which the v4 signature is computed over.
 */
export function sortedJson(value: any): string {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return '[' + value.map(v => sortedJson(v)).join(',') + ']';
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + sortedJson(value[k])).join(',') + '}';
}

/**
 * v4 request signature: HMAC-MD5 over the body, keyed with md5(accessToken + appSecret) as hex.
 */
export function signBody(body: string, accessToken: string): string {
    const key = crypto.createHash('md5').update(accessToken + SIGNING_APP_SECRET).digest('hex');
    return crypto.createHmac('md5', key).update(body).digest('hex');
}

export function randomPhoneId() {
    return crypto.randomUUID();
}

export class WyzeCloud {
    tokens?: WyzeTokens;
    // overridable for testing against a mock server.
    authApi = process.env.WYZE_NATIVE_AUTH_API || AUTH_API;
    wyzeApi = process.env.WYZE_NATIVE_WYZE_API || WYZE_API;
    cloudApi = process.env.WYZE_NATIVE_CLOUD_API || CLOUD_API;

    constructor(
        public email: string,
        public password: string,
        public apiId: string,
        public apiKey: string,
        public console: Console = globalThis.console,
    ) {
    }

    private basePayload(endpoint = 'default') {
        const scsv = SC_SV[endpoint] || SC_SV.default;
        return {
            sc: scsv.sc,
            sv: scsv.sv,
            app_ver: `${APP_NAME}___${APP_VERSION}`,
            app_version: APP_VERSION,
            app_name: APP_NAME,
            phone_system_type: 1,
            ts: Date.now(),
            access_token: this.tokens?.accessToken,
            phone_id: this.tokens?.phoneId,
        };
    }

    private appHeaders() {
        return {
            'Content-Type': 'application/json',
            'User-Agent': `Wyze/${APP_VERSION} (iPhone; iOS ${IOS_VERSION}; Scale/3.00)`,
            appversion: APP_VERSION,
            env: 'prod',
        };
    }

    private async readJson(res: Response, what: string) {
        if (res.status === 429) {
            const reset = res.headers.get('X-RateLimit-Reset-By');
            const resetMs = reset ? Date.parse(reset) : NaN;
            const wait = !isNaN(resetMs) ? Math.max(resetMs - Date.now(), 30000) : 60000;
            throw new WyzeRateLimitError(wait, `${what}: rate limited by Wyze, retry in ${Math.round(wait / 1000)}s`);
        }
        const text = await res.text();
        let json: any;
        try {
            json = JSON.parse(text);
        }
        catch (e) {
            throw new WyzeApiError(String(res.status), `${what}: HTTP ${res.status}, not JSON: ${text.substring(0, 200)}`);
        }
        const code = String(json.code ?? json.errorCode ?? '0');
        if (code === '2001')
            throw new WyzeAuthError(code, `${what}: access token expired or invalid`);
        if (code !== '1' && code !== '0') {
            const msg = json.msg || json.description || json.message || code;
            throw new WyzeApiError(code, `${what}: Wyze error ${code}: ${msg}`);
        }
        return json;
    }

    async login(): Promise<WyzeTokens> {
        const phoneId = this.tokens?.phoneId || randomPhoneId();
        const res = await fetch(`${this.authApi}/api/user/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: this.apiKey,
                keyid: this.apiId,
                'User-Agent': 'scrypted-wyze-native',
            },
            body: JSON.stringify({ email: this.email.trim(), password: hashPassword(this.password) }),
        });
        const json = await this.readJson(res, 'login');
        if (Array.isArray(json.mfa_options) && json.mfa_options.length && !json.access_token)
            throw new WyzeApiError('mfa', `login: Wyze asked for two-factor verification (${json.mfa_options.join(', ')}). API key logins normally skip this; check the API ID and key.`);
        if (!json.access_token)
            throw new WyzeApiError('auth', 'login: Wyze returned no access token. Check the email, password, API ID and API key.');
        this.tokens = {
            accessToken: json.access_token,
            refreshToken: json.refresh_token,
            userId: json.user_id,
            phoneId,
        };
        return this.tokens;
    }

    async refresh(): Promise<WyzeTokens> {
        if (!this.tokens?.refreshToken)
            return this.login();
        try {
            const res = await fetch(`${this.wyzeApi}/user/refresh_token`, {
                method: 'POST',
                headers: this.appHeaders(),
                body: JSON.stringify({ ...this.basePayload(), refresh_token: this.tokens.refreshToken }),
            });
            const json = await this.readJson(res, 'refresh token');
            this.tokens = {
                ...this.tokens,
                accessToken: json.data.access_token,
                refreshToken: json.data.refresh_token || this.tokens.refreshToken,
            };
            return this.tokens;
        }
        catch (e) {
            this.console.warn('token refresh failed, signing in again.', (e as Error).message);
            return this.login();
        }
    }

    /**
     * Run a request, refreshing the token once if Wyze says it expired.
     */
    private async authed<T>(fn: () => Promise<T>): Promise<T> {
        if (!this.tokens)
            await this.login();
        try {
            return await fn();
        }
        catch (e) {
            if (!(e instanceof WyzeAuthError))
                throw e;
            await this.refresh();
            return fn();
        }
    }

    async getCameras(): Promise<WyzeCamera[]> {
        return this.authed(async () => {
            const res = await fetch(`${this.wyzeApi}/v2/home_page/get_object_list`, {
                method: 'POST',
                headers: this.appHeaders(),
                body: JSON.stringify(this.basePayload('get_object_list')),
            });
            const json = await this.readJson(res, 'camera list');
            const ret: WyzeCamera[] = [];
            for (const d of json.data?.device_list || []) {
                if (d.product_type !== 'Camera')
                    continue;
                const p = d.device_params || {};
                ret.push({
                    mac: d.mac,
                    p2pId: p.p2p_id,
                    enr: d.enr,
                    ip: p.ip,
                    nickname: d.nickname || d.mac,
                    model: d.product_model,
                    firmware: d.firmware_ver,
                    dtls: p.dtls === 1,
                    online: d.conn_state === 1,
                });
            }
            return ret;
        });
    }

    /**
     * Motion and other events the cameras uploaded since sinceMs.
     */
    async getEvents(macs: string[], sinceMs: number): Promise<WyzeEvent[]> {
        return this.authed(async () => {
            const now = Date.now();
            const params = {
                count: 20,
                order_by: 1,
                begin_time: Math.max(sinceMs, now - 1_000_000),
                end_time: now + 60_000,
                nonce: String(now),
                device_id_list: [...new Set(macs)],
                event_value_list: [] as string[],
                event_tag_list: [] as string[],
            };
            const body = sortedJson(params);
            const tokens = this.tokens!;
            const res = await fetch(`${this.cloudApi}/v4/device/get_event_list`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    phoneid: tokens.phoneId,
                    'User-Agent': `wyze_ios_${APP_VERSION}`,
                    appinfo: `wyze_ios_${APP_VERSION}`,
                    appversion: APP_VERSION,
                    access_token: tokens.accessToken,
                    appid: SIGNING_APP_ID,
                    env: 'prod',
                    signature2: signBody(body, tokens.accessToken),
                },
                body,
            });
            const json = await this.readJson(res, 'event list');
            return (json.data?.event_list || []).map((e: any) => ({
                eventId: String(e.event_id),
                mac: e.device_id || e.device_mac,
                timestampMs: Number(e.event_ts),
                eventValue: e.event_value !== undefined ? String(e.event_value) : undefined,
                eventCategory: e.event_category !== undefined ? String(e.event_category) : undefined,
                tags: (e.tag_list || []).map((t: any) => String(t)),
                raw: e,
            }));
        });
    }
}

/**
 * The go2rtc source url for a camera, built the same way go2rtc's own Wyze UI builds it.
 */
export function go2rtcSourceUrl(cam: WyzeCamera, subtype: 'hd' | 'sd'): string {
    const q = new URLSearchParams();
    q.set('uid', cam.p2pId);
    q.set('enr', cam.enr);
    q.set('mac', cam.mac);
    q.set('model', cam.model);
    if (cam.dtls)
        q.set('dtls', 'true');
    q.set('subtype', subtype);
    return `wyze://${cam.ip}?${q.toString()}`;
}
