import sdk, {
    DeviceProvider,
    MediaObject,
    MediaStreamUrl,
    MotionSensor,
    RequestMediaStreamOptions,
    ResponseMediaStreamOptions,
    ScryptedDeviceBase,
    ScryptedDeviceType,
    ScryptedInterface,
    ScryptedMimeTypes,
    ScryptedNativeId,
    Setting,
    Settings,
    SettingValue,
    VideoCamera,
} from '@scrypted/sdk';
import os from 'os';
import path from 'path';
import { Go2rtc, GO2RTC_VERSION } from './go2rtc';
import { go2rtcSourceUrl, WyzeCamera, WyzeCloud, WyzeEvent, WyzeRateLimitError, WyzeTokens } from './wyze-cloud';

const CREDENTIAL_KEYS = ['email', 'password', 'apiId', 'apiKey'];

const { deviceManager } = sdk;

// friendly names for models in go2rtc's Wyze compatibility list.
const MODEL_NAMES: Record<string, string> = {
    WYZEC1: 'Wyze Cam v1',
    'WYZEC1-JZ': 'Wyze Cam v2',
    WYZE_CAKP2JFUS: 'Wyze Cam v3 / Floodlight',
    HL_CAM3P: 'Wyze Cam v3 Pro',
    HL_CAM4: 'Wyze Cam v4',
    WYZECP1_JEF: 'Wyze Cam Pan',
    HL_PAN2: 'Wyze Cam Pan v2',
    HL_PAN3: 'Wyze Cam Pan v3',
    HL_PANP: 'Wyze Cam Pan Pro',
    WVOD1: 'Wyze Cam Outdoor',
    HL_WCO2: 'Wyze Cam Outdoor v2',
    HL_CFL2: 'Wyze Cam Floodlight v2',
    WYZEDB3: 'Wyze Video Doorbell',
    HL_DB2: 'Wyze Video Doorbell v2',
};

// events older than this when first seen are history, not motion happening now.
const MAX_EVENT_AGE_MS = 30000;

function streamName(mac: string, sub: boolean) {
    return `wyze_${mac.toLowerCase()}${sub ? '_sd' : ''}`;
}

export class WyzeCameraDevice extends ScryptedDeviceBase implements VideoCamera, MotionSensor, Settings {
    private motionTimer?: NodeJS.Timeout;
    lastEvent = 'None yet';

    constructor(nativeId: string, public plugin: WyzeNativePlugin) {
        super(nativeId);
        this.motionDetected = false;
    }

    get camera(): WyzeCamera | undefined {
        return this.plugin.cameras.get(this.nativeId!);
    }

    get cloudMotionEnabled() {
        return this.storage.getItem('cloudMotion') !== 'false';
    }

    async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        return [
            { id: 'hd', name: 'HD', container: 'rtsp', tool: 'scrypted', video: {}, },
            { id: 'sd', name: 'SD', container: 'rtsp', tool: 'scrypted', video: {}, },
        ];
    }

    async getVideoStream(options?: RequestMediaStreamOptions): Promise<MediaObject> {
        const vsos = await this.getVideoStreamOptions();
        const vso = vsos.find(v => v.id === options?.id) || vsos[0];
        const url = this.plugin.go2rtc.rtspUrl(streamName(this.nativeId!, vso.id === 'sd'));
        const ret: MediaStreamUrl = {
            container: 'rtsp',
            url,
            mediaStreamOptions: vso,
        };
        return this.createMediaObject(ret, ScryptedMimeTypes.MediaStreamUrl);
    }

    triggerMotion(durationMs: number, event: WyzeEvent) {
        clearTimeout(this.motionTimer);
        this.motionDetected = true;
        const tags = event.tags.length ? ` tags=${event.tags.join(',')}` : '';
        this.lastEvent = `${new Date(event.timestampMs).toLocaleTimeString()} (value=${event.eventValue ?? '?'}${tags})`;
        this.console.log(`motion from Wyze: event ${event.eventId}, ${Math.round((Date.now() - event.timestampMs) / 1000)}s after it happened${tags}`);
        this.motionTimer = setTimeout(() => this.motionDetected = false, durationMs);
    }

    async getSettings(): Promise<Setting[]> {
        const cam = this.camera;
        return [
            {
                key: 'cloudMotion', title: 'Wyze Motion', type: 'boolean',
                description: "Use this camera's own motion detection, reported through Wyze's cloud. Turn off for cameras that don't need motion.",
                value: this.cloudMotionEnabled,
            },
            { key: 'lastEvent', title: 'Last Wyze Event', readonly: true, value: this.lastEvent },
            { key: 'model', title: 'Model', readonly: true, value: cam ? `${MODEL_NAMES[cam.model] || 'Unknown'} (${cam.model})` : '' },
            { key: 'ip', title: 'Camera IP', readonly: true, value: cam?.ip || '' },
            { key: 'mac', title: 'MAC', readonly: true, value: cam?.mac || '' },
            { key: 'dtls', title: 'DTLS', readonly: true, value: cam ? (cam.dtls ? 'Yes' : 'No (go2rtc may not support this firmware)') : '' },
        ];
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        this.storage.setItem(key, String(value));
        this.onDeviceEvent(ScryptedInterface.Settings, undefined);
    }
}

