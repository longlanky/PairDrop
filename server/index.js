import {spawn} from "child_process";
import fs from "fs";

import PairDropServer from "./server.js";
import PairDropWsServer from "./ws-server.js";

// Handle SIGINT
process.on('SIGINT', () => {
    console.info("SIGINT Received, exiting...")
    process.exit(0)
})

// Handle SIGTERM
process.on('SIGTERM', () => {
    console.info("SIGTERM Received, exiting...")
    process.exit(0)
})

// Evaluate arguments for deployment with Docker and Node.js
let conf = {};

// Handle APP ERRORS
// Continuing after an uncaught exception is unsafe as application state might be corrupted.
// The process is exited instead so that the process manager (Docker, systemd, pm2) can restart it.
process.on('uncaughtException', (error, origin) => {
    console.error('----- Uncaught exception -----')
    console.error(error)
    console.error('----- Exception origin -----')
    console.error(origin)
    if (conf.autoStart) {
        // spawn a new instance as this one is about to exit
        process.once('exit', () => spawn(
            process.argv[0],
            process.argv.slice(1),
            {
                cwd: process.cwd(),
                detached: true,
                stdio: 'inherit'
            }
        ));
    }
    process.exit(1)
})
process.on('unhandledRejection', (reason, promise) => {
    console.log('----- Unhandled Rejection at -----')
    console.log(promise)
    console.log('----- Reason -----')
    console.log(reason)
})

conf.debugMode = process.env.DEBUG_MODE === "true";

conf.port = process.env.PORT || 3000;

conf.wsFallback = process.argv.includes('--include-ws-fallback') || process.env.WS_FALLBACK === "true";

conf.rtcConfig = process.env.RTC_CONFIG && process.env.RTC_CONFIG !== "false"
    ? parseRtcConfig(process.env.RTC_CONFIG)
    : {
        "sdpSemantics": "unified-plan",
        "iceServers": [
            {
                "urls": "stun:stun.l.google.com:19302"
            }
        ]
    };


conf.signalingServer = process.env.SIGNALING_SERVER && process.env.SIGNALING_SERVER !== "false"
    ? process.env.SIGNALING_SERVER
    : false;

conf.ipv6Localize = parseInt(process.env.IPV6_LOCALIZE) || false;

let rateLimit = false;
if (process.argv.includes('--rate-limit') || process.env.RATE_LIMIT === "true") {
    rateLimit = true;
}
else {
    let envRateLimit = parseInt(process.env.RATE_LIMIT);
    if (!isNaN(envRateLimit)) {
        rateLimit = envRateLimit;
    }
}
conf.rateLimit = rateLimit;

// `RATE_LIMIT` only enables rate limiting. The number of requests and the window
// are configured separately so that `RATE_LIMIT` cannot be mistaken for hop count.
conf.rateLimitMax = parseInt(process.env.RATE_LIMIT_MAX) || 1000;
conf.rateLimitWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 5 * 60 * 1000;

// Number of reverse proxy hops that are trusted to determine the client ip.
// Tri-state: `true` trusts all hops (not recommended), `false`/`0` trusts none
// (also disables forwarded-header trust for ip rooms), a positive integer sets
// the hop count, and an unset variable keeps the previous default behaviour.
conf.trustProxy = parseTrustProxy(process.env.TRUST_PROXY);

conf.buttons = {
    "donation_button": {
        "active": process.env.DONATION_BUTTON_ACTIVE,
        "link": process.env.DONATION_BUTTON_LINK,
        "title": process.env.DONATION_BUTTON_TITLE
    },
    "twitter_button": {
        "active": process.env.TWITTER_BUTTON_ACTIVE,
        "link": process.env.TWITTER_BUTTON_LINK,
        "title": process.env.TWITTER_BUTTON_TITLE
    },
    "mastodon_button": {
        "active": process.env.MASTODON_BUTTON_ACTIVE,
        "link": process.env.MASTODON_BUTTON_LINK,
        "title": process.env.MASTODON_BUTTON_TITLE
    },
    "bluesky_button": {
        "active": process.env.BLUESKY_BUTTON_ACTIVE,
        "link": process.env.BLUESKY_BUTTON_LINK,
        "title": process.env.BLUESKY_BUTTON_TITLE
    },
    "custom_button": {
        "active": process.env.CUSTOM_BUTTON_ACTIVE,
        "link": process.env.CUSTOM_BUTTON_LINK,
        "title": process.env.CUSTOM_BUTTON_TITLE
    },
    "privacypolicy_button": {
        "active": process.env.PRIVACYPOLICY_BUTTON_ACTIVE,
        "link": process.env.PRIVACYPOLICY_BUTTON_LINK,
        "title": process.env.PRIVACYPOLICY_BUTTON_TITLE
    }
};

