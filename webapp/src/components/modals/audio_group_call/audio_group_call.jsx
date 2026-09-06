/* eslint-disable react/prop-types */
/* eslint-disable no-shadow */
import {connect} from 'react-redux';
import React from 'react';
import {getCurrentUser, getProfiles} from 'mattermost-redux/selectors/entities/users';
import {getConfig} from 'mattermost-redux/selectors/entities/general';
import PropTypes from 'prop-types';
import swarm from 'webrtc-swarm';

import {VOICE_INVITE_ACCEPTED, VOICE_INVITE_DECLINED} from '../../../constants/voiceInvite';
import pluginSignalHub from '../../../utils/pluginSignalHub';
import {buildIceServers} from '../../../utils/iceServers';
import debug from '../../../utils/debug';
import {userDisplayName} from '../../../utils/dmPickerPeers';
import {createVoiceRoom, deleteVoiceRoom, fetchVoiceRooms, sendVoicePresence} from '../../../utils/voiceRoomsApi';
import {respondVoiceRoomInvite, searchVoiceInviteUsers, sendVoiceRoomInvite} from '../../../utils/voiceInvitesApi';
import {subscribeVoiceInviteDecisions, subscribeVoiceInvites} from '../../../utils/voiceInviteEvents';
import {subscribeVoicePresenceChanges} from '../../../utils/voicePresenceEvents';
import {playVoiceRoomInviteSound, playVoiceRoomJoinSound, playVoiceRoomLeaveSound} from '../../../utils/voiceRoomSounds';
import {id as pluginId} from 'manifest';

/*
 * Presence changes arrive over the Mattermost websocket. Polling remains as a
 * fallback for reconnects, proxies that interrupt events, and expired clients.
 */
const DIRECTORY_POLL_MS = 10000;

// Comfortably inside the server's 45s expiry, so one lost request is harmless.
const PRESENCE_HEARTBEAT_MS = 15000;

// webrtc-swarm may omit its close callback when already closed, and a broken
// peer may never emit close. Cleanup must still let the caller make progress.
export const SWARM_CLOSE_TIMEOUT_MS = 2000;

