import debug from './debug';

export const VOICE_SESSION_IDLE = 'idle';
export const VOICE_SESSION_ACTIVE = 'active';
export const VOICE_SESSION_CLOSING = 'closing';

export default class VoiceSession {
    constructor({closeTimeoutMs, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout} = {}) {
        this.closeTimeoutMs = closeTimeoutMs || 2000;
        this.setTimeoutFn = setTimeoutFn;
        this.clearTimeoutFn = clearTimeoutFn;
        this.state = VOICE_SESSION_IDLE;
        this.roomId = null;
        this.stream = null;
        this.hub = null;
        this.swarm = null;
        this.peerTimers = new Set();
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

    setConnection(roomId, hub, swarm) {
        if (!this.isActive(roomId)) {
            this.closeConnection(hub, swarm);
            return false;
        }
        this.hub = hub;
        this.swarm = swarm;
        return true;
    }

    trackPeerTimer(timer) {
        this.peerTimers.add(timer);
        return timer;
    }

    untrackPeerTimer(timer) {
        this.peerTimers.delete(timer);
    }

    close(done) {
        const onFinished = typeof done === 'function' ? done : () => {};
        if (this.state === VOICE_SESSION_CLOSING) {
            this.cleanupCallbacks.push(onFinished);
            return;
        }

        this.state = VOICE_SESSION_CLOSING;
        this.cleanupCallbacks = [onFinished];
        this.peerTimers.forEach((timer) => this.clearTimeoutFn(timer));
        this.peerTimers.clear();
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
                swarm.close(() => {});
            } catch (error) {
                debug('inactive voice swarm close failed', error);
            }
        }
    }
}
