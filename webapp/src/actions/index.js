/* eslint-disable no-magic-numbers */
/* eslint-disable max-nested-callbacks */
/* eslint-disable no-shadow */
/* eslint-disable no-unused-vars */
import axios from 'axios';
import swarm from 'webrtc-swarm';

import {getConfig} from 'mattermost-redux/selectors/entities/general';
import {getCurrentUser, getUser} from 'mattermost-redux/selectors/entities/users';

import {id as pluginId} from 'manifest';

import ActionTypes from '../action_types';

import debug from '../utils/debug';
import {buildIceServers} from '../utils/iceServers';
import pluginSignalHub from '../utils/pluginSignalHub';
import {getDirectChannelIdForPeer, ensureDirectChannelId} from '../utils/dmChannel';
import {createVideoInvitePost, sendCallDeclinedEphemeral, newCallId} from '../utils/callInvitePosts';
import {startIncomingRing, startOutgoingRingback, stopIncomingRing, stopOutgoingRingback} from '../utils/callRing';
import {notifyIncomingCall} from '../utils/callBrowserNotify';
import {attachOutgoingDeclineListener, clearOutgoingDeclineListener} from '../utils/outgoingDeclineListen';
import {attachIncomingCancelListener, clearIncomingCancelListener} from '../utils/incomingCancelListen';
import {watchPeerConnection} from '../utils/peerConnectionWatch';

let gStream;
let cPeer;

/**
 * The plugin reducer is registered by initialize(), but never assume the slice
 * is there: reading through it must not throw during webapp boot.
 */
function pluginState(getState) {
    return getState()[`plugins-${pluginId}`] || {};
}

/**
 * Signalling resources belonging to the current call. Each subscribe() holds an
 * open SSE connection, and browsers cap concurrent connections per host, so a
 * call that ends without releasing these starves the webapp's own requests.
 * The session-long listener from listenVideoCall() is deliberately not tracked.
 */
const callHubs = [];
const callSwarms = [];
const callWatches = [];

function trackHub(hub) {
    callHubs.push(hub);
    return hub;
}

function trackSwarm(sw, label, iceServers) {
    callSwarms.push(sw);
    callWatches.push(watchPeerConnection(sw, label, iceServers));
    return sw;
}

function releaseCallResources() {
    while (callWatches.length) {
        const cancel = callWatches.pop();
        try {
            cancel();
        } catch (e) {
            debug('connection watch cancel failed', e);
        }
    }
    while (callSwarms.length) {
        const sw = callSwarms.pop();
        try {
            sw.close();
        } catch (e) {
            debug('swarm close failed', e);
        }
    }
    while (callHubs.length) {
        const hub = callHubs.pop();
        try {
            hub.close();
        } catch (e) {
            debug('hub close failed', e);
        }
    }
}

export function openVideoCallPicker(hintChannelId = null) {
    return {
        type: ActionTypes.OPEN_VIDEO_CALL_PICKER,
        data: {hintChannelId},
    };
}

export function closeVideoCallPicker() {
    return {
        type: ActionTypes.CLOSE_VIDEO_CALL_PICKER,
    };
}

export function loadConfig() {
    return (dispatch, getState) => {
        const user = getCurrentUser(getState());

        if (!user) {
            return;
        }

        const {configLoaded} = pluginState(getState);

        if (configLoaded) {
            return;
        }

        debug('load config');

        axios.get(`/plugins/${pluginId}/v1/config`).then((response) => {
            if (response.status === 200) {
                debug('loaded config', response.data);
                dispatch({
                    type: ActionTypes.LOAD_CONFIG,
                    data: response.data,
                });
                listenVideoCall()(dispatch, getState);
            } else {
                debug(`Cannot fetch plugin configuration, server returned code ${response.status}`);
            }
        }).catch((e) => {
            debug(`Cannot fetch plugin configuration: ${e}`);
        });
    };
}

function callerDisplayName(user) {
    if (!user) {
        return 'Someone';
    }
    const n = `${user.first_name || ''} ${user.last_name || ''}`.trim();
    return n || user.username || 'Someone';
}

