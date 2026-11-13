import net from 'net';
import { describeSps, ParameterSetCollector, parseSps, rtpPayload } from './h264';

/**
 * go2rtc 1.9.15 builds a Wyze stream's description (SDP) from the first SPS it sees,
 * right after asking the camera for HD and before the switch takes effect. So the SDP
 * can describe 360p while the camera sends 2K. Live view copes, because the camera
 * repeats its SPS before each keyframe, but recordings copy the SDP's settings into
 * the MP4 header and come out black.
 *
 * This proxy sits between Scrypted and go2rtc. Everything passes through untouched
 * except DESCRIBE responses, where the H.264 sprop-parameter-sets and profile-level-id
 * are replaced with the SPS/PPS the camera is actually sending.
 */

interface RtspResponse {
    raw: Buffer;
    headers: Record<string, string>;
    body: Buffer;
}

/** Parse one complete RTSP response from the start of buf, if it's all there. */
function takeResponse(buf: Buffer): { response: RtspResponse, rest: Buffer } | undefined {
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0)
        return;
    const head = buf.subarray(0, end).toString();
    const headers: Record<string, string> = {};
    for (const line of head.split('\r\n').slice(1)) {
        const i = line.indexOf(':');
        if (i > 0)
            headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const length = parseInt(headers['content-length'] || '0') || 0;
    const total = end + 4 + length;
    if (buf.length < total)
        return;
    return {
        response: { raw: buf.subarray(0, total), headers, body: buf.subarray(end + 4, total) },
        rest: buf.subarray(total),
    };
}

