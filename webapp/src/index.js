import {getChannel} from 'mattermost-redux/selectors/entities/channels';
import {getCurrentUser} from 'mattermost-redux/selectors/entities/users';
import {getConfig} from 'mattermost-redux/selectors/entities/general';

import {id as pluginId} from './manifest';
import Icon, {PhoneIcon} from './components/icon.jsx';
import StartVideoCallModal from './components/modals/start_video_call';
import VideoCallPickerModal from './components/video_call_picker';
import PopoverVideoCallButton from './components/popover_video_call_button';
import LeftSidebarHeader from './components/left_sidebar_header';
import Reducer from './reducers';
import WebrtcInvitePost from './components/post_types/webrtc_invite_post';
import {WEBRTC_INVITE_POST_TYPE} from './constants/callInvite';
import VoiceInvitePost from './components/post_types/voice_invite_post';
import {VOICE_INVITE_POST_TYPE} from './constants/voiceInvite';
import {loadConfig, makeVideoCall, openVideoCallPicker} from './actions';
import {getDirectMessagePeerUserId} from './utils/dmPeer';
import {withErrorBoundary} from './components/with_error_boundary';
import debug from './utils/debug';
import {registerVoicePresenceEvents} from './utils/voicePresenceEvents';
import {registerVoiceInviteEvents} from './utils/voiceInviteEvents';

/**
 * Each registration is isolated: a registry method this server version does not
 * expose, or a component that throws, must not take the rest of the plugin —
 * or the Mattermost webapp itself — down with it.
 */
function safely(label, fn) {
    try {
        fn();
    } catch (e) {
        debug(`[initialize] ${label} failed`, e);
    }
}

/**
 * loadConfig bails out when the current user is not in the store yet, and
 * nothing ever retried it — so a plugin bundle that finished loading before the
 * webapp hydrated was left with configLoaded false forever, unable to place or
 * receive a call. Wait for the store instead of firing once and hoping.
 *
 * DiagnosticId is part of the readiness check because every signalling topic is
 * namespaced with it; starting without it would build hubs named "undefined".
 */
function whenStoreReady(store, run) {
    const isReady = () => {
        const state = store.getState();
        return Boolean(getCurrentUser(state) && (getConfig(state) || {}).DiagnosticId);
    };

    if (isReady()) {
        run();
        return;
    }

    debug('[initialize] store not hydrated yet, deferring loadConfig');

    let unsubscribe = null;
    const onChange = () => {
        if (!isReady()) {
            return;
        }
        if (unsubscribe) {
            unsubscribe();
            unsubscribe = null;
        }
        run();
    };
    unsubscribe = store.subscribe(onChange);

    // subscribe() does not replay the current state, so cover the case where the
    // store became ready between isReady() above and the subscription landing.
    onChange();
}

export default class Plugin {
    initialize(registry, store) {
        safely('registerReducer', () => registry.registerReducer(Reducer));

        const openPicker = (hintChannelId) => {
            store.dispatch(openVideoCallPicker(hintChannelId));
        };

        // Registry callbacks hand back a channel id in some places and the whole
        // channel object in others, depending on the server version.
        const toChannelId = (arg) => {
            if (!arg) {
                return null;
            }
            return typeof arg === 'string' ? arg : (arg.id || null);
        };

        /**
         * In a 1:1 DM there is exactly one person to call, so ring them straight
         * away; anywhere else the picker is the only sensible thing to show.
         */
        const startCallFromChannel = (arg, {audioOnly = false} = {}) => {
            const channelId = toChannelId(arg);
            const state = store.getState();
            const channel = channelId ? getChannel(state, channelId) : null;
            const peerId = getDirectMessagePeerUserId(state, channel);

            if (peerId) {
                store.dispatch(makeVideoCall(peerId, {audioOnly}));
                return;
            }
            openPicker(channelId);
        };

        safely('registerMainMenuAction', () => registry.registerMainMenuAction(
            'Start video call…',
            () => openPicker(null),
            Icon,
        ));

        safely('registerChannelHeaderMenuAction', () => registry.registerChannelHeaderMenuAction(
            'Start video call…',
            (channelId) => openPicker(toChannelId(channelId)),
        ));

        /*
         * Two header buttons, as in Discord: the handset starts the call with
         * the camera off — never even opened — and the camera starts it with
         * video on. Either call can switch mid-way.
         */
        safely('registerChannelHeaderButtonAction(audio)', () => registry.registerChannelHeaderButtonAction(
            PhoneIcon,
            (arg) => startCallFromChannel(arg, {audioOnly: true}),
            'Start voice call',
            'Start a voice call',
        ));

        safely('registerChannelHeaderButtonAction(video)', () => registry.registerChannelHeaderButtonAction(
            Icon,
            (arg) => startCallFromChannel(arg, {audioOnly: false}),
            'Start video call',
            'Start a video call',
        ));

        safely('registerPopoverUserActionsComponent', () => registry.registerPopoverUserActionsComponent(
            withErrorBoundary(PopoverVideoCallButton, 'popover_video_call_button'),
        ));

        safely('registerRootComponent(start_video_call)', () => registry.registerRootComponent(
            withErrorBoundary(StartVideoCallModal, 'start_video_call'),
        ));

        safely('registerRootComponent(video_call_picker)', () => registry.registerRootComponent(
            withErrorBoundary(VideoCallPickerModal, 'video_call_picker'),
        ));

        safely('registerLeftSidebarHeaderComponent', () => registry.registerLeftSidebarHeaderComponent(
            withErrorBoundary(LeftSidebarHeader, 'left_sidebar_header'),
        ));

        safely('registerPostTypeComponent', () => registry.registerPostTypeComponent(
            WEBRTC_INVITE_POST_TYPE,
            withErrorBoundary(WebrtcInvitePost, 'webrtc_invite_post'),
        ));

        safely('registerPostTypeComponent(voice_invite)', () => registry.registerPostTypeComponent(
            VOICE_INVITE_POST_TYPE,
            withErrorBoundary(VoiceInvitePost, 'voice_invite_post'),
        ));

        safely('registerWebSocketEventHandler(voice_presence)', () => registerVoicePresenceEvents(registry));
        safely('registerWebSocketEventHandler(voice_invite)', () => registerVoiceInviteEvents(registry));

        safely('loadConfig', () => whenStoreReady(store, () => {
            loadConfig()(store.dispatch, store.getState);
        }));
    }
}

if (typeof window.registerPlugin === 'function') {
    window.registerPlugin(pluginId, new Plugin());
}