export class WyzeNativePlugin extends ScryptedDeviceBase implements DeviceProvider, Settings {
    cameras = new Map<string, WyzeCamera>();
    devices = new Map<string, WyzeCameraDevice>();
    go2rtc: Go2rtc;
    cloud?: WyzeCloud;
    private pollTimer?: NodeJS.Timeout;
    private refreshTimer?: NodeJS.Timeout;
    private credentialTimer?: NodeJS.Timeout;
    private startGeneration = 0;
    private seenEvents: string[] = [];
    private lastEventMs = Date.now();
    private cloudStatus = 'Not signed in';
    private motionStatus = 'Not running';
    private releasing = false;

    constructor(nativeId?: string) {
        super(nativeId);
        this.go2rtc = new Go2rtc(this.go2rtcOptions(), this.console);
        try {
            for (const c of JSON.parse(this.storage.getItem('cameraCache') || '[]') as WyzeCamera[])
                this.cameras.set(c.mac, c);
        }
        catch (e) {
        }
        process.once('exit', () => this.go2rtc.stop());
        process.nextTick(() => this.start());
    }

    private go2rtcOptions() {
        const filesDir = path.join(process.env.SCRYPTED_PLUGIN_VOLUME || os.tmpdir(), 'files');
        return {
            filesDir,
            rtspPort: parseInt(this.storage.getItem('rtspPort') || '') || 48554,
            apiPort: parseInt(this.storage.getItem('apiPort') || '') || 41984,
            logLevel: this.storage.getItem('go2rtcLogLevel') || 'info',
            binaryOverride: this.storage.getItem('go2rtcBinary') || undefined,
        };
    }

    private get configured() {
        return ['email', 'password', 'apiId', 'apiKey'].every(k => !!this.storage.getItem(k));
    }

    async start() {
        const generation = ++this.startGeneration;
        clearTimeout(this.refreshTimer);
        // start streaming from the cached camera list first, so video works even if Wyze's cloud is down.
        await this.applyCameras();
        if (generation !== this.startGeneration)
            return;
        if (!this.configured) {
            this.cloudStatus = 'Enter your Wyze email, password, API ID and API key in settings.';
            this.console.warn(this.cloudStatus);
            return;
        }
        this.cloud = new WyzeCloud(
            this.storage.getItem('email')!,
            this.storage.getItem('password')!,
            this.storage.getItem('apiId')!,
            this.storage.getItem('apiKey')!,
            this.console,
        );
        try {
            const tokens = JSON.parse(this.storage.getItem('tokens') || 'null') as WyzeTokens;
            if (tokens?.accessToken)
                this.cloud.tokens = tokens;
        }
        catch (e) {
        }
        // keep the rate limit lockout across restarts of the cloud client.
        const blockedUntil = parseInt(this.storage.getItem('blockedUntil') || '0');
        if (blockedUntil > Date.now())
            this.cloud.blockedUntil = blockedUntil;
        await this.refreshCameras();
        if (generation === this.startGeneration)
            this.schedulePoll(1000);
    }

