/**
 * Hub compatible with webrtc-swarm / signalhub: subscribe(channel) returns a Readable stream
 * with .pipe(), .on('open'), .once('open'); broadcast(channel, message, cb); close(cb).
 * Uses plugin POST /v1/signal/publish and GET /v1/signal/stream (SSE).
 */
import axios from 'axios';
import {Readable} from 'stream';

import {id as pluginId} from 'manifest';

import debug from './debug';

/**
 * Mattermost sets Mattermost-User-Id on plugin requests only after CSRF passes for cookie auth POSTs.
 * Match mattermost-redux Client4#getOptions (MMCSRF cookie + X-Requested-With).
 */
function getCsrfTokenFromCookie() {
    if (typeof document === 'undefined' || !document.cookie) {
        return '';
    }
    const parts = document.cookie.split(';');
    for (let i = 0; i < parts.length; i++) {
        const p = parts[i].trim();
        if (p.startsWith('MMCSRF=')) {
            return p.slice('MMCSRF='.length);
        }
    }
    return '';
}

function pluginCookieAuthHeaders() {
    const headers = {
        'X-Requested-With': 'XMLHttpRequest',
    };
    const csrf = getCsrfTokenFromCookie();
    if (csrf) {
        headers['X-CSRF-Token'] = csrf;
    }
    return headers;
}

function noop() {
    /* default callback */
}

function createSubscribeStream(topic, sessionId = '') {
    const query = sessionId ? `sessionId=${encodeURIComponent(sessionId)}` : `topic=${encodeURIComponent(topic)}`;
    const url = `/plugins/${pluginId}/v1/signal/stream?${query}`;
    const es = new EventSource(url);

    const stream = new Readable({
        objectMode: true,
        read() {
            /* Push-driven from EventSource; nothing to pull here. */
        },
    });

    let opened = false;
    const fireOpen = () => {
        if (!opened) {
            opened = true;
            stream.emit('open');
        }
    };

    es.onopen = () => {
        fireOpen();
    };

    es.onmessage = (ev) => {
        try {
            const data = JSON.parse(ev.data);
            let message = data;
            if (sessionId) {
                if (data.version !== 1 || !data.senderId || !data.payload) {
                    throw new Error('Invalid authorized signal envelope');
                }
                message = data.payload;
                if (message && typeof message === 'object' && !Array.isArray(message)) {
                    // The outer envelope is authenticated by the server. Do
                    // not let a WebRTC payload impersonate another peer.
                    message = Object.assign({}, message, {fromUserId: data.senderId});
                }
            }
            if (!opened) {
                fireOpen();
            }
            stream.push(message);
        } catch (e) {
            stream.destroy(e);
        }
    };

    es.onerror = () => {
        /*
         * Do NOT end the stream here. EventSource reconnects on its own, but a
         * Readable that has been pushed null is finished for good — so the first
         * proxy timeout on an idle topic used to detach every data handler for
         * the rest of the session, silently. That is how an incoming call could
         * stop being announced after the tab had been sitting there a while.
         */
        fireOpen();
        debug(`[signal] stream interrupted on ${sessionId || topic}; EventSource will retry`);
    };

    const origDestroy = stream.destroy.bind(stream);
    stream.destroy = (err) => {
        es.close();
        return origDestroy(err);
    };

    setTimeout(fireOpen, 0);

    return stream;
}

export default function pluginSignalHub(appName) {
    const streams = [];

    const hub = {
        app: appName,

        subscribe(channel) {
            const topic = `${appName}/${channel}`;
            const s = createSubscribeStream(topic);
            streams.push(s);
            return s;
        },

        broadcast(channel, message, cb) {
            const topic = `${appName}/${channel}`;
            const done = typeof cb === 'function' ? cb : noop;
            axios.post(`/plugins/${pluginId}/v1/signal/publish`, {
                topic,
                payload: message,
            }, {
                headers: pluginCookieAuthHeaders(),
                withCredentials: true,
            }).then(() => done()).catch((err) => done(err));
        },

        close(cb) {
            streams.forEach((s) => {
                try {
                    s.destroy();
                } catch (e) {
                    // ignore
                }
            });
            streams.length = 0;
            const fn = typeof cb === 'function' ? cb : noop;
            setTimeout(fn, 0);
        },
    };

    return hub;
}

/**
 * Creates a hub backed by a server-authorized signal session. Its public
 * surface matches pluginSignalHub so webrtc-swarm can migrate without knowing
 * whether the transport uses a legacy topic or an authorized session.
 */
export async function createAuthorizedSignalHub(callId, participants) {
    const response = await axios.post(`/plugins/${pluginId}/v1/signal/sessions`, {
        callId,
        participants,
    }, {
        headers: pluginCookieAuthHeaders(),
        withCredentials: true,
    });

    const session = response.data || {};
    if (session.version !== 1 || !session.sessionId || session.callId !== callId) {
        throw new Error('Invalid authorized signal session response');
    }

    return authorizedSignalHub(session);
}

export function authorizedSignalHub(session) {
    const streams = [];

    const hub = {
        app: `signal-session-${session.sessionId}`,

        subscribe() {
            const stream = createSubscribeStream('', session.sessionId);
            streams.push(stream);
            return stream;
        },

        broadcast(_channel, message, cb) {
            const done = typeof cb === 'function' ? cb : noop;
            axios.post(`/plugins/${pluginId}/v1/signal/publish`, {
                version: session.version,
                sessionId: session.sessionId,
                callId: session.callId,
                type: 'webrtc',
                payload: message,
            }, {
                headers: pluginCookieAuthHeaders(),
                withCredentials: true,
            }).then(() => done()).catch((err) => done(err));
        },

        close(cb) {
            streams.forEach((stream) => {
                try {
                    stream.destroy();
                } catch (e) {
                    // ignore
                }
            });
            streams.length = 0;
            const fn = typeof cb === 'function' ? cb : noop;
            setTimeout(fn, 0);
        },
    };

    return hub;
}