function parseIncomingCallSignal(raw) {
    if (raw == null) {
        return null;
    }
    if (typeof raw === 'string') {
        return {callerId: raw, callId: null, audioOnly: false};
    }
    if (typeof raw === 'object' && raw.callerId) {
        return {
            callerId: raw.callerId,
            callId: raw.callId || null,
            audioOnly: Boolean(raw.audioOnly),
        };
    }
    return null;
}

export function makeVideoCall(peerId, {audioOnly = false} = {}) {
    return (dispatch, getState) => {
        const user = getCurrentUser(getState());
        const config = getConfig(getState());
        const {configLoaded, callIncoming, callOutgoing} = pluginState(getState);

        if (!configLoaded) {
            debug('Video call: plugin config not loaded. Check Network tab for /plugins/' + pluginId + '/v1/config');
            return;
        }

        if (!peerId) {
            debug('Video call: open a 1:1 direct message (not a group or team channel).');
            return;
        }

        if (!user || !user.id) {
            return;
        }

        // Every entry point funnels through here, so this is the one place that
        // has to hold: a call to yourself negotiates with nobody and sits on
        // "Connecting…" for ever.
        if (peerId === user.id) {
            debug('Video call: you cannot call yourself.');
            return;
        }

        if (callIncoming) {
            return;
        }

        if (callOutgoing) {
            return;
        }

        const callId = newCallId();
        const callhub = trackHub(pluginSignalHub(`mattermost-webrtc-video-${config.DiagnosticId}-call-${peerId}`));
        const accepthub = trackHub(pluginSignalHub(`mattermost-webrtc-video-${config.DiagnosticId}`));

        dispatch({
            type: ActionTypes.MAKE_VIDEO_CALL,
            data: {
                peerId,
                callId,
                audioOnly,
            },
        });

        startOutgoingRingback();

        listenAccept(user.id, peerId)(dispatch, getState);

        attachOutgoingDeclineListener(accepthub, user.id, peerId, () => {
            clearOutgoingDeclineListener();
            stopOutgoingRingback();
            releaseCallResources();
            dispatch({type: ActionTypes.OUTGOING_CALL_DECLINED});
        });

        (async () => {
            try {
                let channelId = getDirectChannelIdForPeer(getState(), user.id, peerId);
                if (!channelId) {
                    channelId = await ensureDirectChannelId(user.id, peerId);
                }
                await createVideoInvitePost(channelId, user, peerId, callId);
            } catch (e) {
                debug('Video call invite post failed (call signalling still proceeds)', e);
            }
            debug(`calling ${peerId} (${callId})`);
            callhub.broadcast(`call-${peerId}`, {callerId: user.id, callId, audioOnly});
        })();
    };
}

export function receiveVideoCall(peerId, callId = null, audioOnly = false) {
    return (dispatch, getState) => {
        const user = getCurrentUser(getState());
        const {callIncoming, callOutgoing} = pluginState(getState);

        if (!peerId) {
            return;
        }

        if (!user || !user.id) {
            return;
        }

        // Signalling topics are shared, so refuse a ring that claims to come
        // from us however it was produced.
        if (peerId === user.id) {
            debug('Ignoring an incoming call that claims to be from ourselves.');
            return;
        }

        if (callIncoming) {
            return;
        }

        if (callOutgoing) {
            return;
        }

        dispatch({
            type: ActionTypes.RECEIVE_VIDEO_CALL,
            data: {
                peerId,
                callId,
                audioOnly,
            },
        });

        const config = getConfig(getState());
        const cancelhub = trackHub(pluginSignalHub(`mattermost-webrtc-video-${config.DiagnosticId}`));
        attachIncomingCancelListener(cancelhub, user.id, peerId, callId, () => {
            debug(`call from ${peerId} was cancelled`);
            endCall()(dispatch, getState);
        });

        const peer = getUser(getState(), peerId);
        startIncomingRing();
        notifyIncomingCall(callerDisplayName(peer));
    };
}