    async refreshCameras() {
        if (!this.cloud)
            return;
        try {
            const cams = await this.cloud.getCameras();
            this.saveTokens();
            const usable = cams.filter(c => c.ip && c.p2pId && c.enr);
            const skipped = cams.filter(c => !usable.includes(c));
            for (const c of skipped)
                this.console.warn(`skipping ${c.nickname} (${c.model}): no local IP or P2P id. Newer Gwell-based models are not supported by go2rtc yet.`);
            this.cameras = new Map(usable.map(c => [c.mac, c]));
            this.storage.setItem('cameraCache', JSON.stringify(usable));
            this.storage.removeItem('blockedUntil');
            this.cloudStatus = `Signed in, ${usable.length} camera(s) at ${new Date().toLocaleTimeString()}`;
            await this.applyCameras();
        }
        catch (e) {
            const cloud = this.cloud;
            if (e instanceof WyzeRateLimitError) {
                // retry by itself once Wyze's lockout ends, plus a little slack.
                const wait = e.retryAfterMs + 5000;
                this.storage.setItem('blockedUntil', String(cloud?.blockedUntil || 0));
                this.cloudStatus = `Rate limited by Wyze, retrying automatically at ${new Date(Date.now() + wait).toLocaleTimeString()}`;
                clearTimeout(this.refreshTimer);
                this.refreshTimer = setTimeout(() => {
                    if (this.cloud === cloud)
                        this.refreshCameras();
                }, wait);
            }
            else {
                this.cloudStatus = `Error: ${(e as Error).message}`;
            }
            this.console.error('could not load cameras from Wyze; using the cached list.', (e as Error).message);
        }
    }

    private saveTokens() {
        if (this.cloud?.tokens)
            this.storage.setItem('tokens', JSON.stringify(this.cloud.tokens));
    }

    private ignored(): Set<string> {
        return new Set((this.storage.getItem('ignoredMacs') || '').split(/[\s,]+/).map(s => s.toUpperCase()).filter(s => !!s));
    }

    private async applyCameras() {
        const ignored = this.ignored();
        const known = new Set(deviceManager.getNativeIds());
        const streams: Record<string, string> = {};
        for (const cam of this.cameras.values()) {
            if (ignored.has(cam.mac.toUpperCase()))
                continue;
            streams[streamName(cam.mac, false)] = go2rtcSourceUrl(cam, 'hd');
            streams[streamName(cam.mac, true)] = go2rtcSourceUrl(cam, 'sd');
            const existing = known.has(cam.mac) ? deviceManager.getDeviceState(cam.mac) : undefined;
            const info = {
                manufacturer: 'Wyze',
                model: MODEL_NAMES[cam.model] ? `${MODEL_NAMES[cam.model]} (${cam.model})` : cam.model,
                firmware: cam.firmware,
                mac: cam.mac,
                ip: cam.ip,
            };
            await deviceManager.onDeviceDiscovered({
                nativeId: cam.mac,
                name: existing?.name || cam.nickname,
                type: ScryptedDeviceType.Camera,
                interfaces: [ScryptedInterface.VideoCamera, ScryptedInterface.MotionSensor, ScryptedInterface.Settings],
                info,
            });
            const dev = this.devices.get(cam.mac);
            if (dev)
                dev.info = info;
        }
        const changed = this.go2rtc.setStreams(streams);
        if (changed || this.go2rtc.status === 'Not started') {
            try {
                await this.go2rtc.start();
            }
            catch (e) {
                this.go2rtc.status = `Error: ${(e as Error).message}`;
                this.console.error('go2rtc failed to start', (e as Error).message);
            }
        }
    }

    // ---------- motion from Wyze events ----------

    private schedulePoll(ms: number) {
        clearTimeout(this.pollTimer);
        if (!this.releasing)
            this.pollTimer = setTimeout(() => this.poll(), ms);
    }

    private get pollIntervalMs() {
        return Math.max(1, parseFloat(this.storage.getItem('pollInterval') || '') || 2) * 1000;
    }

