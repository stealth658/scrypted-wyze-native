/**
 * Small H.264 helpers: read the picture size and profile from an SPS,
 * and pull SPS/PPS/IDR NAL units out of RTP payloads (RFC 6184).
 */

export interface SpsInfo {
    profile: number;
    level: number;
    width: number;
    height: number;
}

const PROFILE_NAMES: Record<number, string> = { 66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High' };

export function describeSps(info: SpsInfo | undefined) {
    if (!info)
        return 'unknown';
    return `${info.width}x${info.height} ${PROFILE_NAMES[info.profile] || `profile ${info.profile}`} level ${info.level / 10}`;
}

class BitReader {
    private bit = 0;
    constructor(private data: Buffer) { }

    u(n: number) {
        let v = 0;
        for (let i = 0; i < n; i++) {
            const byte = this.data[this.bit >> 3];
            if (byte === undefined)
                throw new Error('SPS ended early');
            v = v * 2 + ((byte >> (7 - (this.bit & 7))) & 1);
            this.bit++;
        }
        return v;
    }

    ue() {
        let zeros = 0;
        while (this.u(1) === 0) {
            zeros++;
            if (zeros > 31)
                throw new Error('bad exp-golomb value');
        }
        return 2 ** zeros - 1 + this.u(zeros);
    }

    se() {
        const k = this.ue();
        return k % 2 ? (k + 1) / 2 : -(k / 2);
    }
}

function unescapeRbsp(nal: Buffer) {
    const out: number[] = [];
    let zeros = 0;
    for (let i = 1; i < nal.length; i++) {
        const b = nal[i];
        if (zeros >= 2 && b === 3) {
            zeros = 0;
            continue;
        }
        out.push(b);
        zeros = b === 0 ? zeros + 1 : 0;
    }
    return Buffer.from(out);
}

const HIGH_PROFILES = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];

/** Parse an SPS NAL unit (including its 1 byte NAL header). */
export function parseSps(nal: Buffer): SpsInfo {
    const r = new BitReader(unescapeRbsp(nal));
    const profile = r.u(8);
    r.u(8);
    const level = r.u(8);
    r.ue();
    let chromaFormat = 1;
    if (HIGH_PROFILES.includes(profile)) {
        chromaFormat = r.ue();
        if (chromaFormat === 3)
            r.u(1);
        r.ue();
        r.ue();
        r.u(1);
        if (r.u(1)) {
            for (let i = 0; i < (chromaFormat !== 3 ? 8 : 12); i++) {
                if (!r.u(1))
                    continue;
                let last = 8, next = 8;
                for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
                    if (next !== 0)
                        next = (last + r.se() + 256) % 256;
                    last = next === 0 ? last : next;
                }
            }
        }
    }
    r.ue();
    const pocType = r.ue();
    if (pocType === 0) {
        r.ue();
    }
    else if (pocType === 1) {
        r.u(1);
        r.se();
        r.se();
        const n = r.ue();
        for (let i = 0; i < n; i++)
            r.se();
    }
    r.ue();
    r.u(1);
    const widthMbs = r.ue() + 1;
    const heightMapUnits = r.ue() + 1;
    const frameMbsOnly = r.u(1);
    if (!frameMbsOnly)
        r.u(1);
    r.u(1);
    let crop = [0, 0, 0, 0];
    if (r.u(1))
        crop = [r.ue(), r.ue(), r.ue(), r.ue()];
    // crop units for 4:2:0, the only format these cameras send
    const cropX = chromaFormat === 0 || chromaFormat === 3 ? 1 : 2;
    const cropY = (chromaFormat === 1 || chromaFormat === 0 ? 2 : 1) * (2 - frameMbsOnly);
    return {
        profile,
        level,
        width: widthMbs * 16 - cropX * (crop[0] + crop[1]),
        height: (2 - frameMbsOnly) * heightMapUnits * 16 - cropY * (crop[2] + crop[3]),
    };
}

/**
 * Watches an RTP H.264 stream and records the SPS/PPS in effect at each keyframe.
 */
export class ParameterSetCollector {
    sps?: Buffer;
    pps?: Buffer;
    keyframes: { sps: Buffer, pps: Buffer }[] = [];
    private lastKeyframeTimestamp?: number;

    private keyframe(timestamp: number) {
        if (!this.sps || !this.pps || timestamp === this.lastKeyframeTimestamp)
            return;
        this.lastKeyframeTimestamp = timestamp;
        this.keyframes.push({ sps: this.sps, pps: this.pps });
    }

    private nal(nal: Buffer, timestamp: number) {
        if (!nal.length)
            return;
        const type = nal[0] & 0x1f;
        if (type === 7)
            this.sps = Buffer.from(nal);
        else if (type === 8)
            this.pps = Buffer.from(nal);
        else if (type === 5)
            this.keyframe(timestamp);
    }

    addRtpPayload(payload: Buffer, timestamp: number) {
        if (!payload.length)
            return;
        const type = payload[0] & 0x1f;
        if (type >= 1 && type <= 23) {
            this.nal(payload, timestamp);
        }
        else if (type === 24) {
            // STAP-A: 2 byte size + NAL, repeated
            let i = 1;
            while (i + 2 <= payload.length) {
                const size = payload.readUInt16BE(i);
                i += 2;
                if (!size || i + size > payload.length)
                    break;
                this.nal(payload.subarray(i, i + size), timestamp);
                i += size;
            }
        }
        else if (type === 28 && payload.length >= 2) {
            // FU-A: SPS/PPS are never this big, so only the start of a keyframe matters.
            if ((payload[1] & 0x80) && (payload[1] & 0x1f) === 5)
                this.keyframe(timestamp);
        }
    }
}

/** RTP payload of a packet, skipping CSRCs, header extension and padding. */
export function rtpPayload(packet: Buffer): { payload: Buffer, timestamp: number } | undefined {
    if (packet.length < 12 || (packet[0] >> 6) !== 2)
        return;
    const csrcCount = packet[0] & 0x0f;
    let offset = 12 + csrcCount * 4;
    if (packet[0] & 0x10) {
        if (packet.length < offset + 4)
            return;
        offset += 4 + packet.readUInt16BE(offset + 2) * 4;
    }
    let end = packet.length;
    if (packet[0] & 0x20)
        end -= packet[packet.length - 1];
    if (offset > end)
        return;
    return { payload: packet.subarray(offset, end), timestamp: packet.readUInt32BE(4) };
}
