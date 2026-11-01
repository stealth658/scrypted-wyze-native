# Wyze Native for Scrypted

Wyze cameras in Scrypted with **local video** and the **cameras' own motion detection**, with no separate bridge container.

## How it works

- **Video stays local.** The plugin runs [go2rtc](https://github.com/AlexxIT/go2rtc) (the engine inside docker-wyze-bridge) inside Scrypted. go2rtc connects to each camera directly over your network using Wyze's P2P protocol, and Scrypted reads the video from go2rtc on `127.0.0.1`. No video goes through Wyze's cloud, so prebuffering and HomeKit Secure Video work locally.
- **Motion comes from the cameras.** Wyze cameras report motion to Wyze's cloud, not over the local connection, so the plugin checks Wyze for new events every couple of seconds (small JSON requests, not video) and turns on the matching camera's motion sensor.
- **The cloud is used for:** signing in, reading each camera's local IP and connection key, and motion events. The camera list is cached, so video keeps working at startup even if Wyze's cloud is down.

go2rtc v1.9.15 is downloaded from its official GitHub release on first start and checked against a pinned SHA-256 before it runs.

## Requirements

- Scrypted on Linux (x86_64 or arm64), e.g. the official Docker image.
- A Wyze API ID and API key from the [Wyze Developer Console](https://developer-api-console.wyze.com/#/apikey/view).
- Camera firmware with DTLS for most models. See go2rtc's [Wyze compatibility table](https://github.com/AlexxIT/go2rtc/tree/master/internal/wyze). Newer Gwell-based models (Cam OG, Pan v4) aren't supported by go2rtc yet and are skipped.
- For motion: motion detection and event recording turned on for the camera in the Wyze app, so it uploads events.

## Install

On the Scrypted server (or any machine on the same network with Node.js):

```
git clone https://github.com/stealth658/scrypted-wyze-native
cd scrypted-wyze-native
npm install
npm run build
npx scrypted login 127.0.0.1
npm run scrypted-deploy 127.0.0.1
```

Without Node on the host, run it in a throwaway container:

```
docker run --rm -it --network host -v "$PWD":/app -w /app node:22 \
  bash -c "npm install && npm run build && npx scrypted login 127.0.0.1 && npm run scrypted-deploy 127.0.0.1"
```

## Set up

1. Open **Plugins > Wyze Native** and enter your Wyze email, password, API ID and API key.
2. Your cameras appear as Scrypted cameras with HD and SD streams and a motion sensor.
3. If you used docker-wyze-bridge or the old Wyze plugin, remove those cameras from Scrypted and stop the bridge once this works, so two programs aren't connecting to each camera.
4. Pair cameras with HomeKit as usual. Cameras that don't need motion (e.g. a stream-only camera) can have **Wyze Motion** turned off in their own settings.

## Settings

| Setting | What it's for |
|---|---|
| Check Interval | How often to ask Wyze for new events (default 2s). Lower is faster but closer to Wyze's rate limits. |
| Motion Duration | Wyze reports when motion starts, not when it ends, so motion stays on this long after the latest event (default 20s). |
| Log Raw Events | Log every event from Wyze, to see what your cameras send. |
| Ignore Cameras | MAC addresses to leave out. |
| go2rtc ports | Local RTSP (48554) and API (41984) ports, localhost only. Change if something else uses them. |

## Limits

- Motion arrives a few seconds after it happens, because it goes camera → Wyze → plugin. Scrypted's prebuffer covers the start of most recordings, but a slow day at Wyze could clip the first second or two.
- Motion needs internet access. Video doesn't.
- Every event type Wyze reports for a camera currently counts as motion. Turn on **Log Raw Events** to see what yours send.
