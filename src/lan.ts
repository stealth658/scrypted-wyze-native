import dgram from 'dgram';
import fs from 'fs';
import os from 'os';

/**
 * Find a device's current IP address on the local network from its MAC address.
 *
 * Wyze's cloud can keep listing an address the camera no longer has (the Wyze app shows that same
 * stale value). The server's own neighbour (ARP) table is the ground truth for who has which address.
 */

const ARP_FILE = process.env.WYZE_NATIVE_ARP_FILE || '/proc/net/arp';

export function formatMac(mac: string) {
    const hex = mac.replace(/[^0-9a-f]/gi, '').toLowerCase();
    return hex.length === 12 ? hex.match(/../g)!.join(':') : '';
}

/** IPs the neighbour table currently maps to this MAC. */
export function arpLookup(mac: string, arpFile = ARP_FILE): string[] {
    const want = formatMac(mac);
    if (!want)
        return [];
    let text: string;
    try {
        text = fs.readFileSync(arpFile, 'utf8');
    }
    catch (e) {
        return [];
    }
    const ips: string[] = [];
    for (const line of text.split('\n').slice(1)) {
        // IP address, HW type, Flags, HW address, Mask, Device
        const [ip, , flags, hw] = line.trim().split(/\s+/);
        if (ip && hw?.toLowerCase() === want && flags !== '0x0' && !ips.includes(ip))
            ips.push(ip);
    }
    return ips;
}

function ipToInt(ip: string) {
    return ip.split('.').reduce((n, part) => n * 256 + parseInt(part), 0);
}

function intToIp(n: number) {
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** Host addresses of the local IPv4 networks to search, preferring the one hintIp belongs to. */
export function sweepTargets(hintIp?: string, interfaces = os.networkInterfaces()): string[] {
    const nets: { base: number, size: number, own: number, hint: boolean }[] = [];
    for (const list of Object.values(interfaces)) {
        for (const a of list || []) {
            if (a.family !== 'IPv4' || a.internal)
                continue;
            const mask = ipToInt(a.netmask) >>> 0;
            const size = (~mask >>> 0) + 1;
            // small home networks only; never spray a large range.
            if (size > 1024 || size < 4)
                continue;
            const own = ipToInt(a.address) >>> 0;
            const base = (own & mask) >>> 0;
            const hint = !!hintIp && ((ipToInt(hintIp) & mask) >>> 0) === base;
            if (!nets.some(n => n.base === base && n.size === size))
                nets.push({ base, size, own, hint });
        }
    }
    const chosen = nets.some(n => n.hint) ? nets.filter(n => n.hint) : nets;
    const targets: string[] = [];
    for (const n of chosen) {
        for (let i = 1; i < n.size - 1; i++) {
            const ip = (n.base + i) >>> 0;
            if (ip !== n.own)
                targets.push(intToIp(ip));
        }
    }
    return targets.slice(0, 2048);
}

/**
 * Make the kernel resolve every address on the local network by sending each one an empty UDP
 * datagram (discard port). Nothing needs to answer the datagram; resolving the address fills the table.
 */
async function sweep(targets: string[]) {
    if (!targets.length)
        return;
    const socket = dgram.createSocket('udp4');
    socket.on('error', () => { });
    try {
        for (const ip of targets)
            socket.send(Buffer.alloc(0), 9, ip, () => { });
        await new Promise(r => setTimeout(r, 2000));
    }
    finally {
        try {
            socket.close();
        }
        catch (e) {
        }
    }
}

export async function findIpByMac(mac: string, hintIp?: string, opts?: { arpFile?: string, sweep?: boolean }): Promise<string | undefined> {
    const pick = (ips: string[]) => ips.find(ip => ip !== hintIp) ?? ips[0];
    let ips = arpLookup(mac, opts?.arpFile);
    if (!ips.length && opts?.sweep !== false) {
        await sweep(sweepTargets(hintIp));
        ips = arpLookup(mac, opts?.arpFile);
    }
    return pick(ips);
}