export function listenVideoCall() {
    return (dispatch, getState) => {
        const config = getConfig(getState());
        const {configLoaded, callListening} = pluginState(getState);

        if (!configLoaded) {
            return;
        }

        if (callListening) {
            return;
        }

        const user = getCurrentUser(getState());

        if (!user) {
            return;
        }

        const callhub = pluginSignalHub(`mattermost-webrtc-video-${config.DiagnosticId}-call-${user.id}`);

        debug(`listening for calls for ${user.id}`);
        callhub.subscribe(`call-${user.id}`).on('data', (raw) => {
            const parsed = parseIncomingCallSignal(raw);
            if (!parsed) {
                return;
            }
            debug(`call from ${parsed.callerId}`, parsed.callId);
            receiveVideoCall(parsed.callerId, parsed.callId, parsed.audioOnly)(dispatch, getState);
        });

        dispatch({
            type: ActionTypes.LISTEN_VIDEO_CALL,
        });
    };
}

function listenAccept(userId, peerId) {
    return (dispatch, getState) => {
        const config = getConfig(getState());
        const user = getUser(getState(), userId);
        const {configLoaded, callPeerId} = pluginState(getState);

        if (!configLoaded || !user) {
            return;
        }

        const accepthub = trackHub(pluginSignalHub(`mattermost-webrtc-video-${config.DiagnosticId}`));
        accepthub.subscribe('all').on('data', ({...a}) => {
            debug('HUB DATA', a);
        });

        accepthub.subscribe(`accept-${peerId}`).on('data', (acceptedUserId) => {
            const {peerAccepted} = pluginState(getState);
            if (acceptedUserId !== userId) {
                return;
            }

            if (peerAccepted) {
                return;
            }

            const {stunServer: stun2, turnServer: turn2, turnServerUsername: tu2, turnServerCredential: tc2} = pluginState(getState);

            const iceServers = buildIceServers(stun2, turn2, tu2, tc2);

            const callhub = trackHub(pluginSignalHub(`mattermost-webrtc-video-${config.DiagnosticId}-call-${callPeerId}`));
            const sw = trackSwarm(swarm(
                callhub,
                {
                    config: {iceServers},
                    uuid: user.id,
                    wrap: (outgoingSignalingData) => {
                        outgoingSignalingData.fromUserId = user.id;
                        outgoingSignalingData.fromUsername = user.username;
                        return outgoingSignalingData;
                    },
                },
            ), 'caller', iceServers);

            sw.on('peer', (peer, id) => {
                debug('Peer ', peer, id);

                peer.on('data', (payload) => {
                    cPeer = peer;

                    const data = JSON.parse(payload.toString());
                    debug('received data', {id, data});

                    if (data.type === 'receivedHandshake') {
                        captureAndShareMedia(peer, dispatch, getState);
                    }

                    if (data.type === 'sendHandshake') {
                        peer.send(JSON.stringify({type: 'receivedHandshake'}));
                    }

                    if (data.type === 'audioToggle') {
                        debug('audio toggle', data.enabled);

                        dispatch({
                            type: ActionTypes.PEER_AUDIO_TOGGLE,
                            data: data.enabled,
                        });
                    }

                    if (data.type === 'videoToggle') {
                        debug('video toggle', data.enabled);

                        dispatch({
                            type: ActionTypes.PEER_VIDEO_TOGGLE,
                            data: data.enabled,
                        });
                    }
                });
                debug('Sending Handshake');
                peer.send(JSON.stringify({
                    type: 'sendHandshake',
                    userId: user.id,
                }));

                peer.on('track', (track, streamObj) => {
                    if (track.kind !== 'video') {
                        return;
                    }

                    const {callPeerStream} = pluginState(getState);
                    if (!callPeerStream) {
                        // First negotiation; the 'stream' event covers this one.
                        return;
                    }

                    /*
                     * Re-wrap so the object identity changes. The video element
                     * already points at this MediaStream, and attachStream skips
                     * a stream it believes is unchanged, so the new camera track
                     * would otherwise never be shown.
                     */
                    debug('peer turned their camera on', id);
                    dispatch({
                        type: ActionTypes.PEER_STREAM_RECEIVED,
                        data: new MediaStream(streamObj.getTracks()),
                    });
                });

                peer.on('stream', (streamObj) => {
                    debug('Stream', peer, id);
                    dispatch({
                        type: ActionTypes.PEER_STREAM_RECEIVED,
                        data: streamObj,
                    });
                });
            });

            sw.on('disconnect', (peer, id) => {
                debug('disconnected from a peer:', peer, id);
                cPeer = null;
                dispatch({
                    type: ActionTypes.PEER_LOST,
                });

                /*
                 * A 1:1 call is over once the peer goes. PEER_LOST only cleared
                 * the remote stream, and the modal shows "Connecting…" for
                 * exactly `accepted && !peerStream` — so hanging up on one side
                 * left the other spinning there for ever.
                 */
                endCall()(dispatch, getState);
            });

            stopOutgoingRingback();

            dispatch({
                type: ActionTypes.PEER_ACCEPTED,
            });

            clearOutgoingDeclineListener();

            debug(`accepted from ${peerId}`);
        });
    };
}