    private get motionDurationMs() {
        return Math.max(5, parseFloat(this.storage.getItem('motionDuration') || '') || 20) * 1000;
    }

    async poll() {
        const watched = [...this.cameras.values()]
            .filter(c => !this.ignored().has(c.mac.toUpperCase()))
            .filter(c => this.getCameraDevice(c.mac)?.cloudMotionEnabled !== false)
            .map(c => c.mac);
        if (!this.cloud?.tokens || !watched.length) {
            // motion polling never signs in by itself; refreshCameras handles sign-in and its backoff.
            this.motionStatus = watched.length ? 'Waiting for Wyze sign-in' : 'No cameras with Wyze Motion on';
            this.schedulePoll(15000);
            return;
        }
        let next = this.pollIntervalMs;
        try {
            const events = await this.cloud.getEvents(watched, this.lastEventMs + 1);
            this.saveTokens();
            this.motionStatus = `Checking every ${this.pollIntervalMs / 1000}s, last check ${new Date().toLocaleTimeString()}`;
            this.handleEvents(events);
        }
        catch (e) {
            if (e instanceof WyzeRateLimitError) {
                next = e.retryAfterMs;
                this.motionStatus = `Rate limited by Wyze, pausing ${Math.round(next / 1000)}s`;
            }
            else {
                next = 60000;
                this.motionStatus = `Error, retrying in 60s: ${(e as Error).message}`;
            }
            this.console.error('[motion]', this.motionStatus);
        }
        this.schedulePoll(next);
    }

    handleEvents(events: WyzeEvent[]) {
        const debug = this.storage.getItem('debug') === 'true';
        // oldest first so motion timers end up based on the newest event.
        for (const e of [...events].sort((a, b) => a.timestampMs - b.timestampMs)) {
            if (this.seenEvents.includes(e.eventId))
                continue;
            this.seenEvents.push(e.eventId);
            if (this.seenEvents.length > 200)
                this.seenEvents.shift();
            this.lastEventMs = Math.max(this.lastEventMs, e.timestampMs);
            if (debug)
                this.console.log('[motion] raw event', JSON.stringify(e.raw));
            const age = Date.now() - e.timestampMs;
            if (age > MAX_EVENT_AGE_MS) {
                if (debug)
                    this.console.log(`[motion] ignoring event ${e.eventId}, ${Math.round(age / 1000)}s old`);
                continue;
            }
            const dev = this.getCameraDevice(e.mac);
            if (!dev) {
                this.console.log('[motion] event for a camera not in Scrypted', e.mac);
                continue;
            }
            if (!dev.cloudMotionEnabled)
                continue;
            dev.triggerMotion(this.motionDurationMs, e);
        }
    }

    // ---------- DeviceProvider ----------

    getCameraDevice(mac: string) {
        let dev = this.devices.get(mac);
        if (!dev && deviceManager.getNativeIds().includes(mac)) {
            dev = new WyzeCameraDevice(mac, this);
            this.devices.set(mac, dev);
        }
        return dev;
    }

    async getDevice(nativeId: ScryptedNativeId): Promise<any> {
        if (!nativeId)
            return;
        let dev = this.devices.get(nativeId);
        if (!dev) {
            dev = new WyzeCameraDevice(nativeId, this);
            this.devices.set(nativeId, dev);
        }
        return dev;
    }

    async releaseDevice(id: string, nativeId: ScryptedNativeId): Promise<void> {
        if (nativeId)
            this.devices.delete(nativeId);
    }

    async release() {
        this.releasing = true;
        clearTimeout(this.pollTimer);
        await this.go2rtc.stop();
    }

    // ---------- Settings ----------