// Evaluate arguments for deployment with Node.js only
conf.autoStart = process.argv.includes('--auto-restart');

conf.localhostOnly = process.argv.includes('--localhost-only');


// Validate configuration
if (conf.ipv6Localize) {
    if (!(0 < conf.ipv6Localize && conf.ipv6Localize < 8)) {
        console.error("ipv6Localize must be an integer between 1 and 7");
        process.exit(1);
    }

    console.log("IPv6 client IPs will be localized to",
        conf.ipv6Localize,
        conf.ipv6Localize === 1 ? "segment" : "segments");
}

if (conf.signalingServer) {
    const isValidUrl = /[a-z|0-9|\-._~:\/?#\[\]@!$&'()*+,;=]+$/.test(conf.signalingServer);
    const containsProtocol = /:\/\//.test(conf.signalingServer)
    const endsWithSlash = /\/$/.test(conf.signalingServer)
    if (!isValidUrl || containsProtocol) {
        console.error("SIGNALING_SERVER must be a valid url without the protocol prefix.\n" +
            "Examples of valid values: `pairdrop.net`, `pairdrop.example.com:3000`, `example.com/pairdrop`");
        process.exit(1);
    }

    if (!endsWithSlash) {
        conf.signalingServer += "/";
    }

    if (process.env.RTC_CONFIG || conf.wsFallback || conf.ipv6Localize) {
        console.error("SIGNALING_SERVER cannot be used alongside WS_FALLBACK, RTC_CONFIG or IPV6_LOCALIZE as these " +
            "configurations are specified by the signaling server.\n" +
            "To use this instance as the signaling server do not set SIGNALING_SERVER");
        process.exit(1);
    }
}

// Logs for debugging
if (conf.debugMode) {
    console.log("DEBUG_MODE is active. To protect privacy, do not use in production.");
    console.debug("\n");
    console.debug("----DEBUG ENVIRONMENT VARIABLES----")
    // RTC_CONFIG contains credentials of TURN servers. Never log them.
    console.debug(JSON.stringify(redactConf(conf), null, 4));
    console.debug("\n");
}

// Start server to serve client files
const pairDropServer = new PairDropServer(conf);

if (!conf.signalingServer) {
    // Start websocket server if SIGNALING_SERVER is not set
    new PairDropWsServer(pairDropServer.server, conf);
} else {
    console.log("This instance does not include a signaling server. Clients on this instance connect to the following signaling server:", conf.signalingServer);
}

console.log('\nPairDrop is running on port', conf.port);

function parseTrustProxy(value) {
    if (value === undefined) {
        // Unset: keep the previous default (1 hop when rate limiting, else no trust)
        return undefined;
    }
    if (value === "true") return true;
    if (value === "false") return false;

    const parsed = parseInt(value);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;

    console.error(`TRUST_PROXY: "${value}" is not a valid value. Use true, false or a non-negative integer. Falling back to the default.`);
    return undefined;
}

function parseRtcConfig(path) {
    let content;
    try {
        content = fs.readFileSync(path, 'utf8');
    } catch (e) {
        console.error(`RTC_CONFIG: could not read file "${path}": ${e.message}`);
        process.exit(1);
    }

    let rtcConfig;
    try {
        rtcConfig = JSON.parse(content);
    } catch (e) {
        console.error(`RTC_CONFIG: file "${path}" does not contain valid JSON: ${e.message}`);
        process.exit(1);
    }

    if (!rtcConfig || !Array.isArray(rtcConfig.iceServers)) {
        console.error(`RTC_CONFIG: file "${path}" must contain an array of "iceServers".`);
        process.exit(1);
    }

    return rtcConfig;
}

function redactConf(conf) {
    const redacted = JSON.parse(JSON.stringify(conf));

    if (redacted.rtcConfig && Array.isArray(redacted.rtcConfig.iceServers)) {
        redacted.rtcConfig.iceServers = redacted.rtcConfig.iceServers.map(iceServer => {
            return {
                ...iceServer,
                credential: iceServer.credential ? "<redacted>" : undefined,
                username: iceServer.username ? "<redacted>" : undefined
            }
        });
    }

    return redacted;
}