export function acceptCall() {
    return (dispatch, getState) => {
        stopIncomingRing();
        clearIncomingCancelListener();
        const user = getCurrentUser(getState());
        const config = getConfig(getState());
        const {callPeerId, peerAccepted} = pluginState(getState);

        if (!user || !user.id) {
            return;
        }

        const accepthub = trackHub(pluginSignalHub(`mattermost-webrtc-video-${config.DiagnosticId}`));
        accepthub.subscribe('all').on('data', ({...a}) => {
            debug('HUB DATA', a);
        });
        accepthub.broadcast(`accept-${user.id}`, callPeerId);
        debug('acceptCall', peerAccepted);
        const {stunServer, turnServer, turnServerUsername, turnServerCredential} = pluginState(getState);

        const iceServers = buildIceServers(stunServer, turnServer, turnServerUsername, turnServerCredential);

        const callhub = trackHub(pluginSignalHub(`mattermost-webrtc-video-${config.DiagnosticId}-call-${user.id}`));
        const sw = trackSwarm(swarm(
            callhub,
            {
                config: {iceServers},
                uuid: user.id,
                wrap: (outgoingSignalingData) => {
                    outgoingSignalingData.fromUserId = user.id;
                    outgoingSignalingData.fromUsername = user.username;
                    return outgoingSignalingData;
                },
            },
        ), 'callee', iceServers);

        sw.on('peer', (peer, id) => {
            debug('Peer', typeof peer.hasOwnProperty, id);

            peer.on('data', (payload) => {
                cPeer = peer;

                const data = JSON.parse(payload.toString());

                debug('received data', {id, data});

                if (data.type === 'receivedHandshake') {
                    captureAndShareMedia(peer, dispatch, getState);
                }

                if (data.type === 'sendHandshake') {
                    peer.send(JSON.stringify({type: 'receivedHandshake'}));
                }

                if (data.type === 'audioToggle') {
                    debug('audio toggle', data.enabled);

                    dispatch({
                        type: ActionTypes.PEER_AUDIO_TOGGLE,
                        data: data.enabled,
                    });
                }

                if (data.type === 'videoToggle') {
                    debug('video toggle', data.enabled);

                    dispatch({
                        type: ActionTypes.PEER_VIDEO_TOGGLE,
                        data: data.enabled,
                    });
                }
            });
            debug('Sending Handshake');
            peer.send(JSON.stringify({
                type: 'sendHandshake',
                userId: user.id,
            }));

            peer.on('track', (track, streamObj) => {
                if (track.kind !== 'video') {
                    return;
                }

                const {callPeerStream} = pluginState(getState);
                if (!callPeerStream) {
                    // First negotiation; the 'stream' event covers this one.
                    return;
                }

                /*
                 * Re-wrap so the object identity changes. The video element
                 * already points at this MediaStream, and attachStream skips
                 * a stream it believes is unchanged, so the new camera track
                 * would otherwise never be shown.
                 */
                debug('peer turned their camera on', id);
                dispatch({
                    type: ActionTypes.PEER_STREAM_RECEIVED,
                    data: new MediaStream(streamObj.getTracks()),
                });
            });

            peer.on('stream', (streamObj) => {
                debug('Stream', peer, id);
                dispatch({
                    type: ActionTypes.PEER_STREAM_RECEIVED,
                    data: streamObj,
                });
            });
        });

        sw.on('disconnect', (peer, id) => {
            debug('disconnected from a peer:', peer, id);
            cPeer = null;
            dispatch({
                type: ActionTypes.PEER_LOST,
            });

            /*
             * A 1:1 call is over once the peer goes. PEER_LOST only cleared
             * the remote stream, and the modal shows "Connecting…" for
             * exactly `accepted && !peerStream` — so hanging up on one side
             * left the other spinning there for ever.
             */
            endCall()(dispatch, getState);
        });

        dispatch({
            type: ActionTypes.ACCEPT_CALL,
        });
    };
}

