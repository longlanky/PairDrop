import express from "express";
import RateLimit from "express-rate-limit";
import helmet from "helmet";
import compression from "compression";
import {fileURLToPath} from "url";
import path, {dirname} from "path";
import http from "http";

export default class PairDropServer {

    constructor(conf) {
        const app = express();

        app.disable('x-powered-by');

        // Security headers. HSTS and `upgrade-insecure-requests` are deliberately not set:
        // many instances are self-hosted via plain http on a local network. Both should be
        // configured on the reverse proxy for instances that are served via https.
        app.use(helmet({
            hsts: false,
            contentSecurityPolicy: {
                useDefaults: false,
                directives: {
                    defaultSrc: ["'self'"],
                    scriptSrc: ["'self'"],
                    // zip.js and heic2any spawn workers from `blob:` urls
                    workerSrc: ["'self'", "blob:"],
                    fontSrc: ["'self'", "data:"],
                    // `blob:`/`data:` are required for previews and received files
                    imgSrc: ["'self'", "data:", "blob:"],
                    mediaSrc: ["'self'", "blob:"],
                    // inline `style` attributes are used by index.html and the icon sprites
                    styleSrc: ["'self'", "'unsafe-inline'"],
                    // WebRTC/STUN/TURN and a possibly external signaling server need
                    // to be reachable, therefore `connect-src` cannot be limited to 'self'
                    connectSrc: ["'self'", "ws:", "wss:", "http:", "https:"],
                    objectSrc: ["'none'"],
                    baseUri: ["'self'"],
                    formAction: ["'self'"],
                    frameAncestors: ["'self'"],
                }
            }
        }));

        app.use(compression());

        // ensure correct client ip and not the ip of the reverse proxy is used
        // see https://express-rate-limit.mintlify.app/guides/troubleshooting-proxy-issues
        // `TRUST_PROXY` unset: default to 1 hop when rate limiting is active, else no trust
        const trustProxy = conf.trustProxy !== undefined
            ? conf.trustProxy
            : (conf.rateLimit ? 1 : false);
        app.set('trust proxy', trustProxy);

        if (conf.rateLimit) {
            const limiter = RateLimit({
                windowMs: conf.rateLimitWindowMs || 5 * 60 * 1000, // 5 minutes by default
                max: conf.rateLimitMax || 1000, // Limit each IP to 1000 requests per `window` by default
                message: 'Too many requests from this IP Address, please try again after 5 minutes.',
                standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
                legacyHeaders: false, // Disable the `X-RateLimit-*` headers
            })

            app.use(limiter);

            if (!conf.debugMode) {
                console.log("Use DEBUG_MODE=true to find correct number of RATE_LIMIT.");
            }
        }

        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);

        const publicPathAbs = path.join(__dirname, '../public');
        app.use(express.static(publicPathAbs));

        if (conf.debugMode && conf.rateLimit) {
            console.debug("\n");
            console.debug("----DEBUG RATE_LIMIT----")
            console.debug("To find out the correct value for RATE_LIMIT go to '/ip' and ensure the returned IP-address is the IP-address of your client.")
            console.debug("See https://github.com/express-rate-limit/express-rate-limit#troubleshooting-proxy-issues for more info")
            app.get('/ip', (req, res) => {
                res.send(req.ip);
            })
        }

        // By default, clients connecting to your instance use the signaling server of your instance to connect to other devices.
        // By using `WS_SERVER`, you can host an instance that uses another signaling server.
        app.get('/config', (req, res) => {
            res.send({
                signalingServer: conf.signalingServer,
                buttons: conf.buttons
            });
        });

        // Unauthenticated health check used by container orchestrators and reverse proxies
        app.get('/healthz', (req, res) => {
            res.status(200).send('ok');
        });

        app.get('/', (req, res) => {
            res.sendFile(path.join(publicPathAbs, 'index.html'));
        });

        console.log(`Serving client files from:\n${publicPathAbs}`)

        // Unknown paths are redirected to the client. Must be registered last.
        app.use((req, res) => {
            res.redirect(301, '/');
        });

        const hostname = conf.localhostOnly ? '127.0.0.1' : null;
        const server = http.createServer(app);

        server.listen(conf.port, hostname);

        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.error(err);
                console.info("Error EADDRINUSE received, exiting process without restarting process...");
                process.exit(1)
            }
        });

        this.server = server
    }
}
