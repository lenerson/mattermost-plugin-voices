import {combineReducers} from 'redux';

import ActionTypes from '../action_types';

const configLoaded = (state = false, action) => {
    switch (action.type) {
    case ActionTypes.LOAD_CONFIG:
        return true;
    default:
        return state;
    }
};

const stunServer = (state = '', action) => {
    switch (action.type) {
    case ActionTypes.LOAD_CONFIG:
        return action.data.STUNServer;
    default:
        return state;
    }
};

const turnServer = (state = '', action) => {
    switch (action.type) {
    case ActionTypes.LOAD_CONFIG:
        return action.data.TURNServer;
    default:
        return state;
    }
};

const turnServerUsername = (state = '', action) => {
    switch (action.type) {
    case ActionTypes.LOAD_CONFIG:
        return action.data.TURNServerUsername;
    default:
        return state;
    }
};

const turnServerCredential = (state = '', action) => {
    switch (action.type) {
    case ActionTypes.LOAD_CONFIG:
        return action.data.TURNServerCredential;
    default:
        return state;
    }
};

const videoCallPickerOpen = (state = false, action) => {
    switch (action.type) {
    case ActionTypes.OPEN_VIDEO_CALL_PICKER:
        return true;
    case ActionTypes.CLOSE_VIDEO_CALL_PICKER:
        return false;
    default:
        return state;
    }
};

const videoCallPickerHintChannelId = (state = null, action) => {
    switch (action.type) {
    case ActionTypes.OPEN_VIDEO_CALL_PICKER:
        return (action.data && action.data.hintChannelId) || null;
    case ActionTypes.CLOSE_VIDEO_CALL_PICKER:
        return null;
    default:
        return state;
    }
};

const modalVisible = (state = false, action) => {
    switch (action.type) {
    case ActionTypes.MAKE_VIDEO_CALL:
        return true;
    case ActionTypes.RECEIVE_VIDEO_CALL:
        return true;
    case ActionTypes.REJECT_CALL:
        return false;
    case ActionTypes.END_CALL:
        return false;
    default:
        return state;
    }
};

const callListening = (state = false, action) => {
    switch (action.type) {
    case ActionTypes.LISTEN_VIDEO_CALL:
        return true;
    default:
        return state;
    }
};

const callIncoming = (state = false, action) => {
    switch (action.type) {
    case ActionTypes.RECEIVE_VIDEO_CALL:
        return true;
    case ActionTypes.REJECT_CALL:
        return false;
    case ActionTypes.END_CALL:
        return false;
    default:
        return state;
    }
};

const callOutgoing = (state = false, action) => {
    switch (action.type) {
    case ActionTypes.MAKE_VIDEO_CALL:
        return true;
    case ActionTypes.REJECT_CALL:
        return false;
    case ActionTypes.END_CALL:
        return false;
    default:
        return state;
    }
};

const callAccepted = (state = false, action) => {
    switch (action.type) {
    case ActionTypes.MAKE_VIDEO_CALL:
        return true;
    case ActionTypes.ACCEPT_CALL:
        return true;
    case ActionTypes.REJECT_CALL:
        return false;
    case ActionTypes.END_CALL:
        return false;
    default:
        return state;
    }
};

const callPeerId = (state = '', action) => {
    switch (action.type) {
    case ActionTypes.MAKE_VIDEO_CALL:
        return action.data.peerId;
    case ActionTypes.RECEIVE_VIDEO_CALL:
        return action.data.peerId;
    case ActionTypes.REJECT_CALL:
        return '';
    case ActionTypes.END_CALL:
        return '';
    default:
        return state;
    }
};

const activeCallId = (state = null, action) => {
    switch (action.type) {
    case ActionTypes.MAKE_VIDEO_CALL:
    case ActionTypes.RECEIVE_VIDEO_CALL:
        return (action.data && action.data.callId) || null;
    case ActionTypes.REJECT_CALL:
    case ActionTypes.END_CALL:
    case ActionTypes.OUTGOING_CALL_DECLINED:
        return null;
    default:
        return state;
    }
};