function genRoomId() {
    return `vr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function getMediaStream(opts) {
    return navigator.mediaDevices.getUserMedia(opts);
}

async function getMyStream() {
    const audio = {
        autoGainControl: true,
        sampleRate: {ideal: 48000, min: 35000},
        echoCancellation: true,
        channelCount: {ideal: 1},
        volume: 1,
    };

    try {
        debug('try just audio');
        const stream = await getMediaStream({audio});
        return {myStream: stream, audioEnabled: true, videoEnabled: false};
    } catch (err) {
        debug(err);
        return {myStream: null, audioEnabled: false, videoEnabled: false};
    }
}

export class AudioCallPanel extends React.Component {
    static propTypes = {
        userId: PropTypes.string.isRequired,
        username: PropTypes.string,
        configLoaded: PropTypes.bool,
        stunServer: PropTypes.string,
        turnServer: PropTypes.string,
        turnServerUsername: PropTypes.string,
        turnServerCredential: PropTypes.string,
        config: PropTypes.object,
        isSystemAdmin: PropTypes.bool,
        displayName: PropTypes.string,
        profiles: PropTypes.array,
        profilesById: PropTypes.object,
    };

    /**
     * The swarm uuid is the Mattermost user id, so the profile store is the
     * reliable source for a name. The gossiped name is only a fallback: two
     * writers fill peerStreams — the `connect` broadcast, which carries a name,
     * and the swarm's own `peer` event, which does not — and the broadcast is
     * lost outright on anyone who subscribed after it went out. Whoever the
     * `peer` event reached first used to be listed by raw id.
     */
    peerDisplayName(peerId, peer) {
        const {profilesById} = this.props;
        const profile = (profilesById || {})[peer.userId || peerId];
        const fromProfile = userDisplayName(profile);

        return fromProfile || peer.displayName || peer.username || 'Unknown user';
    }

    constructor(props) {
        super(props);

        const {
            stunServer,
            turnServer,
            turnServerUsername,
            turnServerCredential,
            configLoaded,
            config,
        } = props;

        this.state = {
            initialized: false,
            peerStreams: {},
            playBacks: {},
            swarmInitialized: false,
            audioOn: false,
            videoOn: false,
            audioEnabled: true,
            videoEnabled: false,
            speakerOn: true,
            stunServer,
            turnServer,
            turnServerUsername,
            turnServerCredential,
            configLoaded,
            config,
            activeRoom: null,
            channelList: [],
            directoryError: '',
            newChannelNameDraft: '',
            showCreateInput: false,
            hoveredRoomId: null,
            openRoomMenuId: null,
            showInvitePicker: false,
            inviteSearch: '',
            inviteSearchResults: [],
            inviteSearchHasRun: false,
            inviteSearchPending: false,
            inviteError: '',
            inviteStatus: '',
            invitingUserId: null,
            incomingVoiceInvite: null,
            voiceInviteResponsePending: false,
            voiceInviteResponseError: '',
        };

        this.swarmInstance = null;
        this.directoryPoll = null;
        this.presenceHeartbeat = null;
        this.currentMyStream = null;
        this.connectPending = false;
        this.roomTransitionId = 0;
        this.isUnmounted = false;
        this.unsubscribeDirectoryEvents = null;
        this.unsubscribeVoiceInvites = null;
        this.unsubscribeVoiceInviteDecisions = null;
        this.voiceInviteExpiryTimer = null;
        this.inviteSearchRequestId = 0;
        this.invitePickerRef = React.createRef();
        this.inviteButtonRef = React.createRef();
        this.invitePickerOutsideListening = false;
    }

    componentDidMount() {
        // The directory no longer depends on the client config: it is a plugin
        // endpoint of its own, so it loads even before /v1/config comes back.
        this.startDirectoryEvents();
        this.startVoiceInviteEvents();
        this.bootstrapDirectory();
    }

    componentDidUpdate() {
        this.syncInvitePickerOutsideListener();
    }

    componentWillUnmount() {
        this.isUnmounted = true;
        this.removeInvitePickerOutsideListener();
        this.stopPresence();
        this.cleanupConnection(() => {
            /* sync teardown */
        });
        this.stopDirectoryEvents();
        this.stopVoiceInviteEvents();
        this.inviteSearchRequestId += 1;
        this.stopDirectory();
    }

    applyRooms(rooms) {
        if (this.isUnmounted) {
            return;
        }
        this.setState({
            channelList: Array.isArray(rooms) ? rooms : [],
            directoryError: '',
        });
    }

    reportDirectoryError(message, err) {
        debug(message, err);
        if (!this.isUnmounted) {
            this.setState({directoryError: message});
        }
    }

    refreshRooms() {
        return fetchVoiceRooms().
            then((rooms) => this.applyRooms(rooms)).
            catch((err) => this.reportDirectoryError('Could not load the voice channels.', err));
    }

    startDirectoryEvents() {
        if (!this.unsubscribeDirectoryEvents) {
            this.unsubscribeDirectoryEvents = subscribeVoicePresenceChanges((change) => {
                this.handlePresenceSound(change);
                this.handleExclusivePresenceChange(change);
                this.refreshRooms();
            });
        }
    }

    stopDirectoryEvents() {
        if (this.unsubscribeDirectoryEvents) {
            this.unsubscribeDirectoryEvents();
            this.unsubscribeDirectoryEvents = null;
        }
    }

    startVoiceInviteEvents() {
        if (!this.unsubscribeVoiceInvites) {
            this.unsubscribeVoiceInvites = subscribeVoiceInvites((invite) => {
                if (!invite.roomId || !invite.roomName || !invite.inviterId || invite.inviterId === this.props.userId || this.isVoiceInviteExpired(invite)) {
                    return;
                }
                this.clearVoiceInviteExpiryTimer();
                playVoiceRoomInviteSound();
                this.setState({
                    incomingVoiceInvite: invite,
                    voiceInviteResponsePending: false,
                    voiceInviteResponseError: '',
                });
                this.voiceInviteExpiryTimer = setTimeout(() => {
                    this.voiceInviteExpiryTimer = null;
                    if (!this.isUnmounted && this.state.incomingVoiceInvite === invite) {
                        this.setState({
                            incomingVoiceInvite: null,
                            voiceInviteResponsePending: false,
                            voiceInviteResponseError: '',
                        });
                    }
                }, Number(invite.expiresAt) - Date.now());
            });
        }
        if (!this.unsubscribeVoiceInviteDecisions) {
            this.unsubscribeVoiceInviteDecisions = subscribeVoiceInviteDecisions((result) => this.applyVoiceInviteDecision(result));
        }
    }

    stopVoiceInviteEvents() {
        this.clearVoiceInviteExpiryTimer();
        if (this.unsubscribeVoiceInvites) {
            this.unsubscribeVoiceInvites();
            this.unsubscribeVoiceInvites = null;
        }
        if (this.unsubscribeVoiceInviteDecisions) {
            this.unsubscribeVoiceInviteDecisions();
            this.unsubscribeVoiceInviteDecisions = null;
        }
    }

    clearVoiceInviteExpiryTimer() {
        if (this.voiceInviteExpiryTimer) {
            clearTimeout(this.voiceInviteExpiryTimer);
            this.voiceInviteExpiryTimer = null;
        }
    }

    isVoiceInviteExpired(invite) {
        const expiresAt = Number(invite && invite.expiresAt);
        return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
    }

    voiceInviteDisplayName(invite) {
        return userDisplayName({
            first_name: invite.inviterFirstName,
            last_name: invite.inviterLastName,
            username: invite.inviterUsername,
        }) || 'Someone';
    }

    eligibleInviteUsers() {
        const {
            channelList,
            inviteSearch,
            inviteSearchHasRun,
            inviteSearchResults,
            activeRoom,
        } = this.state;
        const source = inviteSearchHasRun ? inviteSearchResults : (this.props.profiles || []);
        const targetRoom = activeRoom && channelList.find((room) => room.roomId === activeRoom.roomId);
        const targetRoomUserIDs = new Set(((targetRoom && targetRoom.participants) || []).map((participant) => participant.id));

        const query = inviteSearch.trim().toLowerCase();
        const seen = new Set();
        return source.filter((user) => {
            if (!user || !user.id || seen.has(user.id)) {
                return false;
            }
            seen.add(user.id);
            if (user.id === this.props.userId || user.delete_at || user.is_bot || targetRoomUserIDs.has(user.id)) {
                return false;
            }
            if (!query) {
                return true;
            }
            return userDisplayName(user).toLowerCase().includes(query) || (user.username || '').toLowerCase().includes(query);
        }).sort((a, b) => userDisplayName(a).localeCompare(userDisplayName(b), 'en', {sensitivity: 'base'}));
    }

    handleToggleInvitePicker = (e) => {
        if (e && e.preventDefault) {
            e.preventDefault();
        }
        if (e && e.stopPropagation) {
            e.stopPropagation();
        }
        if (!this.state.activeRoom) {
            return;
        }
        if (this.state.showInvitePicker) {
            this.closeInvitePicker();
            return;
        }
        this.inviteSearchRequestId += 1;
        this.setState({
            showInvitePicker: true,
            inviteSearch: '',
            inviteSearchResults: [],
            inviteSearchHasRun: false,
            inviteSearchPending: false,
            inviteError: '',
            inviteStatus: '',
            openRoomMenuId: null,
        });
    };

    closeInvitePicker() {
        this.inviteSearchRequestId += 1;
        this.setState({
            showInvitePicker: false,
            inviteSearch: '',
            inviteSearchResults: [],
            inviteSearchHasRun: false,
            inviteSearchPending: false,
            inviteError: '',
            inviteStatus: '',
            invitingUserId: null,
        });
    }

    handleCloseInvitePicker = (e) => {
        if (e && e.preventDefault) {
            e.preventDefault();
        }
        if (e && e.stopPropagation) {
            e.stopPropagation();
        }
        this.closeInvitePicker();
    };

    handleInvitePickerOutsideClick = (e) => {
        const target = e && e.target;
        const picker = this.invitePickerRef.current;
        const inviteButton = this.inviteButtonRef.current;
        if (!this.state.showInvitePicker || !target || (picker && picker.contains(target)) || (inviteButton && inviteButton.contains(target))) {
            return;
        }
        this.closeInvitePicker();
    };

    syncInvitePickerOutsideListener() {
        if (this.state.showInvitePicker && !this.invitePickerOutsideListening) {
            document.addEventListener('mousedown', this.handleInvitePickerOutsideClick);
            this.invitePickerOutsideListening = true;
        } else if (!this.state.showInvitePicker && this.invitePickerOutsideListening) {
            this.removeInvitePickerOutsideListener();
        }
    }

    removeInvitePickerOutsideListener() {
        if (!this.invitePickerOutsideListening) {
            return;
        }
        document.removeEventListener('mousedown', this.handleInvitePickerOutsideClick);
        this.invitePickerOutsideListening = false;
    }

    handleInviteSearchChange = (e) => {
        const inviteSearch = e.target.value;
        const term = inviteSearch.trim();
        const requestId = ++this.inviteSearchRequestId;
        this.setState({
            inviteSearch,
            inviteSearchResults: [],
            inviteSearchHasRun: false,
            inviteSearchPending: term.length >= 2,
            inviteError: '',
        });

        if (term.length < 2) {
            return;
        }
        searchVoiceInviteUsers(term).
            then((users) => {
                if (this.isUnmounted || requestId !== this.inviteSearchRequestId) {
                    return;
                }
                this.setState({
                    inviteSearchResults: users,
                    inviteSearchHasRun: true,
                    inviteSearchPending: false,
                });
            }).
            catch((error) => {
                if (this.isUnmounted || requestId !== this.inviteSearchRequestId) {
                    return;
                }
                debug('voice invite user search failed', error);
                this.setState({
                    inviteSearchResults: [],
                    inviteSearchHasRun: true,
                    inviteSearchPending: false,
                    inviteError: 'Could not search for users.',
                });
            });
    };

    handleSendVoiceInvite = (user) => (e) => {
        if (e && e.preventDefault) {
            e.preventDefault();
        }
        const {activeRoom} = this.state;
        if (!activeRoom || !user || !user.id) {
            return null;
        }

        this.setState({invitingUserId: user.id, inviteError: '', inviteStatus: ''});
        return sendVoiceRoomInvite(activeRoom.roomId, user.id).
            then(() => {
                if (!this.isUnmounted) {
                    const name = userDisplayName(user) || user.username || 'user';
                    this.setState({
                        invitingUserId: null,
                        inviteStatus: `Invitation sent to ${name}.`,
                    });
                }
            }).
            catch((error) => {
                if (this.isUnmounted) {
                    return;
                }
                const unavailable = error && error.response && error.response.status === 409;
                this.setState({
                    invitingUserId: null,
                    inviteError: unavailable ? 'That user has already joined this voice channel.' : 'Could not send the invitation.',
                });
                if (unavailable) {
                    this.refreshRooms();
                }
            });
    };

    submitVoiceInviteDecision(decision, e) {
        if (e && e.preventDefault) {
            e.preventDefault();
        }
        const {incomingVoiceInvite} = this.state;
        if (!incomingVoiceInvite) {
            return null;
        }
        if (this.isVoiceInviteExpired(incomingVoiceInvite)) {
            this.clearVoiceInviteExpiryTimer();
            this.setState({incomingVoiceInvite: null});
            return null;
        }

        this.setState({voiceInviteResponsePending: true, voiceInviteResponseError: ''});
        return respondVoiceRoomInvite(incomingVoiceInvite.postId, incomingVoiceInvite.inviteId, decision).
            then(() => {
                if (!this.isUnmounted) {
                    this.applyVoiceInviteDecision({invite: incomingVoiceInvite, decision});
                }
            }).
            catch((error) => {
                if (this.isUnmounted) {
                    return;
                }
                const unavailable = error && error.response && (error.response.status === 409 || error.response.status === 410);
                if (unavailable) {
                    this.clearVoiceInviteExpiryTimer();
                    this.setState({incomingVoiceInvite: null, voiceInviteResponsePending: false});
                    return;
                }
                this.setState({
                    voiceInviteResponsePending: false,
                    voiceInviteResponseError: 'Could not answer this invitation.',
                });
            });
    }

    applyVoiceInviteDecision(result) {
        const invite = result && result.invite;
        const decision = result && result.decision;
        if (!invite || !invite.inviteId) {
            return;
        }

        const current = this.state.incomingVoiceInvite;
        if (current && current.inviteId === invite.inviteId) {
            this.clearVoiceInviteExpiryTimer();
            this.setState({
                incomingVoiceInvite: null,
                voiceInviteResponsePending: false,
                voiceInviteResponseError: '',
            });
        }
        if (decision === VOICE_INVITE_ACCEPTED) {
            this.handleJoinRoom(invite.roomId, invite.roomName)(null);
        }
    }

    handleAcceptVoiceInvite = (e) => this.submitVoiceInviteDecision(VOICE_INVITE_ACCEPTED, e);

    handleDismissVoiceInvite = (e) => this.submitVoiceInviteDecision(VOICE_INVITE_DECLINED, e);

    handlePresenceSound(change) {
        const {activeRoom} = this.state;
        const activeRoomID = activeRoom ? activeRoom.roomId : '';
        const joinedRoomID = change.roomId && change.roomId !== change.previousRoomId ? change.roomId : '';
        const leftRoomID = change.previousRoomId && change.previousRoomId !== change.roomId ? change.previousRoomId : '';

        if (joinedRoomID && activeRoomID === joinedRoomID) {
            playVoiceRoomJoinSound();
        }
        if (leftRoomID && activeRoomID === leftRoomID) {
            playVoiceRoomLeaveSound();
        }
    }

    handleExclusivePresenceChange(change) {
        const {activeRoom} = this.state;
        const movedFromThisRoom = change.userId === this.props.userId &&
            activeRoom &&
            change.previousRoomId === activeRoom.roomId &&
            change.roomId !== activeRoom.roomId;

        // Presence is keyed by user on the server. If another tab moves this
        // user, stop this tab's heartbeat and media so it cannot move the user
        // back or remain connected to two WebRTC swarms.
        if (movedFromThisRoom) {
            this.disconnectLocalRoom();
        }
    }

    bootstrapDirectory() {
        if (this.directoryPoll) {
            return;
        }
        this.refreshRooms();
        this.directoryPoll = setInterval(() => this.refreshRooms(), DIRECTORY_POLL_MS);
    }

    stopDirectory() {
        if (this.directoryPoll) {
            clearInterval(this.directoryPoll);
            this.directoryPoll = null;
        }
    }

    announcePresence(roomId) {
        const microphoneOn = Boolean(this.state.audioOn && this.state.audioEnabled);
        return sendVoicePresence(roomId, microphoneOn).
            then((rooms) => this.applyRooms(rooms)).
            catch((err) => debug('voice presence heartbeat failed', err));
    }

    /**
     * Keep saying we are here. The server expires an entry that stops being
     * refreshed, which is what covers a browser that closes without leaving.
     */
    startPresence(roomId) {
        this.stopPresence();
        this.announcePresence(roomId);
        this.presenceHeartbeat = setInterval(() => this.announcePresence(roomId), PRESENCE_HEARTBEAT_MS);
    }

    stopPresence() {
        if (this.presenceHeartbeat) {
            clearInterval(this.presenceHeartbeat);
            this.presenceHeartbeat = null;
        }
    }

    clearPresence() {
        this.stopPresence();

        // Do not wait for the next directory poll: the endpoint returns the
        // refreshed room list, so apply it as soon as the departure lands.
        return sendVoicePresence('', false).
            then((rooms) => this.applyRooms(rooms)).
            catch((err) => debug('clearing voice presence failed', err));
    }

    /**
     * The one place a roster is drawn, so the list you see from outside a room
     * and the list you see inside it cannot drift apart.
     */
    renderRoster(entries) {
        const style = getStyle();

        if (entries.length === 0) {
            return null;
        }

        return (
            <ul style={style.list}>
                {entries.map((entry) => (
                    <li
                        key={entry.key}
                        style={style.listItem}
                    >
                        <i
                            className='icon fa fa-circle'
                            style={style.online}
                            aria-hidden='true'
                        />
                        <span style={style.rosterName}>{entry.name}</span>
                        {typeof entry.audioOn === 'boolean' && (
                            <i
                                className={entry.audioOn ? 'icon fa fa-microphone' : 'icon fa fa-microphone-slash'}
                                style={entry.audioOn ? style.rosterMic : {...style.rosterMic, ...style.rosterMicOff}}
                                title={entry.audioOn ? `${entry.name}'s microphone is enabled` : `${entry.name}'s microphone is disabled`}
                                aria-label={entry.audioOn ? `${entry.name}'s microphone is enabled` : `${entry.name}'s microphone is disabled`}
                            />
                        )}
                    </li>
                ))}
            </ul>
        );
    }

    /**
     * Who is in a room, for someone who is not. Names come from the local
     * profile store when it has them and from the server otherwise — a viewer
     * who never opened the room will not have those profiles loaded.
     */
    renderOccupants(room) {
        const {profilesById} = this.props;
        const participants = room.participants || [];

        return this.renderRoster(participants.map((entry) => ({
            key: entry.id,
            name: userDisplayName((profilesById || {})[entry.id]) ||
                userDisplayName({first_name: entry.firstName, last_name: entry.lastName, username: entry.username}) ||
                'Unknown user',
            audioOn: entry.audioOn !== false,
        })));
    }

    canDeleteRoom(room) {
        const {userId, isSystemAdmin} = this.props;

        // Mirrors what the server enforces; rooms created before the directory
        // moved server-side carry no creatorId, so nobody but an admin owns them.
        return Boolean(isSystemAdmin || (room.creatorId && room.creatorId === userId));
    }

    handleRoomRowEnter = (roomId) => () => {
        this.setState({hoveredRoomId: roomId});
    };

    handleRoomRowLeave = (roomId) => () => {
        this.setState((state) => ({
            hoveredRoomId: state.hoveredRoomId === roomId ? null : state.hoveredRoomId,
            openRoomMenuId: state.openRoomMenuId === roomId ? null : state.openRoomMenuId,
        }));
    };

    handleRoomRowBlur = (roomId) => (e) => {
        if (e.currentTarget.contains(e.relatedTarget)) {
            return;
        }
        this.handleRoomRowLeave(roomId)();
    };

    handleToggleRoomMenu = (roomId) => (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setState((state) => ({
            openRoomMenuId: state.openRoomMenuId === roomId ? null : roomId,
            showInvitePicker: false,
        }));
    };

    handleDeleteRoomFromMenu = (roomId) => (e) => {
        this.setState({openRoomMenuId: null});
        this.handleDeleteRoom(roomId)(e);
    };

    handleDeleteRoom = (roomId) => (e) => {
        if (e && e.preventDefault) {
            e.preventDefault();
        }
        if (e && e.stopPropagation) {
            e.stopPropagation();
        }
        const {activeRoom} = this.state;
        const finalize = () => {
            deleteVoiceRoom(roomId).
                then((rooms) => this.applyRooms(rooms)).
                catch((err) => {
                    const forbidden = err && err.response && err.response.status === 403;
                    const message = forbidden ? 'Only whoever created a voice channel can delete it.' : 'Could not delete that voice channel.';
                    this.reportDirectoryError(message, err);
                });
        };
        if (activeRoom && activeRoom.roomId === roomId) {
            this.leaveRoomInternal(finalize);
        } else {
            finalize();
        }
    };

    cleanupConnection(done) {
        const onFinished = typeof done === 'function' ? done : function noopCallback() {
            /* optional async completion */
        };
        let finished = false;
        let closeFallback = null;
        const finish = () => {
            if (finished) {
                return;
            }
            finished = true;
            if (closeFallback) {
                clearTimeout(closeFallback);
                closeFallback = null;
            }
            onFinished();
        };

        Object.values(this.state.playBacks || {}).forEach((aud) => {
            try {
                aud.pause();
                aud.srcObject = null;
            } catch (e) {
                /* ignore */
            }
        });

        if (this.currentMyStream) {
            try {
                this.currentMyStream.getTracks().forEach((t) => t.stop());
            } catch (e) {
                /* ignore */
            }
            this.currentMyStream = null;
        }

        if (this.swarmInstance) {
            const sw = this.swarmInstance;
            this.swarmInstance = null;

            closeFallback = setTimeout(() => {
                debug('voice swarm close timed out; continuing cleanup');
                finish();
            }, SWARM_CLOSE_TIMEOUT_MS);

            try {
                sw.close(finish);
            } catch (e) {
                debug('voice swarm close failed; continuing cleanup', e);
                finish();
            }
            return;
        }

        finish();
    }

    resetActiveRoomState() {
        if (!this.isUnmounted) {
            this.setState({
                activeRoom: null,
                initialized: false,
                swarmInitialized: false,
                peerStreams: {},
                playBacks: {},
                audioOn: false,
                speakerOn: false,
                showInvitePicker: false,
                inviteSearch: '',
                inviteSearchResults: [],
                inviteSearchHasRun: false,
                inviteSearchPending: false,
                inviteError: '',
                inviteStatus: '',
                invitingUserId: null,
            });
        }
    }

    disconnectLocalRoom() {
        this.roomTransitionId += 1;
        this.stopPresence();
        this.connectPending = true;

        const finish = () => {
            this.connectPending = false;
        };
        try {
            this.cleanupConnection(finish);
        } catch (e) {
            debug('voice connection cleanup failed', e);
            finish();
        } finally {
            this.resetActiveRoomState();
        }
    }

    leaveRoomInternal(cb) {
        this.roomTransitionId += 1;
        this.connectPending = false;

        if (this.state.activeRoom) {
            playVoiceRoomLeaveSound();
        }

        // Presence and local UI must change immediately. Closing a WebRTC swarm
        // is asynchronous and its callback may take long enough for the user to
        // believe they are still in the room.
        this.clearPresence();
        try {
            this.cleanupConnection(cb);
        } catch (e) {
            // Keep local departure independent from unexpected cleanup errors.
            debug('voice connection cleanup failed', e);
            if (typeof cb === 'function') {
                cb();
            }
        } finally {
            this.resetActiveRoomState();
        }
    }

    handleLeaveRoom = (e) => {
        if (e && e.preventDefault) {
            e.preventDefault();
        }
        this.leaveRoomInternal(() => {
            /* modal closed */
        });
    };

    handleJoinRoom = (roomId, name) => (e) => {
        if (e && e.preventDefault) {
            e.preventDefault();
        }
        const {activeRoom} = this.state;
        if (activeRoom && activeRoom.roomId === roomId) {
            return;
        }
        if (activeRoom) {
            playVoiceRoomLeaveSound();
        }

        const transitionId = ++this.roomTransitionId;
        this.stopPresence();
        this.connectPending = true;
        const finishJoin = () => {
            if (transitionId !== this.roomTransitionId) {
                return;
            }
            this.connectPending = false;
            if (this.isUnmounted) {
                return;
            }
            this.setState({
                activeRoom: {roomId, name},
                initialized: false,
                swarmInitialized: false,
                peerStreams: {},
                playBacks: {},
                audioOn: true,
                speakerOn: true,
                audioEnabled: true,
                videoEnabled: false,
                hoveredRoomId: null,
                openRoomMenuId: null,
                showInvitePicker: false,
                inviteSearch: '',
                inviteSearchResults: [],
                inviteSearchHasRun: false,
                inviteSearchPending: false,
                inviteError: '',
                inviteStatus: '',
                invitingUserId: null,
            }, () => {
                if (transitionId === this.roomTransitionId) {
                    this.startPresence(roomId);
                }
            });
        };

        try {
            // The next room is activated only after playback, media tracks,
            // and the previous WebRTC swarm have all been closed.
            this.cleanupConnection(finishJoin);
        } catch (error) {
            debug('voice connection cleanup failed while switching rooms', error);
            finishJoin();
        }
    };

    handleCreateChannel = (e) => {
        if (e && e.preventDefault) {
            e.preventDefault();
        }
        const name = (this.state.newChannelNameDraft || '').trim();
        if (!name) {
            return;
        }
        const roomId = genRoomId();

        createVoiceRoom(roomId, name).
            then((rooms) => {
                this.applyRooms(rooms);
                if (this.isUnmounted) {
                    return;
                }
                this.setState({
                    showCreateInput: false,
                    newChannelNameDraft: '',
                }, () => {
                    this.handleJoinRoom(roomId, name)();
                });
            }).
            catch((err) => this.reportDirectoryError('Could not create that voice channel.', err));
    };

    handleToggleCreate = (e) => {
        if (e && e.preventDefault) {
            e.preventDefault();
        }
        this.setState((p) => ({
            showCreateInput: !p.showCreateInput,
            newChannelNameDraft: p.showCreateInput ? '' : p.newChannelNameDraft,
        }));
    };

    async handleRequestPerms() {
        const {myStream, audioEnabled, videoEnabled} = await getMyStream();
        debug({audioEnabled, videoEnabled});
        this.currentMyStream = myStream;
        this.setState({initialized: true, myStream, audioEnabled, videoEnabled}, () => {
            if (this.state.activeRoom) {
                this.announcePresence(this.state.activeRoom.roomId);
            }
        });
    }

    connectToSwarm(userId) {
        const {activeRoom} = this.state;
        const {
            stunServer,
            turnServer,
            turnServerUsername,
            turnServerCredential,
            configLoaded,
            config,
        } = this.props;

        if (!configLoaded || !activeRoom || !config || !config.DiagnosticId) {
            return;
        }

        if (this.swarmInstance || this.connectPending) {
            return;
        }

        this.connectPending = true;

        const myUuid = this.props.userId;
        const myUsername = this.props.username;
        const myDisplayName = this.props.displayName;
        const voiceHubName = `mattermost-webrtc-video-${config.DiagnosticId}-voice-${activeRoom.roomId}`;
        debug('Voice hub', voiceHubName);
        const iceServers = buildIceServers(stunServer, turnServer, turnServerUsername, turnServerCredential);

        const hub = pluginSignalHub(voiceHubName);
        hub.subscribe('all').on('data', this.handleHubData.bind(this));

        const sw = swarm(
            hub,
            {
                config: {iceServers},
                uuid: myUuid,
                wrap: (outgoingSignalingData) => {
                    outgoingSignalingData.fromUserId = userId;
                    outgoingSignalingData.fromUsername = myUsername;
                    outgoingSignalingData.fromDisplayName = myDisplayName;
                    return outgoingSignalingData;
                },
            },
        );

        this.swarmInstance = sw;
        this.connectPending = false;

        sw.on('peer', this.handleConnect.bind(this));
        sw.on('disconnect', this.handleDisconnect.bind(this));

        hub.broadcast('all', {
            type: 'connect',
            from: myUuid,
            fromUserId: userId,
            fromUsername: myUsername,
            fromDisplayName: myDisplayName,
        });
    }

    handleHubData(message) {
        const {swarmInitialized, peerStreams} = this.state;
        const myUuid = this.props.userId;

        if (!swarmInitialized) {
            this.setState({swarmInitialized: true});
        }
        debug('HUB DATA', message);
        if (message.type === 'connect' && message.from !== myUuid) {
            if (!peerStreams[message.from] && message.fromUsername) {
                debug('connecting to', {uuid: message.from, userId: message.fromUserId, username: message.fromUsername});

                const newPeerStreams = Object.assign({}, peerStreams);
                newPeerStreams[message.from] = {
                    userId: message.fromUserId,
                    username: message.fromUsername,
                    displayName: message.fromDisplayName,
                };
                this.setState({peerStreams: newPeerStreams});

                setTimeout(() => {
                    this.setState((prev) => {
                        const ps = prev.peerStreams;
                        if (ps[message.from] && !ps[message.from].connected) {
                            const next = Object.assign({}, ps);
                            delete next[message.from];
                            return {peerStreams: next};
                        }
                        return null;
                    });
                }, 20000);
            }
        }
    }

    handleConnect(peer, id) {
        const {userId, audioOn, videoOn, audioEnabled, videoEnabled} = this.state;

        debug('connected to a new peer:', {id, peer});

        const peerStreams = Object.assign({}, this.state.peerStreams);
        const pkg = {
            peer,
            audioOn: true,
            videoOn: false,
        };
        peerStreams[id] = Object.assign({}, peerStreams[id], pkg);
        this.setState({peerStreams});

        peer.on('stream', (stream) => {
            const nextPeers = Object.assign({}, this.state.peerStreams);
            debug('received stream', stream);
            nextPeers[id].stream = stream;
            this.setState({peerStreams: nextPeers});
            const playBacks = Object.assign({}, this.state.playBacks);
            const aud = document.createElement('audio');
            aud.srcObject = stream;
            playBacks[id] = aud;
            aud.muted = !this.state.speakerOn;
            aud.play();
            this.setState({playBacks});
        });

        peer.on('data', (payload) => {
            const data = JSON.parse(payload.toString());

            debug('received data', {id, data});

            if (data.type === 'receivedHandshake') {
                if (this.currentMyStream) {
                    peer.addStream(this.currentMyStream);
                }

                if (!audioOn || !audioEnabled) {
                    peer.send(JSON.stringify({type: 'audioToggle', enabled: false}));
                }
                if (!videoOn || !videoEnabled) {
                    peer.send(JSON.stringify({type: 'videoToggle', enabled: false}));
                }
            }

            if (data.type === 'sendHandshake') {
                const ps = Object.assign({}, this.state.peerStreams);
                ps[id].userId = data.userId;
                ps[id].connected = true;
                peer.send(JSON.stringify({type: 'receivedHandshake'}));
                this.setState({peerStreams: ps});
            }

            if (data.type === 'audioToggle') {
                const ps = Object.assign({}, this.state.peerStreams);
                ps[id].audioOn = data.enabled;
                this.setState({peerStreams: ps});
            }

            if (data.type === 'videoToggle') {
                const ps = Object.assign({}, this.state.peerStreams);
                ps[id].videoOn = data.enabled;
                this.setState({peerStreams: ps});
            }
        });

        peer.send(JSON.stringify({
            type: 'sendHandshake',
            userId,
        }));
    }

    handleDisconnect(peer, id) {
        debug('disconnected from a peer:', peer, id);

        const peerStreams = Object.assign({}, this.state.peerStreams);

        if (peerStreams[id]) {
            delete peerStreams[id];
            this.setState({peerStreams});
        }
    }

    updateMicrophoneTransmission(enabled) {
        const {peerStreams} = this.state;
        if (this.currentMyStream) {
            const tracks = this.currentMyStream.getAudioTracks();
            if (tracks[0]) {
                tracks[0].enabled = enabled;
            }
        }

        for (const pid of Object.keys(peerStreams)) {
            const peerStream = peerStreams[pid];
            if (peerStream.connected && peerStream.peer) {
                peerStream.peer.send(JSON.stringify({type: 'audioToggle', enabled}));
            }
        }
    }

    handleAudioToggle() {
        const microphoneOn = !this.state.audioOn;
        this.updateMicrophoneTransmission(microphoneOn);
        this.setState({audioOn: microphoneOn}, () => {
            if (this.state.activeRoom) {
                this.announcePresence(this.state.activeRoom.roomId);
            }
        });
    }

    handleSpeakerToggle() {
        debug('Handle Speaker Toggle');
        const {playBacks, speakerOn, audioOn} = this.state;
        const speakerWillBeOn = !speakerOn;
        const microphoneWillBeDisabled = speakerOn && audioOn;

        for (const id of Object.keys(playBacks)) {
            const aud = playBacks[id];
            aud.muted = !speakerWillBeOn;
            debug(id, 'Speaker On', speakerWillBeOn);
        }

        if (microphoneWillBeDisabled) {
            this.updateMicrophoneTransmission(false);
        }

        this.setState({
            speakerOn: speakerWillBeOn,
            ...(microphoneWillBeDisabled ? {audioOn: false} : {}),
        }, () => {
            if (microphoneWillBeDisabled && this.state.activeRoom) {
                this.announcePresence(this.state.activeRoom.roomId);
            }
        });
    }

    renderVoiceControls() {
        const {audioOn, speakerOn} = this.state;
        const style = getStyle();

        return (
            <span style={style.voiceControls}>
                <button
                    type='button'
                    style={style.voiceControlButton}
                    onClick={this.handleAudioToggle.bind(this)}
                    title={audioOn ? 'Disable microphone' : 'Enable microphone'}
                    aria-label={audioOn ? 'Disable microphone' : 'Enable microphone'}
                >
                    <i
                        className={audioOn ? 'icon fa fa-microphone fa-lg' : 'icon fa fa-microphone-slash fa-lg'}
                        aria-hidden='true'
                    />
                </button>
                <button
                    type='button'
                    style={style.voiceControlButton}
                    onClick={this.handleSpeakerToggle.bind(this)}
                    title={speakerOn ? 'Disable voice channel audio' : 'Enable voice channel audio'}
                    aria-label={speakerOn ? 'Disable voice channel audio' : 'Enable voice channel audio'}
                >
                    <span style={style.headphonesIcon}>
                        <i
                            className='icon fa fa-headphones fa-lg'
                            aria-hidden='true'
                        />
                        {!speakerOn && (
                            <span
                                className='voice-channel-headphones-slash'
                                style={style.headphonesSlash}
                                aria-hidden='true'
                            />
                        )}
                    </span>
                </button>
            </span>
        );
    }

    renderActiveRoom(room, connectionHint, selfName) {
        const {
            audioOn,
            audioEnabled,
            swarmInitialized,
            peerStreams,
            hoveredRoomId,
            openRoomMenuId,
            showInvitePicker,
            inviteSearch,
            inviteSearchPending,
            inviteError,
            inviteStatus,
            invitingUserId,
        } = this.state;
        const style = getStyle();
        const eligibleUsers = this.eligibleInviteUsers();

        return (
            <li
                key={room.roomId}
                style={style.activeRoomRow}
                onMouseEnter={this.handleRoomRowEnter(room.roomId)}
                onMouseLeave={this.handleRoomRowLeave(room.roomId)}
                onFocus={this.handleRoomRowEnter(room.roomId)}
                onBlur={this.handleRoomRowBlur(room.roomId)}
            >
                <div style={{...style.inRoomHeader, ...style.inRoomHeaderInList}}>
                    <span
                        style={style.inRoomIdentity}
                        role='group'
                        aria-label={`Voice channel ${room.name} controls`}
                    >
                        <span style={style.inRoomTitle}>
                            <i
                                className='icon fa fa-volume-up'
                                style={style.roomIcon}
                                aria-hidden='true'
                            />
                            <span style={style.roomTitleText}>{room.name}</span>
                        </span>
                        {this.renderVoiceControls()}
                    </span>
                    <span style={style.inRoomHeaderActions}>
                        <button
                            ref={this.inviteButtonRef}
                            type='button'
                            style={{...style.voiceControlButton, ...style.inviteButton}}
                            onClick={this.handleToggleInvitePicker}
                            title='Invite a user to this voice channel'
                            aria-label={`Invite users to voice channel ${room.name}`}
                            aria-haspopup='dialog'
                            aria-expanded={showInvitePicker}
                        >
                            <i
                                className='icon fa fa-user-plus'
                                aria-hidden='true'
                            />
                        </button>
                        {this.canDeleteRoom(room) && (
                            <span style={style.roomActions}>
                                <button
                                    type='button'
                                    style={hoveredRoomId === room.roomId || openRoomMenuId === room.roomId ? style.roomSettingsBtn : {...style.roomSettingsBtn, ...style.roomSettingsBtnHidden}}
                                    title='Voice channel settings'
                                    aria-label={`Voice channel settings for ${room.name}`}
                                    aria-haspopup='menu'
                                    aria-expanded={openRoomMenuId === room.roomId}
                                    aria-hidden={hoveredRoomId !== room.roomId && openRoomMenuId !== room.roomId}
                                    tabIndex={hoveredRoomId === room.roomId || openRoomMenuId === room.roomId ? 0 : -1}
                                    onClick={this.handleToggleRoomMenu(room.roomId)}
                                >
                                    <i
                                        className='icon fa fa-cog'
                                        aria-hidden='true'
                                    />
                                </button>
                                {openRoomMenuId === room.roomId && (
                                    <div
                                        id={`voice-room-menu-${room.roomId}`}
                                        role='menu'
                                        style={style.roomMenu}
                                    >
                                        <button
                                            type='button'
                                            role='menuitem'
                                            style={style.deleteMenuItem}
                                            onClick={this.handleDeleteRoomFromMenu(room.roomId)}
                                        >
                                            {'Delete'}
                                        </button>
                                    </div>
                                )}
                            </span>
                        )}
                        <button
                            type='button'
                            style={style.hangupBtn}
                            onClick={this.handleLeaveRoom}
                            title='Leave voice channel'
                            aria-label='Leave voice channel'
                        >
                            <i
                                className='fa fa-phone'
                                style={style.hangupIcon}
                                aria-hidden='true'
                            />
                        </button>
                    </span>
                </div>
                {showInvitePicker && (
                    <div
                        ref={this.invitePickerRef}
                        role='dialog'
                        aria-label={`Invite a user to ${room.name}`}
                        style={style.invitePicker}
                    >
                        <div style={style.inviteHeader}>
                            <strong style={style.inviteTitle}>{`Invite to ${room.name}`}</strong>
                            <button
                                type='button'
                                style={style.inviteCloseButton}
                                onClick={this.handleCloseInvitePicker}
                                title='Close invitation picker'
                                aria-label='Close invitation picker'
                            >
                                <i
                                    className='icon fa fa-times'
                                    aria-hidden='true'
                                />
                            </button>
                        </div>
                        <input
                            type='search'
                            autoFocus={true}
                            value={inviteSearch}
                            onChange={this.handleInviteSearchChange}
                            placeholder='Search by name or username...'
                            aria-label='Search users to invite'
                            style={style.inviteSearchInput}
                        />
                        {inviteSearchPending ? (
                            <div style={style.inviteEmpty}>{'Searching...'}</div>
                        ) : (
                            <>
                                {eligibleUsers.length === 0 ? (
                                    <div style={style.inviteEmpty}>
                                        {inviteSearch.trim().length < 2 ? 'Type at least two characters to search for more users.' : 'No available users found.'}
                                    </div>
                                ) : (
                                    <ul style={style.inviteUserList}>
                                        {eligibleUsers.map((user) => {
                                            const displayName = userDisplayName(user) || user.username;
                                            const isSending = invitingUserId === user.id;
                                            return (
                                                <li
                                                    key={user.id}
                                                    style={style.inviteUserRow}
                                                >
                                                    <span style={style.inviteUserIdentity}>
                                                        <strong>{displayName}</strong>
                                                        <span style={style.inviteUsername}>{`@${user.username}`}</span>
                                                    </span>
                                                    <button
                                                        type='button'
                                                        style={invitingUserId ? {...style.inviteUserIconButton, ...style.inviteUserButtonDisabled} : style.inviteUserIconButton}
                                                        onClick={this.handleSendVoiceInvite(user)}
                                                        disabled={Boolean(invitingUserId)}
                                                        title={`Invite ${displayName}`}
                                                        aria-label={`Invite ${displayName} to ${room.name}`}
                                                    >
                                                        <i
                                                            className={isSending ? 'icon fa fa-spinner fa-spin' : 'icon fa fa-paper-plane'}
                                                            aria-hidden='true'
                                                        />
                                                    </button>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                )}
                            </>
                        )}
                        {inviteError && <div style={style.inviteError}>{inviteError}</div>}
                        {inviteStatus && <div style={style.inviteStatus}>{inviteStatus}</div>}
                    </div>
                )}
                {connectionHint && <p style={{...style.hint, ...style.hintInList}}>{connectionHint}</p>}
                {this.renderRoster([
                    ...(swarmInitialized ? [{key: 'self', name: selfName, audioOn: Boolean(audioOn && audioEnabled)}] : []),
                    ...Object.keys(peerStreams).map((id) => ({
                        key: id,
                        name: this.peerDisplayName(id, peerStreams[id]),
                        audioOn: peerStreams[id].audioOn !== false,
                    })),
                ])}
            </li>
        );
    }

    render() {
        const {
            userId,
            initialized,
            swarmInitialized,
            audioOn,
            audioEnabled,
            activeRoom,
            channelList,
            directoryError,
            showCreateInput,
            newChannelNameDraft,
            hoveredRoomId,
            openRoomMenuId,
            showInvitePicker,
            incomingVoiceInvite,
            voiceInviteResponsePending,
            voiceInviteResponseError,
        } = this.state;
        const style = getStyle();

        debug('Render', userId, initialized, swarmInitialized, this.state, this.props);

        const {isSystemAdmin} = this.props;
        const selfName = this.props.displayName || 'You';
        const activeRoomListed = activeRoom && channelList.some((room) => room.roomId === activeRoom.roomId);
        const visibleRooms = activeRoom && !activeRoomListed ? [...channelList, activeRoom] : channelList;

        let connectionHint = '';
        if (!swarmInitialized) {
            connectionHint = initialized && !audioEnabled ? 'No microphone available — you can listen, but not speak.' : 'Connecting…';
        }

        if (activeRoom && audioOn && !initialized) {
            this.handleRequestPerms();
        }

        if (activeRoom && initialized && !swarmInitialized && !this.connectPending && !this.swarmInstance) {
            this.connectToSwarm(userId);
        }

        return (
            <div style={style.container}>
                <div style={style.section}>
                    <div style={style.sectionHeader}>
                        <span style={style.sectionTitle}>{'Voice channels'}</span>
                        {isSystemAdmin && (
                            <button
                                type='button'
                                style={style.linkBtn}
                                onClick={this.handleToggleCreate}
                            >
                                {showCreateInput ? 'Cancel' : '+ New'}
                            </button>
                        )}
                    </div>

                    {incomingVoiceInvite && (
                        <div
                            role='alert'
                            style={style.incomingInvite}
                        >
                            <div style={style.incomingInviteText}>
                                <strong>{this.voiceInviteDisplayName(incomingVoiceInvite)}</strong>
                                {` invited you to join ${incomingVoiceInvite.roomName}.`}
                            </div>
                            <div style={style.incomingInviteActions}>
                                <button
                                    type='button'
                                    style={style.acceptInviteButton}
                                    onClick={this.handleAcceptVoiceInvite}
                                    disabled={voiceInviteResponsePending}
                                >
                                    {'Join'}
                                </button>
                                <button
                                    type='button'
                                    style={style.dismissInviteButton}
                                    onClick={this.handleDismissVoiceInvite}
                                    disabled={voiceInviteResponsePending}
                                >
                                    {'Dismiss'}
                                </button>
                            </div>
                            {voiceInviteResponseError && <div style={style.inviteError}>{voiceInviteResponseError}</div>}
                        </div>
                    )}

                    {Array.isArray(channelList) && (
                        <>
                            {isSystemAdmin && showCreateInput && (
                                <div style={style.createBox}>
                                    <label
                                        htmlFor='webrtc-voice-channel-name'
                                        style={style.label}
                                    >
                                        {'Name this voice channel'}
                                    </label>
                                    <input
                                        id='webrtc-voice-channel-name'
                                        type='text'
                                        style={style.input}
                                        placeholder='e.g. Standup, Sprint planning…'
                                        value={newChannelNameDraft}
                                        onChange={(ev) => this.setState({newChannelNameDraft: ev.target.value})}
                                        onKeyDown={(ev) => {
                                            if (ev.key === 'Enter') {
                                                this.handleCreateChannel(ev);
                                            }
                                        }}
                                    />
                                    <button
                                        type='button'
                                        style={style.primaryBtn}
                                        onClick={this.handleCreateChannel}
                                    >
                                        {'Create and join'}
                                    </button>
                                </div>
                            )}
                            {directoryError && (
                                <div style={style.roomHint}>{directoryError}</div>
                            )}
                            <ul style={openRoomMenuId || showInvitePicker ? {...style.roomList, ...style.roomListMenuOpen} : style.roomList}>
                                {visibleRooms.length === 0 && !showCreateInput && (
                                    <li style={style.roomHint}>
                                        {isSystemAdmin ? 'No channels yet — create one and everyone on this server will see it.' : 'No voice channels yet. A system administrator can create one.'}
                                    </li>
                                )}
                                {visibleRooms.map((r) => (activeRoom && r.roomId === activeRoom.roomId ? this.renderActiveRoom(r, connectionHint, selfName) : (
                                    <li
                                        key={r.roomId}
                                        style={style.roomRow}
                                        onMouseEnter={this.handleRoomRowEnter(r.roomId)}
                                        onMouseLeave={this.handleRoomRowLeave(r.roomId)}
                                        onFocus={this.handleRoomRowEnter(r.roomId)}
                                        onBlur={this.handleRoomRowBlur(r.roomId)}
                                    >
                                        <button
                                            type='button'
                                            style={style.roomName}
                                            title={`Join voice channel ${r.name}`}
                                            aria-label={`Join voice channel ${r.name}`}
                                            onClick={this.handleJoinRoom(r.roomId, r.name)}
                                        >
                                            <span style={style.roomTitle}>
                                                <i
                                                    className='icon fa fa-volume-up'
                                                    style={style.roomIcon}
                                                    aria-hidden='true'
                                                />
                                                <span style={style.roomTitleText}>{r.name}</span>
                                            </span>
                                            {this.renderOccupants(r)}
                                        </button>
                                        {this.canDeleteRoom(r) && (
                                            <span style={style.roomActions}>
                                                <button
                                                    type='button'
                                                    style={hoveredRoomId === r.roomId || openRoomMenuId === r.roomId ? style.roomSettingsBtn : {...style.roomSettingsBtn, ...style.roomSettingsBtnHidden}}
                                                    title='Voice channel settings'
                                                    aria-label={`Voice channel settings for ${r.name}`}
                                                    aria-haspopup='menu'
                                                    aria-expanded={openRoomMenuId === r.roomId}
                                                    aria-hidden={hoveredRoomId !== r.roomId && openRoomMenuId !== r.roomId}
                                                    tabIndex={hoveredRoomId === r.roomId || openRoomMenuId === r.roomId ? 0 : -1}
                                                    onClick={this.handleToggleRoomMenu(r.roomId)}
                                                >
                                                    <i
                                                        className='icon fa fa-cog'
                                                        aria-hidden='true'
                                                    />
                                                </button>
                                                {openRoomMenuId === r.roomId && (
                                                    <div
                                                        id={`voice-room-menu-${r.roomId}`}
                                                        role='menu'
                                                        style={style.roomMenu}
                                                    >
                                                        <button
                                                            type='button'
                                                            role='menuitem'
                                                            style={style.deleteMenuItem}
                                                            onClick={this.handleDeleteRoomFromMenu(r.roomId)}
                                                        >
                                                            {'Delete'}
                                                        </button>
                                                    </div>
                                                )}
                                            </span>
                                        )}
                                    </li>
                                )))}
                            </ul>
                        </>
                    )}

                </div>
            </div>
        );
    }
}

const mapStateToProps = (state) => {
    const currentUser = getCurrentUser(state) || {};
    const roles = currentUser.roles || '';
    const profiles = getProfiles(state);
    const {configLoaded, stunServer, turnServer, turnServerUsername, turnServerCredential} = state[`plugins-${pluginId}`] || {};
    const config = getConfig(state);

    const profilesById = {};
    for (const profile of profiles) {
        if (profile && profile.id) {
            profilesById[profile.id] = profile;
        }
    }

    return {
        userId: currentUser.id || '',
        username: currentUser.username || '',
        displayName: userDisplayName(currentUser),
        isSystemAdmin: roles.split(' ').includes('system_admin'),
        currentUser,
        profiles,
        profilesById,
        configLoaded,
        stunServer,
        turnServer,
        turnServerUsername,
        turnServerCredential,
        config,
    };
};

export default connect(mapStateToProps)(AudioCallPanel);

const getStyle = () => ({
    container: {
        padding: '4px 0 8px',
    },
    section: {
        marginTop: 4,
    },
    sectionHeader: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 10px 6px',
    },
    sectionTitle: {
        fontSize: '0.78em',
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        color: 'rgba(255,255,255,0.65)',
    },
    incomingInvite: {
        margin: '0 10px 8px',
        padding: '9px 10px',
        border: '1px solid rgba(91,156,248,0.45)',
        borderRadius: 4,
        background: 'rgba(91,156,248,0.14)',
        color: '#fff',
    },
    incomingInviteText: {
        fontSize: '0.86em',
        lineHeight: 1.35,
    },
    incomingInviteActions: {
        display: 'flex',
        gap: 6,
        marginTop: 8,
    },
    acceptInviteButton: {
        padding: '5px 10px',
        border: 'none',
        borderRadius: 4,
        background: '#166de0',
        color: '#fff',
        cursor: 'pointer',
        fontWeight: 600,
        fontFamily: 'inherit',
    },
    dismissInviteButton: {
        padding: '5px 10px',
        border: '1px solid rgba(255,255,255,0.2)',
        borderRadius: 4,
        background: 'transparent',
        color: 'rgba(255,255,255,0.85)',
        cursor: 'pointer',
        fontFamily: 'inherit',
    },
    linkBtn: {
        border: 'none',
        background: 'transparent',
        color: '#5b9cf8',
        cursor: 'pointer',
        fontSize: '0.85em',
        fontWeight: 600,
        padding: '2px 4px',
        fontFamily: 'inherit',
    },
    createBox: {
        padding: '0 10px 10px',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        marginBottom: 8,
    },
    label: {
        display: 'block',
        fontSize: '0.82em',
        color: 'rgba(255,255,255,0.85)',
        marginBottom: 6,
        fontWeight: 500,
    },
    input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 10px',
        borderRadius: 4,
        border: '1px solid rgba(255,255,255,0.2)',
        background: 'rgba(0,0,0,0.25)',
        color: '#fff',
        fontSize: '0.9em',
        marginBottom: 8,
        fontFamily: 'inherit',
    },
    primaryBtn: {
        width: '100%',
        padding: '8px 12px',
        borderRadius: 4,
        border: 'none',
        background: '#166de0',
        color: '#fff',
        fontWeight: 600,
        cursor: 'pointer',
        fontSize: '0.88em',
        fontFamily: 'inherit',
    },
    roomList: {
        listStyleType: 'none',
        margin: 0,
        padding: '0 10px',
        maxHeight: '220px',
        overflowY: 'auto',
    },
    roomListMenuOpen: {
        overflow: 'visible',
    },
    roomRow: {
        position: 'relative',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 8,
        minHeight: 26,
        padding: '6px 0',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        color: '#fff',
        fontSize: '0.9em',
    },
    activeRoomRow: {
        position: 'relative',
        listStyleType: 'none',
        padding: '6px 0',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        color: '#fff',
        fontSize: '0.9em',
    },
    roomName: {
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        margin: 0,
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 'inherit',
        textAlign: 'left',
    },
    roomTitle: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        minWidth: 0,
    },
    roomTitleText: {
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    },
    roomIcon: {
        flex: '0 0 auto',
        opacity: 0.7,
    },
    roomActions: {
        position: 'relative',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 6,
        flexShrink: 0,
    },
    roomSettingsBtn: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        padding: 0,
        borderRadius: 4,
        border: 'none',
        background: 'rgba(255,255,255,0.1)',
        color: 'rgba(255,255,255,0.75)',
        cursor: 'pointer',
        fontSize: '0.9em',
        lineHeight: 1,
        fontFamily: 'inherit',
    },
    roomSettingsBtnHidden: {
        visibility: 'hidden',
        opacity: 0,
        pointerEvents: 'none',
    },
    inviteButton: {
        flexShrink: 0,
        background: 'transparent',
        color: '#fff',
    },
    roomMenu: {
        position: 'absolute',
        top: 'calc(100% + 4px)',
        right: 0,
        zIndex: 2,
        minWidth: '110px',
        padding: '4px',
        border: '1px solid rgba(255,255,255,0.14)',
        borderRadius: 4,
        background: '#263442',
        boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
    },
    deleteMenuItem: {
        width: '100%',
        padding: '6px 10px',
        border: 'none',
        borderRadius: 3,
        background: 'transparent',
        color: '#ffb4b4',
        cursor: 'pointer',
        fontSize: '0.9em',
        fontWeight: 600,
        fontFamily: 'inherit',
        textAlign: 'left',
    },
    invitePicker: {
        position: 'absolute',
        top: 38,
        right: 0,
        left: 'auto',
        zIndex: 4,
        width: 280,
        maxWidth: '100%',
        boxSizing: 'border-box',
        padding: 10,
        border: '1px solid rgba(255,255,255,0.14)',
        borderRadius: 4,
        background: '#263442',
        boxShadow: '0 6px 18px rgba(0,0,0,0.4)',
        color: '#fff',
    },
    inviteTitle: {
        fontSize: '0.9em',
    },
    inviteHeader: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        marginBottom: 8,
    },
    inviteCloseButton: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        width: 24,
        height: 24,
        padding: 0,
        border: 'none',
        borderRadius: 3,
        background: 'transparent',
        color: '#fff',
        cursor: 'pointer',
        fontFamily: 'inherit',
    },
    inviteSearchInput: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 8px',
        border: '1px solid rgba(255,255,255,0.2)',
        borderRadius: 4,
        background: 'rgba(0,0,0,0.22)',
        color: '#fff',
        fontFamily: 'inherit',
        fontSize: '0.88em',
    },
    inviteUserList: {
        listStyle: 'none',
        margin: '8px 0 0',
        padding: 0,
        maxHeight: 190,
        overflowY: 'auto',
    },
    inviteUserRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '7px 8px',
    },
    inviteUserIconButton: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        width: 26,
        height: 26,
        padding: 0,
        border: 'none',
        borderRadius: 3,
        background: 'rgba(91,156,248,0.18)',
        color: '#b9d6ff',
        cursor: 'pointer',
        fontFamily: 'inherit',
    },
    inviteUserButtonDisabled: {
        cursor: 'default',
        opacity: 0.6,
    },
    inviteUserIdentity: {
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minWidth: 0,
    },
    inviteUsername: {
        marginTop: 1,
        color: 'rgba(255,255,255,0.55)',
        fontSize: '0.8em',
    },
    inviteEmpty: {
        padding: '10px 2px 2px',
        color: 'rgba(255,255,255,0.55)',
        fontSize: '0.8em',
        lineHeight: 1.35,
    },
    inviteError: {
        marginTop: 8,
        color: '#ffb4b4',
        fontSize: '0.8em',
    },
    inviteStatus: {
        marginTop: 8,
        color: '#9ee6b2',
        fontSize: '0.8em',
    },
    roomHint: {
        color: 'rgba(255,255,255,0.5)',
        fontSize: '0.82em',
        lineHeight: 1.35,
        padding: '8px 0',
    },
    inRoomHeader: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 10px 8px',
        gap: 8,
    },
    inRoomHeaderInList: {
        padding: '0 0 2px',
    },
    inRoomIdentity: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flex: 1,
        minWidth: 0,
    },
    inRoomTitle: {
        color: '#fff',
        fontWeight: 600,
        fontSize: '0.95em',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flex: '0 1 auto',
        minWidth: 0,
    },
    voiceControls: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        flexShrink: 0,
    },
    voiceControlButton: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        padding: 0,
        border: 'none',
        borderRadius: 4,
        background: 'transparent',
        color: 'white',
        cursor: 'pointer',
    },
    inRoomHeaderActions: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
    },
    hangupBtn: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        padding: 0,
        borderRadius: 4,
        border: 'none',
        background: 'rgba(210, 75, 75, 0.35)',
        color: '#ffb4b4',
        cursor: 'pointer',
        lineHeight: 1,
    },
    hangupIcon: {
        display: 'block',
        width: 14,
        height: 14,
        margin: 0,
        fontSize: 14,
        lineHeight: '14px',
        textAlign: 'center',
        transform: 'rotate(135deg)',
        transformOrigin: '50% 50%',
    },
    hint: {
        margin: '0 10px 8px',
        fontSize: '0.78em',
        color: 'rgba(255,255,255,0.45)',
        lineHeight: 1.3,
    },
    hintInList: {
        margin: '2px 0 4px 22px',
    },
    headphonesIcon: {
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 20,
        height: 18,
    },
    headphonesSlash: {
        position: 'absolute',
        left: 0,
        top: '50%',
        width: '20px',
        height: '2px',
        borderRadius: '1px',
        background: 'currentColor',
        transform: 'rotate(-45deg)',
        transformOrigin: 'center',
        pointerEvents: 'none',
    },
    list: {
        listStyleType: 'none',
        margin: 0,
        padding: '0 10px',
    },
    listItem: {
        display: 'flex',
        alignItems: 'center',
        color: 'white',
        fontSize: '0.88em',
        padding: '2px 0',
    },
    rosterName: {
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    },
    rosterMic: {
        flex: '0 0 auto',
        marginLeft: 6,
        color: 'rgba(255,255,255,0.85)',
        fontSize: '0.9em',
    },
    rosterMicOff: {
        color: 'rgba(255,255,255,0.45)',
    },
    online: {
        color: '#4cd6a1',
        marginRight: '10px',
    },
});
