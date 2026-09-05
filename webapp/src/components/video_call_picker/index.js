import {connect} from 'react-redux';
import {bindActionCreators} from 'redux';

import {closeVideoCallPicker, makeVideoCall} from '../../actions';
import {id as pluginId} from 'manifest';
import {getDirectMessagePeersForPicker, getHintedPeerId} from '../../utils/dmPickerPeers';
import debug from '../../utils/debug';

import VideoCallPicker from './video_call_picker';

const mapStateToProps = (state) => {
    const slice = state[`plugins-${pluginId}`] || {};

    /*
     * mapStateToProps runs inside Mattermost's own React tree, so anything
     * thrown here takes the picker out of the page entirely — which is exactly
     * what a host selector that had been renamed did. Host APIs drift between
     * server versions; degrade to an empty picker instead of vanishing.
     */
    let peerRows = [];
    let hintPeerId = null;
    try {
        peerRows = getDirectMessagePeersForPicker(state);
        hintPeerId = getHintedPeerId(state, slice.videoCallPickerHintChannelId);
    } catch (e) {
        debug('[video_call_picker] could not read direct messages', e);
    }

    return {
        open: Boolean(slice.videoCallPickerOpen),
        peerRows,
        hintPeerId,
    };
};

const mapDispatchToProps = (dispatch) => bindActionCreators({
    closeVideoCallPicker,
    makeVideoCall,
}, dispatch);

export default connect(mapStateToProps, mapDispatchToProps)(VideoCallPicker);