export function rejectCall() {
    return (dispatch, getState) => {
        stopIncomingRing();
        clearIncomingCancelListener();
        const state = pluginState(getState);
        const user = getCurrentUser(getState());

        if (state.callIncoming && state.callPeerId && user && user.id) {
            const config = getConfig(getState());
            const hub = trackHub(pluginSignalHub(`mattermost-webrtc-video-${config.DiagnosticId}`));
            hub.broadcast(`decline-${state.callPeerId}`, {
                calleeId: user.id,
                callId: state.activeCallId,
            });

            (async () => {
                let channelId = getDirectChannelIdForPeer(getState(), user.id, state.callPeerId);
                if (!channelId) {
                    try {
                        channelId = await ensureDirectChannelId(user.id, state.callPeerId);
                    } catch (e) {
                        debug('rejectCall: could not resolve DM for declined-call notice', e);
                        return;
                    }
                }
                sendCallDeclinedEphemeral(channelId, state.callPeerId, user).catch(() => {
                    /* ignore ephemeral errors */
                });
            })();
        }

        clearOutgoingDeclineListener();
        releaseCallResources();
        dispatch({
            type: ActionTypes.REJECT_CALL,
        });
    };
}

export function endCall() {
    return (dispatch, getState) => {
        const state = pluginState(getState);
        const user = getCurrentUser(getState());

        /*
         * A call still ringing has no peer connection for the callee to notice
         * dropping, so hanging up now would leave their modal ringing for ever.
         * Once the peers are connected the data channel closing tells them.
         */
        if (state.callOutgoing && !state.peerAccepted && state.callPeerId && user && user.id) {
            const config = getConfig(getState());
            const hub = trackHub(pluginSignalHub(`mattermost-webrtc-video-${config.DiagnosticId}`));
            hub.broadcast(`cancel-${state.callPeerId}`, {
                callerId: user.id,
                callId: state.activeCallId,
            });
        }

        if (gStream) {
            gStream.getTracks().forEach((track) => track.stop());
            gStream = null;
        }

        cPeer = null;
        stopIncomingRing();
        stopOutgoingRingback();
        clearOutgoingDeclineListener();
        clearIncomingCancelListener();
        releaseCallResources();

        dispatch({
            type: ActionTypes.END_CALL,
        });
    };
}

/**
 * getUserMedia({video, audio}) is atomic: if the camera cannot be opened — two
 * browsers on one machine competing for it is enough — the whole request
 * rejects and the call ends up with no media at all, audio included. Walk down
 * to narrower constraints instead of giving up on the first refusal.
 */
const MEDIA_LADDER = [
    {constraints: {video: true, audio: true}, caps: {video: true, audio: true}},
    {constraints: {video: false, audio: true}, caps: {video: false, audio: true}},
    {constraints: {video: true, audio: false}, caps: {video: true, audio: false}},
];

const AUDIO_ONLY_LADDER = [
    {constraints: {video: false, audio: true}, caps: {video: false, audio: true}},
];

function describeMediaError(error) {
    switch ((error && error.name) || '') {
    case 'NotAllowedError':
    case 'SecurityError':
        return 'Camera and microphone permission was denied.';
    case 'NotFoundError':
    case 'OverconstrainedError':
        return 'No camera or microphone was found on this device.';
    case 'NotReadableError':
    case 'AbortError':
        return 'The camera or microphone is already in use by another application.';
    default:
        return 'Could not open the camera or microphone.';
    }
}

function getUserMedia(ladder, cb) {
    const tryStep = (index, lastError) => {
        if (index >= ladder.length) {
            debug('Cannot initialize camera/microphone', lastError);
            cb(lastError, null, {video: false, audio: false});
            return;
        }

        const {constraints, caps} = ladder[index];
        navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
            if (index > 0) {
                debug(`Media degraded to ${JSON.stringify(constraints)} after`, lastError);
            }
            cb(null, stream, caps);
        }).catch((e) => {
            debug(`getUserMedia rejected for ${JSON.stringify(constraints)}: ${e}`);
            tryStep(index + 1, e);
        });
    };

    tryStep(0, null);
}

