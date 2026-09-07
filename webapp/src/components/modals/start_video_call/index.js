import {connect} from 'react-redux';
import {bindActionCreators} from 'redux';
import {getCurrentUser, getUser} from 'mattermost-redux/selectors/entities/users';

import {acceptCall, rejectCall, endCall, audioToggle, videoToggle} from '../../../actions';

import {id as pluginId} from 'manifest';

import StartVideoCall from './start_video_call';

const getPeerName = (peer) => {
    return `${peer.first_name || ''} ${peer.last_name || ''}`.trim() || peer.username || '';
};

const mapStateToProps = (state) => {
    // Never assume the current user or the plugin slice are hydrated: throwing
    // here would take the whole Mattermost webapp down with the plugin.
    const currentUser = getCurrentUser(state) || {};
    const slice = state[`plugins-${pluginId}`] || {};
    const peerId = slice.callPeerId || '';
    let peer = {};

    if (peerId) {
        peer = getUser(state, peerId);
    }

    if (!peer) {
        peer = {};
    }

    return {
        userId: currentUser.id || '',
        peerId,
        peerName: getPeerName(peer),
        visible: Boolean(slice.modalVisible),
        outgoing: Boolean(slice.callOutgoing),
        incoming: Boolean(slice.callIncoming),
        accepted: Boolean(slice.callAccepted),
        peerAccepted: Boolean(slice.peerAccepted),
        outgoingCallDeclined: Boolean(slice.outgoingCallDeclined),
        peerStream: slice.callPeerStream,
        callPeerAudioOn: Boolean(slice.callPeerAudioOn),
        callPeerVideoOn: Boolean(slice.callPeerVideoOn),
        connectedPeer: slice.connectedPeer,
        selfStream: slice.selfStream,
        mediaError: slice.mediaError || '',
        callAudioOnly: Boolean(slice.callAudioOnly),
        audioOn: Boolean(slice.audioOn),
        videoOn: Boolean(slice.videoOn),
    };
};

const mapDispatchToProps = (dispatch) => bindActionCreators({
    acceptCall,
    rejectCall,
    endCall,
    audioToggle,
    videoToggle,
}, dispatch);

export default connect(mapStateToProps, mapDispatchToProps)(StartVideoCall);
