/**
 * webrtc-swarm reports peers that connected and says nothing at all when ICE
 * fails, so a call that cannot traverse NAT looks exactly like one that is still
 * trying — the modal just sits there forever. Time it out and say so.
 *
 * The usual cause is no TURN server: STUN alone only works when at least one
 * side is directly reachable, which is rarely true for two people on different
 * networks.
 */
import debug from './debug';

export const PEER_CONNECT_TIMEOUT_MS = 20000;

function hasTurnServer(iceServers) {
    return (iceServers || []).some((entry) => {
        const urls = entry && entry.urls;
        const list = Array.isArray(urls) ? urls : [urls];
        return list.some((url) => String(url || '').trim().toLowerCase().startsWith('turn'));
    });
}

/**
 * Watches a swarm for its first peer. Returns a cancel function that must be
 * called when the call ends, so the timer does not outlive it.
 */
export function watchPeerConnection(sw, label, iceServers) {
    let connected = false;

    sw.on('peer', (peer, id) => {
        connected = true;
        debug(`[webrtc] ${label}: peer connected`, id);

        peer.on('error', (err) => {
            debug(`[webrtc] ${label}: peer error`, err);
        });
    });

    const timer = setTimeout(() => {
        if (connected) {
            return;
        }

        let advice = 'No TURN server is configured — with STUN only, two peers behind NAT cannot reach each other. Set one in System Console → Plugins → WebRTC Video.';
        if (hasTurnServer(iceServers)) {
            advice = 'A TURN server is configured, so check its address and credentials.';
        }

        // Never include the ICE configuration here: TURN entries may contain
        // credentials. The diagnosis only needs to say whether TURN exists.
        debug(`[webrtc] ${label}: no peer connected after ${PEER_CONNECT_TIMEOUT_MS}ms. ${advice}`, {
            turnConfigured: hasTurnServer(iceServers),
        });
    }, PEER_CONNECT_TIMEOUT_MS);

    return () => clearTimeout(timer);
}