/**
 * Both sides run this on `receivedHandshake`; it was duplicated verbatim in the
 * caller and callee paths.
 */
function captureAndShareMedia(peer, dispatch, getState) {
    // An audio call must not open the camera at all — no ladder, no fallback
    // that would quietly light it up.
    const {callAudioOnly} = pluginState(getState);
    const ladder = callAudioOnly ? AUDIO_ONLY_LADDER : MEDIA_LADDER;

    getUserMedia(ladder, (error, stream, caps) => {
        if (error || !stream) {
            dispatch({
                type: ActionTypes.MEDIA_ERROR,
                data: describeMediaError(error),
            });
            return;
        }

        gStream = stream;
        peer.addStream(stream);

        dispatch({type: ActionTypes.SELF_STREAM_SET, data: stream});
        dispatch({type: ActionTypes.AUDIO_TOGGLE, data: caps.audio});
        dispatch({type: ActionTypes.VIDEO_TOGGLE, data: caps.video});

        /*
         * The ladder succeeded, so there is no error to report — but the user
         * asked for video and did not get it, and silence there just looks like
         * the camera is broken. The usual cause is another application holding
         * it, two browsers on one machine included.
         */
        if (!callAudioOnly && !caps.video) {
            dispatch({
                type: ActionTypes.MEDIA_ERROR,
                data: 'Your camera could not be opened — another application may be using it. The call continues with audio only.',
            });
        }

        // Tell the far side what it is actually getting, so it does not sit
        // waiting on a video track that was never captured.
        try {
            peer.send(JSON.stringify({type: 'audioToggle', enabled: caps.audio}));
            peer.send(JSON.stringify({type: 'videoToggle', enabled: caps.video}));
        } catch (e) {
            debug('Could not announce media capabilities to peer', e);
        }
    });
}

export function audioToggle() {
    return (dispatch, getState) => {
        const {audioOn} = pluginState(getState);

        if (!cPeer) {
            return;
        }
        if (gStream) {
            const t = gStream.getAudioTracks()[0];
            if (t) {
                t.enabled = !audioOn;
            }
        }

        if (cPeer) {
            cPeer.send(JSON.stringify({type: 'audioToggle', enabled: !audioOn}));
        }
        dispatch({type: ActionTypes.AUDIO_TOGGLE,
            data: !audioOn});
    };
}

export function videoToggle() {
    return (dispatch, getState) => {
        const {videoOn} = pluginState(getState);

        if (!cPeer) {
            return;
        }

        const turningOn = !videoOn;
        const track = gStream && gStream.getVideoTracks()[0];

        /*
         * A call placed with the phone button never opened the camera, so
         * turning video on has to acquire it now and put it on the live
         * connection. simple-peer renegotiates by itself once a track is added.
         */
        if (turningOn && !track) {
            navigator.mediaDevices.getUserMedia({video: true}).then((videoStream) => {
                const acquired = videoStream.getVideoTracks()[0];
                if (!acquired || !cPeer) {
                    return;
                }

                if (gStream) {
                    /*
                     * Add to the stream the peer already holds rather than
                     * sending a second one: a fresh stream would replace the
                     * far side's reference and take the audio away with it.
                     */
                    gStream.addTrack(acquired);
                    cPeer.addTrack(acquired, gStream);
                } else {
                    gStream = videoStream;
                    cPeer.addStream(videoStream);
                }

                // New object for the same tracks, so the preview re-attaches.
                dispatch({
                    type: ActionTypes.SELF_STREAM_SET,
                    data: new MediaStream(gStream.getTracks()),
                });
                cPeer.send(JSON.stringify({type: 'videoToggle', enabled: true}));
                dispatch({type: ActionTypes.VIDEO_TOGGLE, data: true});
            }).catch((e) => {
                debug('Could not open the camera mid-call', e);
                dispatch({
                    type: ActionTypes.MEDIA_ERROR,
                    data: describeMediaError(e),
                });
            });
            return;
        }

        if (track) {
            track.enabled = turningOn;
        }
        cPeer.send(JSON.stringify({type: 'videoToggle', enabled: turningOn}));
        dispatch({type: ActionTypes.VIDEO_TOGGLE, data: turningOn});
    };
}
