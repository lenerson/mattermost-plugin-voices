export const CallSessionState = Object.freeze({
    IDLE: 'idle',
    RINGING: 'ringing',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    ENDING: 'ending',
    FAILED: 'failed',
});

export default class CallSession {
    constructor() {
        this.state = CallSessionState.IDLE;
        this.callId = null;
        this.peerId = null;
        this.hubs = [];
        this.swarms = [];
        this.watches = [];
    }

    start(callId, peerId) {
        if (!callId || !peerId || this.state !== CallSessionState.IDLE) {
            return false;
        }
        this.callId = callId;
        this.peerId = peerId;
        this.state = CallSessionState.RINGING;
        return true;
    }

    transition(callId, state) {
        if (callId !== this.callId || this.state === CallSessionState.IDLE || this.state === CallSessionState.ENDING) {
            return false;
        }
        this.state = state;
        return true;
    }

    beginConnecting(callId) {
        return this.transition(callId, CallSessionState.CONNECTING);
    }

    markConnected(callId) {
        if (this.state !== CallSessionState.CONNECTING) {
            return false;
        }
        return this.transition(callId, CallSessionState.CONNECTED);
    }

    fail(callId) {
        return this.transition(callId, CallSessionState.FAILED);
    }

    trackHub(hub) {
        if (hub) {
            this.hubs.push(hub);
        }
        return hub;
    }

    trackSwarm(swarm, watch) {
        if (swarm) {
            this.swarms.push(swarm);
        }
        if (watch) {
            this.watches.push(watch);
        }
        return swarm;
    }

    end(callId = this.callId) {
        if (callId !== this.callId || this.state === CallSessionState.IDLE || this.state === CallSessionState.ENDING) {
            return false;
        }
        this.state = CallSessionState.ENDING;
        this.releaseResources();
        this.state = CallSessionState.IDLE;
        this.callId = null;
        this.peerId = null;
        return true;
    }

    releaseResources() {
        this.watches.splice(0).forEach((cancel) => {
            try {
                cancel();
            } catch (error) {
                // Cleanup is best effort; a failed peer must not retain the call.
            }
        });
        this.swarms.splice(0).forEach((swarm) => {
            try {
                swarm.close();
            } catch (error) {
                // Cleanup is best effort; a failed peer must not retain the call.
            }
        });
        this.hubs.splice(0).forEach((hub) => {
            try {
                hub.close();
            } catch (error) {
                // Cleanup is best effort; a failed hub must not retain the call.
            }
        });
    }
}