function videoSection(sdp: string) {
    const sections = sdp.split(/(?=^m=)/m);
    const index = sections.findIndex(s => s.startsWith('m=video') && /a=rtpmap:\d+ H264\//i.test(s));
    return { sections, index };
}

/**
 * Replace the H.264 parameter sets in an SDP. Returns undefined if there is nothing to change.
 */
export function rewriteSdp(sdp: string, sps: Buffer, pps: Buffer): string | undefined {
    const { sections, index } = videoSection(sdp);
    if (index < 0)
        return;
    let section = sections[index];
    const sprop = `sprop-parameter-sets=${sps.toString('base64')},${pps.toString('base64')}`;
    const profile = `profile-level-id=${sps.subarray(1, 4).toString('hex')}`;
    const fmtp = section.match(/^a=fmtp:(\d+) (.*)$/m);
    if (fmtp) {
        let params = fmtp[2].split(';').map(p => p.trim()).filter(p => p && !/^(sprop-parameter-sets|profile-level-id)=/i.test(p));
        params.push(profile, sprop);
        const line = `a=fmtp:${fmtp[1]} ${params.join(';')}`;
        if (line === fmtp[0])
            return;
        section = section.replace(fmtp[0], line);
    }
    else {
        const pt = section.match(/^a=rtpmap:(\d+) H264\//im)![1];
        section = section.replace(/(^a=rtpmap:\d+ H264\/.*$)/im, `$1\r\na=fmtp:${pt} packetization-mode=1;${profile};${sprop}`);
    }
    sections[index] = section;
    return sections.join('');
}

export function sdpParameterSets(sdp: string): { sps?: Buffer, pps?: Buffer } {
    const { sections, index } = videoSection(sdp);
    const m = index >= 0 ? sections[index].match(/sprop-parameter-sets=([^;\s]+)/i) : undefined;
    if (!m)
        return {};
    const [sps, pps] = m[1].split(',').map(s => Buffer.from(s, 'base64'));
    return { sps, pps };
}

/**
 * Open a short RTSP session to go2rtc and return the SPS/PPS the camera is actually sending.
 * go2rtc shares one camera connection between all its clients, so this doesn't add load on the camera.
 *
 * If the first keyframe already differs from what go2rtc described, the camera has switched and that's
 * the answer. If it matches, wait for one more keyframe: the camera may still have been mid-switch.
 */
export function probeParameterSets(port: number, streamPath: string, timeoutMs: number, describedSps?: Buffer): Promise<{ sps: Buffer, pps: Buffer }> {
    return new Promise((resolve, reject) => {
        const base = `rtsp://127.0.0.1:${port}${streamPath}`;
        const socket = net.connect(port, '127.0.0.1');
        let buf: Buffer = Buffer.alloc(0);
        let cseq = 0;
        let session = '';
        let step: 'describe' | 'setup' | 'play' | 'media' = 'describe';
        const collector = new ParameterSetCollector();
        let finished = false;
        let result: { sps: Buffer, pps: Buffer } | undefined;

        const decide = () => {
            const k = collector.keyframes;
            if (!k.length)
                return;
            if (!describedSps || !k[0].sps.equals(describedSps))
                result = k[0];
            else if (k.length >= 2)
                result = k[k.length - 1];
        };

        const finish = (err?: Error) => {
            if (finished)
                return;
            finished = true;
            clearTimeout(timer);
            if (!err && session)
                socket.write(`TEARDOWN ${base} RTSP/1.0\r\nCSeq: ${++cseq}\r\nSession: ${session}\r\n\r\n`, () => socket.destroy());
            else
                socket.destroy();
            if (err)
                reject(err);
            else
                resolve(result!);
        };
        const timer = setTimeout(() => {
            // one keyframe is better than none.
            const k = collector.keyframes;
            if (k.length) {
                result = k[k.length - 1];
                finish();
            }
            else {
                finish(new Error('timed out waiting for a keyframe'));
            }
        }, timeoutMs);
        const send = (method: string, url: string, extra = '') =>
            socket.write(`${method} ${url} RTSP/1.0\r\nCSeq: ${++cseq}\r\nUser-Agent: scrypted-wyze-native\r\n${extra}\r\n`);

        socket.on('connect', () => send('DESCRIBE', base, 'Accept: application/sdp\r\n'));
        socket.on('error', e => finish(e));
        socket.on('close', () => finish(new Error('go2rtc closed the connection')));
        socket.on('data', data => {
            buf = Buffer.concat([buf, data]);
            while (buf.length && !finished) {
                if (buf[0] === 0x24) {
                    if (buf.length < 4)
                        return;
                    const length = buf.readUInt16BE(2);
                    if (buf.length < 4 + length)
                        return;
                    if (buf[1] === 0) {
                        const rtp = rtpPayload(buf.subarray(4, 4 + length));
                        if (rtp)
                            collector.addRtpPayload(rtp.payload, rtp.timestamp);
                        decide();
                        if (result)
                            return finish();
                    }
                    buf = buf.subarray(4 + length);
                    continue;
                }
                const taken = takeResponse(buf);
                if (!taken)
                    return;
                buf = taken.rest;
                const status = taken.response.raw.subarray(0, taken.response.raw.indexOf('\r\n')).toString();
                if (!/^RTSP\/1\.0 200/.test(status))
                    return finish(new Error(`go2rtc answered ${step.toUpperCase()} with "${status}"`));
                if (step === 'describe') {
                    const sdp = taken.response.body.toString();
                    const { sections, index } = videoSection(sdp);
                    if (index < 0)
                        return finish(new Error('no H.264 video in the stream'));
                    const control = sections[index].match(/^a=control:(\S+)/m)?.[1] || '';
                    const url = /^rtsp:\/\//i.test(control) ? control : control ? `${base}/${control}` : base;
                    step = 'setup';
                    send('SETUP', url, 'Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n');
                }
                else if (step === 'setup') {
                    session = (taken.response.headers['session'] || '').split(';')[0];
                    step = 'play';
                    send('PLAY', base, `Session: ${session}\r\nRange: npt=0.000-\r\n`);
                }
                else if (step === 'play') {
                    step = 'media';
                }
            }
        });
    });
}

export interface SdpFixOptions {
    listenPort: number;
    upstreamPort: number;
    probeTimeoutMs: number;
    /** How soon after a stream starts to check the description again, and how often after that. */
    firstRecheckMs?: number;
    recheckMs?: number;
    enabled: () => boolean;
    nameForPath?: (streamPath: string) => string;
}

export class SdpFixProxy {
    private server?: net.Server;
    private sockets = new Set<net.Socket>();
    private lastLogged = new Map<string, string>();
    private generation = 0;
    status = 'Not started';
    /** true when the port couldn't be opened; streams should bypass the proxy. */
    failed = false;

    get listening() {
        return !!this.server;
    }

    constructor(public opts: SdpFixOptions, public console: Console) { }

    rtspUrl(stream: string) {
        return `rtsp://127.0.0.1:${this.opts.listenPort}/${encodeURIComponent(stream)}`;
    }

    /**
     * Start listening. When the plugin reloads, the previous plugin process can hold the port
     * for a moment, so a busy port is retried before giving up.
     */
    async start(attempts = 10) {
        await this.stop();
        this.failed = false;
        const generation = this.generation;
        for (let attempt = 1; ; attempt++) {
            const server = net.createServer(client => this.handle(client));
            try {
                await new Promise<void>((resolve, reject) => {
                    server.once('error', reject);
                    server.listen(this.opts.listenPort, '127.0.0.1', () => {
                        server.off('error', reject);
                        resolve();
                    });
                });
            }
            catch (e) {
                if (generation !== this.generation)
                    return;
                if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt >= attempts) {
                    this.failed = true;
                    this.status = `Not running: ${(e as Error).message}`;
                    throw e;
                }
                this.status = `Waiting for port ${this.opts.listenPort}`;
                await new Promise(r => setTimeout(r, 1000));
                if (generation !== this.generation)
                    return;
                continue;
            }
            if (generation !== this.generation) {
                server.close();
                return;
            }
            server.on('error', e => this.console.error('stream proxy error', e));
            this.server = server;
            this.status = `Listening on 127.0.0.1:${this.opts.listenPort}`;
            return;
        }
    }

    async stop() {
        this.generation++;
        const server = this.server;
        this.server = undefined;
        // close() only finishes once every connection has ended, and video connections never end on their own.
        for (const socket of this.sockets)
            socket.destroy();
        this.sockets.clear();
        if (server)
            await new Promise<void>(resolve => server.close(() => resolve()));
        this.status = 'Stopped';
    }

    private handle(client: net.Socket) {
        const upstream = net.connect(this.opts.upstreamPort, '127.0.0.1');
        this.sockets.add(client);
        this.sockets.add(upstream);
        let recheckTimer: NodeJS.Timeout | undefined;
        const close = () => {
            clearTimeout(recheckTimer);
            this.sockets.delete(client);
            this.sockets.delete(upstream);
            client.destroy();
            upstream.destroy();
        };
        client.on('error', close);
        upstream.on('error', close);
        client.on('close', close);
        upstream.on('close', close);
        client.setNoDelay(true);
        upstream.setNoDelay(true);

        // client -> go2rtc: pass through, but note the stream path of each DESCRIBE.
        let requestText = '';
        const describePaths: string[] = [];
        const onClientData = (data: Buffer) => {
            upstream.write(data);
            requestText += data.toString('latin1');
            let end: number;
            while ((end = requestText.indexOf('\r\n\r\n')) >= 0) {
                const request = requestText.slice(0, end);
                requestText = requestText.slice(end + 4);
                const describe = request.match(/^DESCRIBE (\S+) RTSP\/1\.0/);
                if (describe) {
                    let path = '';
                    try {
                        path = new URL(describe[1]).pathname;
                    }
                    catch (e) {
                    }
                    describePaths.push(path);
                }
                if (request.startsWith('PLAY ')) {
                    // from here on the client only sends RTCP and keepalives; stop inspecting.
                    client.off('data', onClientData);
                    client.pipe(upstream);
                    return;
                }
            }
            if (requestText.length > 65536)
                requestText = '';
        };
        client.on('data', onClientData);

        // The camera can change what it sends after the description went out (a slow switch to HD, or a
        // later resolution change). The description can't be changed on a live connection, so if that
        // happens, drop the connection: Scrypted reconnects within seconds and gets a fresh description.
        const scheduleRecheck = (path: string, told: Buffer, delayMs: number) => {
            clearTimeout(recheckTimer);
            recheckTimer = setTimeout(async () => {
                if (client.destroyed)
                    return;
                try {
                    if (this.opts.enabled()) {
                        const now = await probeParameterSets(this.opts.upstreamPort, path, this.opts.probeTimeoutMs);
                        if (client.destroyed)
                            return;
                        const before = describeSps(safeParse(told)), after = describeSps(safeParse(now.sps));
                        if (before !== after) {
                            this.console.log(`${this.opts.nameForPath?.(path) || path}: camera changed from ${before} to ${after}. Restarting the stream so its description matches.`);
                            close();
                            return;
                        }
                    }
                }
                catch (e) {
                    // go2rtc busy or camera offline; the main connection will show that on its own.
                }
                scheduleRecheck(path, told, this.opts.recheckMs ?? 120000);
            }, delayMs);
        };

        // go2rtc -> client: pass responses on in order, fixing the SDP one, then pipe media straight through.
        let pending: Buffer = Buffer.alloc(0);
        let busy = false;
        const pump = async () => {
            if (busy)
                return;
            busy = true;
            try {
                while (pending.length && !client.destroyed) {
                    if (pending[0] === 0x24) {
                        // media started, nothing left to fix on this connection.
                        upstream.off('data', onUpstreamData);
                        client.write(pending);
                        pending = Buffer.alloc(0);
                        upstream.pipe(client);
                        return;
                    }
                    const taken = takeResponse(pending);
                    if (!taken)
                        return;
                    pending = taken.rest;
                    const { response } = taken;
                    const isSdp = /application\/sdp/i.test(response.headers['content-type'] || '');
                    const path = isSdp ? describePaths.shift() : undefined;
                    if (isSdp && path && this.opts.enabled()) {
                        const fix = await this.fixResponse(response, path);
                        client.write(fix.data);
                        if (fix.told && !client.destroyed)
                            scheduleRecheck(path, fix.told, this.opts.firstRecheckMs ?? 15000);
                    }
                    else {
                        client.write(response.raw);
                    }
                }
            }
            finally {
                busy = false;
            }
        };
        const onUpstreamData = (data: Buffer) => {
            pending = Buffer.concat([pending, data]);
            pump().then(() => {
                // data that arrived while a fix was in progress is picked up here.
                if (pending.length && !busy)
                    pump();
            });
        };
        upstream.on('data', onUpstreamData);
    }

    /** data is what to send the client; told is the SPS the client was given, when it could be checked. */
    private async fixResponse(response: RtspResponse, streamPath: string): Promise<{ data: Buffer, told?: Buffer }> {
        const name = this.opts.nameForPath?.(streamPath) || streamPath;
        const sdp = response.body.toString();
        // nothing to check for other codecs (e.g. H.265 cameras).
        if (videoSection(sdp).index < 0)
            return { data: response.raw };
        try {
            const described = sdpParameterSets(sdp);
            const actual = await probeParameterSets(this.opts.upstreamPort, streamPath, this.opts.probeTimeoutMs, described.sps);
            const same = described.sps?.equals(actual.sps) && described.pps?.equals(actual.pps);
            const fixed = same ? undefined : rewriteSdp(sdp, actual.sps, actual.pps);
            const before = described.sps ? describeSps(safeParse(described.sps)) : 'missing';
            const after = describeSps(safeParse(actual.sps));
            const summary = fixed ? `${name}: corrected stream description from ${before} to ${after}.` : `${name}: stream description matches the camera (${after}).`;
            if (this.lastLogged.get(streamPath) !== summary) {
                this.lastLogged.set(streamPath, summary);
                this.console.log(summary);
            }
            if (!fixed)
                return { data: response.raw, told: actual.sps };
            const head = response.raw.subarray(0, response.raw.indexOf('\r\n\r\n')).toString()
                .replace(/^Content-Length:.*$/im, `Content-Length: ${Buffer.byteLength(fixed)}`);
            return { data: Buffer.concat([Buffer.from(head + '\r\n\r\n'), Buffer.from(fixed)]), told: actual.sps };
        }
        catch (e) {
            this.console.warn(`${name}: couldn't check the stream description (${(e as Error).message}). Passing go2rtc's through unchanged.`);
            return { data: response.raw };
        }
    }
}

function safeParse(sps: Buffer) {
    try {
        return parseSps(sps);
    }
    catch (e) {
        return undefined;
    }
}