    async getSettings(): Promise<Setting[]> {
        return [
            { group: 'Wyze Account', key: 'email', title: 'Email', value: this.storage.getItem('email'), description: 'Wyze account email. Google/Apple sign-in accounts need a Wyze password set.' },
            { group: 'Wyze Account', key: 'password', title: 'Password', type: 'password', value: this.storage.getItem('password') },
            { group: 'Wyze Account', key: 'apiId', title: 'API ID', value: this.storage.getItem('apiId'), description: 'From the Wyze Developer Console (developer-api-console.wyze.com).' },
            { group: 'Wyze Account', key: 'apiKey', title: 'API Key', type: 'password', value: this.storage.getItem('apiKey') },
            { group: 'Wyze Account', key: 'cloudStatus', title: 'Status', readonly: true, value: this.cloudStatus },
            { group: 'Wyze Account', key: 'refresh', title: 'Refresh Cameras', type: 'button', description: 'Reload the camera list from Wyze, e.g. after a camera changes IP.' },
            {
                group: 'Cameras', key: 'cameraList', title: 'Cameras', readonly: true,
                value: [...this.cameras.values()].map(c => `${c.nickname} (${c.model}, ${c.ip})`).join(', ') || 'None yet',
            },
            { group: 'Cameras', key: 'ignoredMacs', title: 'Ignore Cameras (MAC)', value: this.storage.getItem('ignoredMacs'), description: 'Comma separated MAC addresses to leave out.' },
            { group: 'Motion', key: 'motionStatus', title: 'Status', readonly: true, value: this.motionStatus },
            { group: 'Motion', key: 'pollInterval', title: 'Check Interval (seconds)', type: 'number', placeholder: '2', value: this.storage.getItem('pollInterval'), description: 'How often to ask Wyze for new motion events. Lower is faster but more likely to hit Wyze rate limits.' },
            { group: 'Motion', key: 'motionDuration', title: 'Motion Duration (seconds)', type: 'number', placeholder: '20', value: this.storage.getItem('motionDuration'), description: 'Wyze reports when motion starts, not when it ends. Motion stays on this long after the latest event.' },
            { group: 'Motion', key: 'debug', title: 'Log Raw Events', type: 'boolean', value: this.storage.getItem('debug') === 'true' },
            { group: 'go2rtc', key: 'go2rtcStatus', title: 'Status', readonly: true, value: `${this.go2rtc.status}, version ${GO2RTC_VERSION}` },
            { group: 'go2rtc', key: 'rtspPort', title: 'Local RTSP Port', type: 'number', placeholder: '48554', value: this.storage.getItem('rtspPort'), description: 'Port go2rtc serves video on, localhost only.' },
            { group: 'go2rtc', key: 'apiPort', title: 'Local API Port', type: 'number', placeholder: '41984', value: this.storage.getItem('apiPort') },
            { group: 'go2rtc', key: 'go2rtcLogLevel', title: 'Log Level', choices: ['trace', 'debug', 'info', 'warn', 'error'], value: this.storage.getItem('go2rtcLogLevel') || 'info' },
            { group: 'go2rtc', key: 'go2rtcBinary', title: 'Binary Path Override', value: this.storage.getItem('go2rtcBinary'), description: 'Optional: use your own go2rtc binary instead of the pinned download.' },
        ];
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        if (key === 'refresh') {
            this.refreshCameras();
            return;
        }
        const previous = this.storage.getItem(key);
        this.storage.setItem(key, value?.toString() ?? '');
        if (CREDENTIAL_KEYS.includes(key)) {
            if (previous === (value?.toString() ?? '')) {
                this.onDeviceEvent(ScryptedInterface.Settings, undefined);
                return;
            }
            // the settings page saves each field separately; wait for the last one, then sign in once.
            this.storage.removeItem('tokens');
            this.cloud = undefined;
            this.cloudStatus = 'Signing in shortly...';
            clearTimeout(this.credentialTimer);
            this.credentialTimer = setTimeout(() => {
                if (this.configured)
                    this.start();
            }, 3000);
        }
        else if (['rtspPort', 'apiPort', 'go2rtcLogLevel', 'go2rtcBinary'].includes(key)) {
            this.go2rtc.opts = this.go2rtcOptions();
            this.go2rtc.start().catch(e => this.console.error('go2rtc restart failed', e));
        }
        else if (key === 'ignoredMacs') {
            this.applyCameras();
        }
        this.onDeviceEvent(ScryptedInterface.Settings, undefined);
    }
}

export default WyzeNativePlugin;
