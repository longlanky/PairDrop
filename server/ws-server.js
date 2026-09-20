import {WebSocket, WebSocketServer} from "ws";
import crypto from "crypto"

import Peer from "./peer.js";
import {hasher, randomizer} from "./helper.js";

const PING_INTERVAL_MS = 30000; // how often a peer is pinged
const PING_TIMEOUT_MS = 90000; // disconnect a peer that did not respond for this long
const MAX_BUFFERED_AMOUNT = 16 * 1024 * 1024; // terminate peers that do not read fast enough
const MAX_PAYLOAD = 1024 * 1024; // ws-fallback chunks are 64 KB; larger messages are never valid
const MAX_ROOM_SECRETS_PER_MESSAGE = 100; // legit clients hold a handful of secrets
const MAX_ROOM_SECRETS_PER_PEER = 300; // hard cap of secret rooms a single peer may join

export default class PairDropWsServer {

    constructor(server, conf) {
        this._conf = conf

        // Prototype-less objects: room ids and pair keys are client controlled.
        // Using `{}` allows keys like `__proto__` or `constructor` to resolve to
        // inherited properties (prototype pollution).
        this._rooms = Object.create(null); // { roomId: peers[] }

        this._roomSecrets = Object.create(null); // { pairKey: roomSecret }

        this._wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });
        // without a listener an `error` event would throw and take the process down
        this._wss.on('error', e => console.error("WS: Websocket server error", e));
        this._wss.on('connection', (socket, request) => this._onConnection(new Peer(socket, request, conf)));
    }

    _onConnection(peer) {
        peer.socket.on('message', message => this._onMessage(peer, message));
        peer.socket.onerror = e => console.error(e);
        // a peer that closes its socket (tab closed, network drop) must leave all rooms immediately
        peer.socket.on('close', () => this._disconnect(peer));

        this._keepAlive(peer);

        this._send(peer, {
            type: 'ws-config',
            wsConfig: {
                rtcConfig: this._conf.rtcConfig,
                wsFallback: this._conf.wsFallback
            }
        });

        // send displayName
        this._send(peer, {
            type: 'display-name',
            displayName: peer.name.displayName,
            deviceName: peer.name.deviceName,
            peerId: peer.id,
            peerIdHash: hasher.hashCodeSalted(peer.id)
        });
    }

    _onMessage(sender, message) {
        // Try to parse message
        try {
            message = JSON.parse(message);
        } catch (e) {
            console.warn("WS: Received JSON is malformed");
            return;
        }

        if (!message || typeof message.type !== 'string') return;

        // A malformed but syntactically valid message must never take down the server
        try {
            this._handleMessage(sender, message);
        } catch (e) {
            console.error("WS: Error while handling message", message.type, e);
        }
    }

    _handleMessage(sender, message) {
        switch (message.type) {
            case 'disconnect':
                this._onDisconnect(sender);
                break;
            case 'pong':
                this._setKeepAliveTimerToNow(sender);
                break;
            case 'join-ip-room':
                this._joinIpRoom(sender);
                break;
            case 'room-secrets':
                this._onRoomSecrets(sender, message);
                break;
            case 'room-secrets-deleted':
                this._onRoomSecretsDeleted(sender, message);
                break;
            case 'pair-device-initiate':
                this._onPairDeviceInitiate(sender);
                break;
            case 'pair-device-join':
                this._onPairDeviceJoin(sender, message);
                break;
            case 'pair-device-cancel':
                this._onPairDeviceCancel(sender);
                break;
            case 'regenerate-room-secret':
                this._onRegenerateRoomSecret(sender, message);
                break;
            case 'create-public-room':
                this._onCreatePublicRoom(sender);
                break;
            case 'join-public-room':
                this._onJoinPublicRoom(sender, message);
                break;
            case 'leave-public-room':
                this._onLeavePublicRoom(sender);
                break;
            case 'signal':
                this._signalAndRelay(sender, message);
                break;
            case 'request':
            case 'header':
            case 'partition':
            case 'partition-received':
            case 'progress':
            case 'files-transfer-response':
            case 'file-transfer-complete':
            case 'message-transfer-complete':
            case 'text':
            case 'display-name-changed':
            case 'ws-chunk':
                // relay ws-fallback
                if (this._conf.wsFallback) {
                    this._signalAndRelay(sender, message);
                }
                else {
                    console.log("Websocket fallback is not activated on this instance.")
                }
        }
    }

    _signalAndRelay(sender, message) {
        const room = message.roomType === 'ip'
            ? sender.ip
            : message.roomId;

        if (!this._isValidRoomId(message.roomType, room)) return;

        // relay message to recipient
        if (message.to && Peer.isValidUuid(message.to) && this._rooms[room]) {
            const recipient = this._rooms[room][message.to];
            if (!recipient) return;
            delete message.to;
            // add sender
            message.sender = {
                id: sender.id,
                rtcSupported: sender.rtcSupported
            };
            this._send(recipient, message);
        }
    }

    _onDisconnect(sender) {
        this._disconnect(sender);
    }

    _disconnect(sender) {
        if (sender.disconnected) return;
        sender.disconnected = true;

        this._removePairKey(sender.pairKey);
        sender.pairKey = null;

        this._cancelKeepAlive(sender);

        this._leaveIpRoom(sender, true);
        this._leaveAllSecretRooms(sender, true);
        this._leavePublicRoom(sender, true);

        sender.socket.terminate();
    }

    _onRoomSecrets(sender, message) {
        if (!Array.isArray(message.roomSecrets)) return;

        const roomSecrets = this._capRoomSecrets(sender, message.roomSecrets)
            .filter(roomSecret => {
                return this._isValidRoomSecret(roomSecret);
            })

        this._joinSecretRooms(sender, roomSecrets);
    }

    _onRoomSecretsDeleted(sender, message) {
        if (!Array.isArray(message.roomSecrets)) return;

        const roomSecrets = this._capRoomSecrets(sender, message.roomSecrets);
        for (let i = 0; i<roomSecrets.length; i++) {
            this._deleteSecretRoom(roomSecrets[i]);
        }
    }

    // Unbounded arrays would allow a single message to create thousands of rooms
    // and to block the event loop in the O(n^2) `addRoomSecret` deduplication
    _capRoomSecrets(sender, roomSecrets) {
        if (roomSecrets.length <= MAX_ROOM_SECRETS_PER_MESSAGE) return roomSecrets;

        console.warn("WS: Peer sent more than", MAX_ROOM_SECRETS_PER_MESSAGE, "room secrets. Ignoring the excess. Peer:", sender.id);
        return roomSecrets.slice(0, MAX_ROOM_SECRETS_PER_MESSAGE);
    }

    _deleteSecretRoom(roomSecret) {
        if (!this._isValidRoomSecret(roomSecret)) return;

        const room = this._rooms[roomSecret];
        if (!room) return;

        for (const peerId in room) {
            const peer = room[peerId];

            this._leaveSecretRoom(peer, roomSecret, true);

            this._send(peer, {
                type: 'secret-room-deleted',
                roomSecret: roomSecret,
            });
        }
    }

    _onPairDeviceInitiate(sender) {
        let roomSecret = randomizer.getRandomString(256);
        let pairKey = this._createPairKey(sender, roomSecret);

        if (sender.pairKey) {
            this._removePairKey(sender.pairKey);
        }
        sender.pairKey = pairKey;

        this._send(sender, {
            type: 'pair-device-initiated',
            roomSecret: roomSecret,
            pairKey: pairKey
        });
        this._joinSecretRoom(sender, roomSecret);
    }

    _onPairDeviceJoin(sender, message) {
        if (!this._isValidPairKey(message.pairKey)) {
            this._send(sender, { type: 'pair-device-join-key-invalid' });
            return;
        }

        if (sender.rateLimitReached()) {
            this._send(sender, { type: 'join-key-rate-limit' });
            return;
        }

        const roomSecretEntry = Object.hasOwn(this._roomSecrets, message.pairKey)
            ? this._roomSecrets[message.pairKey]
            : undefined;

        if (!roomSecretEntry || !roomSecretEntry.creator || sender.id === roomSecretEntry.creator.id) {
            this._send(sender, { type: 'pair-device-join-key-invalid' });
            return;
        }

        const roomSecret = roomSecretEntry.roomSecret;
        const creator = roomSecretEntry.creator;
        this._removePairKey(message.pairKey);
        this._send(sender, {
            type: 'pair-device-joined',
            roomSecret: roomSecret,
            peerId: creator.id
        });
        this._send(creator, {
            type: 'pair-device-joined',
            roomSecret: roomSecret,
            peerId: sender.id
        });
        this._joinSecretRoom(sender, roomSecret);
        this._removePairKey(sender.pairKey);
    }

    _onPairDeviceCancel(sender) {
        const pairKey = sender.pairKey

        if (!pairKey) return;

        this._removePairKey(pairKey);
        this._send(sender, {
            type: 'pair-device-canceled',
            pairKey: pairKey,
        });
    }

    _onCreatePublicRoom(sender) {
        let publicRoomId = randomizer.getRandomString(5, true).toLowerCase();

        this._send(sender, {
            type: 'public-room-created',
            roomId: publicRoomId
        });

        this._joinPublicRoom(sender, publicRoomId);
    }

    _onJoinPublicRoom(sender, message) {
        if (!this._isValidPublicRoomId(message.publicRoomId)) {
            this._send(sender, { type: 'public-room-id-invalid', publicRoomId: message.publicRoomId });
            return;
        }

        if (sender.rateLimitReached()) {
            this._send(sender, { type: 'join-key-rate-limit' });
            return;
        }

        if (!this._rooms[message.publicRoomId] && !message.createIfInvalid) {
            this._send(sender, { type: 'public-room-id-invalid', publicRoomId: message.publicRoomId });
            return;
        }

        this._leavePublicRoom(sender);
        this._joinPublicRoom(sender, message.publicRoomId);
    }

    _onLeavePublicRoom(sender) {
        this._leavePublicRoom(sender, true);
        this._send(sender, { type: 'public-room-left' });
    }

    _onRegenerateRoomSecret(sender, message) {
        const oldRoomSecret = message.roomSecret;

        if (!this._isValidRoomSecret(oldRoomSecret)) return;

        const oldRoom = this._rooms[oldRoomSecret];
        if (!oldRoom) return;

        const newRoomSecret = randomizer.getRandomString(256);

        // notify all other peers
        for (const peerId in oldRoom) {
            const peer = oldRoom[peerId];
            this._send(peer, {
                type: 'room-secret-regenerated',
                oldRoomSecret: oldRoomSecret,
                newRoomSecret: newRoomSecret,
            });
            peer.removeRoomSecret(oldRoomSecret);
        }
        delete this._rooms[oldRoomSecret];
    }

    _createPairKey(creator, roomSecret) {
        let pairKey;
        do {
            // get randomInt until keyRoom not occupied
            pairKey = crypto.randomInt(1000000, 1999999).toString().substring(1); // include numbers with leading 0s
        } while (pairKey in this._roomSecrets)

        this._roomSecrets[pairKey] = {
            roomSecret: roomSecret,
            creator: creator
        }

        return pairKey;
    }

    _removePairKey(pairKey) {
        if (!pairKey || !Object.hasOwn(this._roomSecrets, pairKey)) return;

        const entry = this._roomSecrets[pairKey];
        if (entry.creator) entry.creator.pairKey = null;
        delete this._roomSecrets[pairKey];
    }

    _joinIpRoom(peer) {
        this._joinRoom(peer, 'ip', peer.ip);
    }

    _joinSecretRoom(peer, roomSecret) {
        this._joinRoom(peer, 'secret', roomSecret);

        // add secret to peer
        peer.addRoomSecret(roomSecret);
    }

    _joinPublicRoom(peer, publicRoomId) {
        // prevent joining of 2 public rooms simultaneously
        this._leavePublicRoom(peer);

        this._joinRoom(peer, 'public-id', publicRoomId);

        peer.publicRoomId = publicRoomId;
    }

    _joinRoom(peer, roomType, roomId) {
        // roomType: 'ip', 'secret' or 'public-id'
        if (!this._isValidRoomId(roomType, roomId)) return;

        if (this._rooms[roomId] && this._rooms[roomId][peer.id]) {
            // ensures that otherPeers never receive `peer-left` after `peer-joined` on reconnect.
            this._leaveRoom(peer, roomType, roomId);
        }

        // if room doesn't exist, create it
        if (!this._rooms[roomId]) {
            this._rooms[roomId] = {};
        }

        this._notifyPeers(peer, roomType, roomId);

        // add peer to room
        this._rooms[roomId][peer.id] = peer;
    }


    _leaveIpRoom(peer, disconnect = false) {
        this._leaveRoom(peer, 'ip', peer.ip, disconnect);
    }

    _leaveSecretRoom(peer, roomSecret, disconnect = false) {
        this._leaveRoom(peer, 'secret', roomSecret, disconnect)

        //remove secret from peer
        peer.removeRoomSecret(roomSecret);
    }

    _leavePublicRoom(peer, disconnect = false) {
        if (!peer.publicRoomId) return;

        this._leaveRoom(peer, 'public-id', peer.publicRoomId, disconnect);

        peer.publicRoomId = null;
    }

    _leaveRoom(peer, roomType, roomId, disconnect = false) {
        if (!this._isValidRoomId(roomType, roomId)) return;
        if (!this._rooms[roomId] || !this._rooms[roomId][peer.id]) return;

        // remove peer from room
        delete this._rooms[roomId][peer.id];

        // delete room if empty and abort
        if (!Object.keys(this._rooms[roomId]).length) {
            delete this._rooms[roomId];
            return;
        }

        // notify all other peers that remain in room that peer left
        for (const otherPeerId in this._rooms[roomId]) {
            const otherPeer = this._rooms[roomId][otherPeerId];

            let msg = {
                type: 'peer-left',
                peerId: peer.id,
                roomType: roomType,
                roomId: roomId,
                disconnect: disconnect
            };

            this._send(otherPeer, msg);
        }
    }

    _notifyPeers(peer, roomType, roomId) {
        if (!this._rooms[roomId]) return;

        // notify all other peers that peer joined
        for (const otherPeerId in this._rooms[roomId]) {
            if (otherPeerId === peer.id) continue;
            const otherPeer = this._rooms[roomId][otherPeerId];

            let msg = {
                type: 'peer-joined',
                peer: peer.getInfo(),
                roomType: roomType,
                roomId: roomId
            };

            this._send(otherPeer, msg);
        }

        // notify peer about peers already in the room
        const otherPeers = [];
        for (const otherPeerId in this._rooms[roomId]) {
            if (otherPeerId === peer.id) continue;
            otherPeers.push(this._rooms[roomId][otherPeerId].getInfo());
        }

        let msg = {
            type: 'peers',
            peers: otherPeers,
            roomType: roomType,
            roomId: roomId
        };

        this._send(peer, msg);
    }

    _joinSecretRooms(peer, roomSecrets) {
        for (let i=0; i<roomSecrets.length; i++) {
            if (peer.roomSecrets.length >= MAX_ROOM_SECRETS_PER_PEER) {
                console.warn("WS: Peer exceeded the maximum number of secret rooms. Ignoring the excess. Peer:", peer.id);
                return;
            }
            this._joinSecretRoom(peer, roomSecrets[i])
        }
    }

    _leaveAllSecretRooms(peer, disconnect = false) {
        // iterate a copy as `_leaveSecretRoom` mutates `peer.roomSecrets`
        const roomSecrets = peer.roomSecrets.slice();
        for (let i=0; i<roomSecrets.length; i++) {
            this._leaveSecretRoom(peer, roomSecrets[i], disconnect);
        }
    }

    _send(peer, message) {
        if (!peer || !peer.socket) return;
        if (peer.socket.readyState !== WebSocket.OPEN) return;

        // prevent unbounded memory growth if a peer does not read its socket
        if (peer.socket.bufferedAmount > MAX_BUFFERED_AMOUNT) {
            console.warn("WS: Peer does not read its socket. Disconnecting peer", peer.id);
            this._disconnect(peer);
            return;
        }

        try {
            peer.socket.send(JSON.stringify(message));
        } catch (e) {
            console.error("WS: Could not send message to peer", peer.id, e);
        }
    }

    _keepAlive(peer) {
        if (peer.disconnected) return;

        this._cancelKeepAlive(peer);

        // keep alive state is stored per peer instance (not per peer id) so that
        // reconnecting peers cannot cancel the timer of a previous session
        if (!peer.keepAlive) {
            peer.keepAlive = {
                timer: 0,
                lastBeat: Date.now()
            };
        }

        if (Date.now() - peer.keepAlive.lastBeat > PING_TIMEOUT_MS) {
            // Disconnect peer if it did not respond to the last pings
            this._disconnect(peer);
            return;
        }

        this._send(peer, { type: 'ping' });

        peer.keepAlive.timer = setTimeout(() => this._keepAlive(peer), PING_INTERVAL_MS);
    }

    _cancelKeepAlive(peer) {
        if (peer.keepAlive?.timer) {
            clearTimeout(peer.keepAlive.timer);
            peer.keepAlive.timer = 0;
        }
    }

    _setKeepAliveTimerToNow(peer) {
        if (!peer.keepAlive) {
            peer.keepAlive = {
                timer: 0,
                lastBeat: Date.now()
            };
            return;
        }
        peer.keepAlive.lastBeat = Date.now();
    }

    _isValidRoomSecret(roomSecret) {
        return typeof roomSecret === 'string' && /^[\x00-\x7F]{64,256}$/.test(roomSecret);
    }

    _isValidPublicRoomId(publicRoomId) {
        return typeof publicRoomId === 'string' && /^[a-z]{5}$/.test(publicRoomId);
    }

    _isValidPairKey(pairKey) {
        return typeof pairKey === 'string' && /^[0-9]{6}$/.test(pairKey);
    }

    _isValidRoomId(roomType, roomId) {
        if (roomType === 'secret') return this._isValidRoomSecret(roomId);
        if (roomType === 'public-id') return this._isValidPublicRoomId(roomId);
        return typeof roomId === 'string' && roomId.length > 0 && roomId.length <= 256;
    }
}