const outgoingCallDeclined = (state = false, action) => {
    switch (action.type) {
    case ActionTypes.OUTGOING_CALL_DECLINED:
        return true;
    case ActionTypes.REJECT_CALL:
    case ActionTypes.END_CALL:
    case ActionTypes.MAKE_VIDEO_CALL:
        return false;
    default:
        return state;
    }
};

const peerAccepted = (state = false, action) => {
    switch (action.type) {
    case ActionTypes.PEER_ACCEPTED:
        return true;
    case ActionTypes.MAKE_VIDEO_CALL:
        return false;
    case ActionTypes.OUTGOING_CALL_DECLINED:
        return false;
    case ActionTypes.REJECT_CALL:
        return false;
    case ActionTypes.END_CALL:
        return false;
    default:
        return state;
    }
};

const callPeerStream = (state = null, action) => {
    switch (action.type) {
    case ActionTypes.PEER_STREAM_RECEIVED:
        return action.data;
    case ActionTypes.PEER_LOST:
        return null;
    case ActionTypes.END_CALL:
        return null;
    default:
        return state;
    }
};

const callPeerAudioOn = (state = true, action) => {
    switch (action.type) {
    case ActionTypes.PEER_AUDIO_TOGGLE:
        return action.data;
    default:
        return state;
    }
};

const callPeerVideoOn = (state = true, action) => {
    switch (action.type) {
    case ActionTypes.PEER_VIDEO_TOGGLE:
        return action.data;
    default:
        return state;
    }
};

const selfStream = (state = null, action) => {
    switch (action.type) {
    case ActionTypes.SELF_STREAM_SET:
        return action.data;
    case ActionTypes.SELF_STREAM_UNSET:
        return null;
    case ActionTypes.END_CALL:
        return null;
    default:
        return state;
    }
};

const connectedPeer = (state = null, action) => {
    switch (action.type) {
    case ActionTypes.PEER_RECEIVED:
        return action.data.peer;
    case ActionTypes.PEER_LOST:
        return null;
    case ActionTypes.END_CALL:
        return null;
    default:
        return state;
    }
};

/**
 * Why the local camera or microphone could not be opened, so a call that cannot
 * capture media says so instead of sitting on "Connecting…" for ever.
 */
const mediaError = (state = '', action) => {
    switch (action.type) {
    case ActionTypes.MEDIA_ERROR:
        return action.data;
    case ActionTypes.MAKE_VIDEO_CALL:
    case ActionTypes.ACCEPT_CALL:
    case ActionTypes.RECEIVE_VIDEO_CALL:
    case ActionTypes.REJECT_CALL:
    case ActionTypes.END_CALL:
        return '';
    default:
        return state;
    }
};

const audioOn = (state = true, action) => {
    switch (action.type) {
    case ActionTypes.AUDIO_TOGGLE:
        return action.data;
    default:
        return state;
    }
};

const videoOn = (state = true, action) => {
    switch (action.type) {
    // A call placed with the phone button starts with the camera off.
    case ActionTypes.MAKE_VIDEO_CALL:
    case ActionTypes.RECEIVE_VIDEO_CALL:
        return !action.data.audioOnly;
    case ActionTypes.VIDEO_TOGGLE:
        return action.data;
    default:
        return state;
    }
};

/**
 * Whether this call was started as an audio call. Both ends need it: the caller
 * to know not to open the camera, the callee so answering does not turn theirs
 * on either.
 */
const callAudioOnly = (state = false, action) => {
    switch (action.type) {
    case ActionTypes.MAKE_VIDEO_CALL:
    case ActionTypes.RECEIVE_VIDEO_CALL:
        return Boolean(action.data.audioOnly);
    case ActionTypes.REJECT_CALL:
    case ActionTypes.END_CALL:
        return false;
    default:
        return state;
    }
};

export default combineReducers({
    configLoaded,
    videoCallPickerOpen,
    videoCallPickerHintChannelId,
    stunServer,
    turnServer,
    turnServerUsername,
    turnServerCredential,
    modalVisible,
    callListening,
    callIncoming,
    callOutgoing,
    callAccepted,
    peerAccepted,
    callPeerId,
    activeCallId,
    outgoingCallDeclined,
    callPeerStream,
    callPeerVideoOn,
    callPeerAudioOn,
    selfStream,
    connectedPeer,
    mediaError,
    callAudioOnly,
    audioOn,
    videoOn,
});
