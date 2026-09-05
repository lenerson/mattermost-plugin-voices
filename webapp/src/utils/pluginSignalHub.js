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

function createSubscribeStream(topic) {
    const url = `/plugins/${pluginId}/v1/signal/stream?topic=${encodeURIComponent(topic)}`;
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
            if (!opened) {
                fireOpen();
            }
            stream.push(data);
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
        debug(`[signal] stream interrupted on ${topic}; EventSource will retry`);
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
