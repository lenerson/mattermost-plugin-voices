import debug from './debug';

export const VOICE_SESSION_IDLE = 'idle';
export const VOICE_SESSION_ACTIVE = 'active';
export const VOICE_SESSION_CLOSING = 'closing';

function noop() {
    return undefined;
}

export default class VoiceSession {
    constructor({
        closeTimeoutMs,
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout,
        createHub,
        createSwarm,
        getUserMedia = (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    } = {}) {
        this.closeTimeoutMs = closeTimeoutMs || 2000;
        this.setTimeoutFn = setTimeoutFn;
        this.clearTimeoutFn = clearTimeoutFn;
        this.createHub = createHub;
        this.createSwarm = createSwarm;
        this.getUserMedia = getUserMedia;
        this.state = VOICE_SESSION_IDLE;
        this.roomId = null;
        this.stream = null;
        this.hub = null;
        this.swarm = null;
        this.peerTimers = new Set();
        this.peers = {};
        this.playbacks = {};
        this.onPeersChanged = noop;
        this.createAudio = () => document.createElement('audio');
        this.cleanupCallbacks = [];
    }

    start(roomId) {
        if (!roomId || this.state !== VOICE_SESSION_IDLE) {
            return false;
        }

        this.roomId = roomId;
        this.state = VOICE_SESSION_ACTIVE;
        return true;
    }

    isActive(roomId) {
        return this.state === VOICE_SESSION_ACTIVE && this.roomId === roomId;
    }

    setStream(roomId, stream) {
        if (!this.isActive(roomId)) {
            this.stopStream(stream);
            return false;
        }
        this.stream = stream;
        return true;
    }

    async acquireAudio(roomId) {
        const audio = {
            autoGainControl: true,
            sampleRate: {ideal: 48000, min: 35000},
            echoCancellation: true,
            channelCount: {ideal: 1},
            volume: 1,
        };
        try {
            const stream = await this.getUserMedia({audio});
            if (!this.setStream(roomId, stream)) {
                return {active: false, audioEnabled: false, videoEnabled: false};
            }
            return {active: true, audioEnabled: true, videoEnabled: false};
        } catch (error) {
            debug('Could not acquire voice media', error);
            return {active: this.isActive(roomId), audioEnabled: false, videoEnabled: false};
        }
    }

    setConnection(roomId, hub, swarm) {
        if (!this.isActive(roomId)) {
            this.closeConnection(hub, swarm);
            return false;
        }
        this.hub = hub;
        this.swarm = swarm;
        return true;
    }

    async connect({roomId, user, iceServers, onHubData, onPeer, onDisconnect, isCurrent = () => true}) {
        if (!this.isActive(roomId) || this.swarm || !this.createHub || !this.createSwarm) {
            return false;
        }

        let hub = null;
        try {
            hub = await this.createHub(`voice-${roomId}`, [], roomId);
            if (!this.isActive(roomId) || !isCurrent()) {
                this.closeHub(hub);
                return false;
            }

            hub.subscribe('all').on('data', onHubData);
            const swarm = this.createSwarm(hub, {
                config: {iceServers},
                uuid: user.id,
                wrap: (outgoingSignalingData) => ({
                    ...outgoingSignalingData,
                    fromUserId: user.id,
                    fromUsername: user.username,
                    fromDisplayName: user.displayName,
                }),
            });
            if (!this.setConnection(roomId, hub, swarm)) {
                return false;
            }
            swarm.on('peer', onPeer);
            swarm.on('disconnect', onDisconnect);
            hub.broadcast('all', {
                type: 'connect',
                from: user.id,
                fromUserId: user.id,
                fromUsername: user.username,
                fromDisplayName: user.displayName,
            });
            return true;
        } catch (error) {
            this.closeHub(hub);
            debug('Authorized voice session failed', error);
            return false;
        }
    }

    trackPeerTimer(timer) {
        this.peerTimers.add(timer);
        return timer;
    }

    untrackPeerTimer(timer) {
        this.peerTimers.delete(timer);
    }

    setPeerViewListener(listener) {
        this.onPeersChanged = typeof listener === 'function' ? listener : noop;
    }

    setAudioFactory(createAudio) {
        this.createAudio = typeof createAudio === 'function' ? createAudio : this.createAudio;
    }

    registerHubPeer(message) {
        if (this.peers[message.from]) {
            return false;
        }
        this.peers[message.from] = {
            userId: message.fromUserId,
            username: message.fromUsername,
            displayName: message.fromDisplayName,
            audioOn: true,
            videoOn: false,
            connected: false,
        };
        this.emitPeers();
        const timeout = this.trackPeerTimer(this.setTimeoutFn(() => {
            this.untrackPeerTimer(timeout);
            if (this.peers[message.from] && !this.peers[message.from].connected) {
                delete this.peers[message.from];
                this.emitPeers();
            }
        }, 20000));
        return true;
    }

    attachPeer(peer, id, userId, getLocalState, speakerOn) {
        const record = {...(this.peers[id] || {}), peer, audioOn: true, videoOn: false};
        this.peers[id] = record;
        this.emitPeers();

        peer.on('stream', (stream) => {
            record.stream = stream;
            const audio = this.createAudio();
            audio.srcObject = stream;
            audio.muted = !speakerOn();
            this.playbacks[id] = audio;
            audio.play();
        });
        peer.on('data', (payload) => {
            const data = parsePeerData(payload);
            if (!data) {
                return;
            }
            if (data.type === 'receivedHandshake') {
                if (this.stream) {
                    peer.addStream(this.stream);
                }
                const local = getLocalState();
                if (!local.audioOn || !local.audioEnabled) {
                    peer.send(JSON.stringify({type: 'audioToggle', enabled: false}));
                }
                if (!local.videoOn || !local.videoEnabled) {
                    peer.send(JSON.stringify({type: 'videoToggle', enabled: false}));
                }
            }
            if (data.type === 'sendHandshake') {
                record.userId = data.userId;
                record.connected = true;
                peer.send(JSON.stringify({type: 'receivedHandshake'}));
                this.emitPeers();
            }
            if (data.type === 'audioToggle' || data.type === 'videoToggle') {
                record[data.type === 'audioToggle' ? 'audioOn' : 'videoOn'] = data.enabled;
                this.emitPeers();
            }
        });
        peer.send(JSON.stringify({type: 'sendHandshake', userId}));
    }

    detachPeer(id) {
        delete this.peers[id];
        const audio = this.playbacks[id];
        if (audio) {
            try {
                audio.pause();
                audio.srcObject = null;
            } catch (error) {
                debug('voice peer playback cleanup failed', error);
            }
            delete this.playbacks[id];
        }
        this.emitPeers();
    }

    setMicrophoneEnabled(enabled) {
        if (this.stream) {
            const tracks = this.stream.getAudioTracks();
            if (tracks[0]) {
                tracks[0].enabled = enabled;
            }
        }
        Object.values(this.peers).forEach((record) => {
            if (record.connected && record.peer) {
                record.peer.send(JSON.stringify({type: 'audioToggle', enabled}));
            }
        });
    }

    setSpeakerEnabled(enabled) {
        Object.values(this.playbacks).forEach((audio) => {
            audio.muted = !enabled;
        });
    }

    emitPeers() {
        const views = {};
        Object.keys(this.peers).forEach((id) => {
            const view = {...this.peers[id]};
            delete view.peer;
            delete view.stream;
            views[id] = view;
        });
        this.onPeersChanged(views);
    }

    close(done) {
        const onFinished = typeof done === 'function' ? done : noop;
        if (this.state === VOICE_SESSION_CLOSING) {
            this.cleanupCallbacks.push(onFinished);
            return;
        }

        this.state = VOICE_SESSION_CLOSING;
        this.cleanupCallbacks = [onFinished];
        this.peerTimers.forEach((timer) => this.clearTimeoutFn(timer));
        this.peerTimers.clear();
        Object.values(this.playbacks).forEach((audio) => {
            try {
                audio.pause();
                audio.srcObject = null;
            } catch (error) {
                debug('voice playback cleanup failed', error);
            }
        });
        this.playbacks = {};
        this.peers = {};
        this.emitPeers();
        this.stopStream(this.stream);
        this.stream = null;

        const hub = this.hub;
        const swarm = this.swarm;
        this.hub = null;
        this.swarm = null;
        this.roomId = null;

        let completed = false;
        let timeout = null;
        const finish = () => {
            if (completed) {
                return;
            }
            completed = true;
            if (timeout) {
                this.clearTimeoutFn(timeout);
            }
            this.closeHub(hub);
            this.state = VOICE_SESSION_IDLE;
            const callbacks = this.cleanupCallbacks;
            this.cleanupCallbacks = [];
            callbacks.forEach((callback) => {
                try {
                    callback();
                } catch (error) {
                    debug('voice cleanup callback failed', error);
                }
            });
        };

        if (!swarm || typeof swarm.close !== 'function') {
            finish();
            return;
        }

        timeout = this.setTimeoutFn(finish, this.closeTimeoutMs);
        try {
            swarm.close(finish);
        } catch (error) {
            debug('voice swarm close failed; continuing cleanup', error);
            finish();
        }
    }

    stopStream(stream) {
        if (!stream || typeof stream.getTracks !== 'function') {
            return;
        }
        stream.getTracks().forEach((track) => track.stop());
    }

    closeHub(hub) {
        if (!hub || typeof hub.close !== 'function') {
            return;
        }
        try {
            hub.close();
        } catch (error) {
            debug('voice hub close failed; continuing cleanup', error);
        }
    }

    closeConnection(hub, swarm) {
        this.closeHub(hub);
        if (swarm && typeof swarm.close === 'function') {
            try {
                swarm.close(noop);
            } catch (error) {
                debug('inactive voice swarm close failed', error);
            }
        }
    }
}

function parsePeerData(payload) {
    try {
        const data = JSON.parse(payload.toString());
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            return null;
        }
        if (data.type === 'receivedHandshake') {
            return data;
        }
        if (data.type === 'sendHandshake' && typeof data.userId === 'string' && data.userId) {
            return data;
        }
        if ((data.type === 'audioToggle' || data.type === 'videoToggle') && typeof data.enabled === 'boolean') {
            return data;
        }
    } catch (error) {
        debug('Ignoring invalid voice peer payload', error);
    }
    return null;
}
