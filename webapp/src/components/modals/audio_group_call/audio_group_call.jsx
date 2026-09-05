/* eslint-disable react/prop-types */
/* eslint-disable no-shadow */
import {connect} from 'react-redux';
import React from 'react';
import {getCurrentUser, getProfiles} from 'mattermost-redux/selectors/entities/users';
import {getConfig} from 'mattermost-redux/selectors/entities/general';
import PropTypes from 'prop-types';
import swarm from 'webrtc-swarm';

import pluginSignalHub from '../../../utils/pluginSignalHub';
import {buildIceServers} from '../../../utils/iceServers';
import debug from '../../../utils/debug';
import {userDisplayName} from '../../../utils/dmPickerPeers';
import {createVoiceRoom, deleteVoiceRoom, fetchVoiceRooms, sendVoicePresence} from '../../../utils/voiceRoomsApi';
import {id as pluginId} from 'manifest';

/*
 * The directory is server state and nothing pushes changes, so the panel polls.
 * It carries occupancy now, which people expect to move in something close to
 * real time, hence the shorter interval than a room list alone would need.
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
        };

        this.swarmInstance = null;
        this.directoryPoll = null;
        this.presenceHeartbeat = null;
        this.currentMyStream = null;
        this.connectPending = false;
        this.isUnmounted = false;
    }

    componentDidMount() {
        // The directory no longer depends on the client config: it is a plugin
        // endpoint of its own, so it loads even before /v1/config comes back.
        this.bootstrapDirectory();
    }

    componentWillUnmount() {
        this.isUnmounted = true;
        this.stopPresence();
        this.cleanupConnection(() => {
            /* sync teardown */
        });
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
        return sendVoicePresence(roomId).
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
        return sendVoicePresence('').
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
                        {entry.name}
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

    leaveRoomInternal(cb) {
        this.connectPending = false;

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
            if (!this.isUnmounted) {
                this.setState({
                    activeRoom: null,
                    initialized: false,
                    swarmInitialized: false,
                    peerStreams: {},
                    playBacks: {},
                    audioOn: false,
                    speakerOn: false,
                });
            }
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
        this.cleanupConnection(() => {
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
            });
            this.startPresence(roomId);
        });
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
        this.setState({initialized: true, myStream, audioEnabled, videoEnabled});
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

    handleAudioToggle() {
        const {peerStreams, audioOn} = this.state;
        if (this.currentMyStream) {
            const tracks = this.currentMyStream.getAudioTracks();
            if (tracks[0]) {
                tracks[0].enabled = !audioOn;
            }

            for (const pid of Object.keys(peerStreams)) {
                const peerStream = peerStreams[pid];
                if (peerStream.connected && peerStream.peer) {
                    peerStream.peer.send(JSON.stringify({type: 'audioToggle', enabled: !audioOn}));
                }
            }
        }
        this.setState({
            audioOn: !audioOn,
        });
    }

    handleSpeakerToggle() {
        debug('Handle Speaker Toggle');
        const {playBacks, speakerOn} = this.state;

        for (const id of Object.keys(playBacks)) {
            const aud = playBacks[id];
            aud.muted = speakerOn;
            debug(id, 'Speaker On', aud.muted);
        }

        this.setState({
            speakerOn: !speakerOn,
        });
    }

    render() {
        const {
            userId,
            initialized,
            swarmInitialized,
            audioOn,
            audioEnabled,
            speakerOn,
            peerStreams,
            activeRoom,
            channelList,
            directoryError,
            showCreateInput,
            newChannelNameDraft,
            hoveredRoomId,
            openRoomMenuId,
        } = this.state;
        const style = getStyle();

        debug('Render', userId, initialized, swarmInitialized, this.state, this.props);

        const {isSystemAdmin} = this.props;
        const selfName = this.props.displayName || 'You';
        const currentRoom = activeRoom && channelList.find((room) => room.roomId === activeRoom.roomId);

        let connectionHint = 'Connecting…';
        if (swarmInitialized) {
            connectionHint = audioOn ? 'You are connected. Others can hear you.' : 'You are connected, with your microphone muted.';
        } else if (initialized && !audioEnabled) {
            connectionHint = 'No microphone available — you can listen, but not speak.';
        }

        if (activeRoom && audioOn && !initialized) {
            this.handleRequestPerms();
        }

        if (activeRoom && initialized && !swarmInitialized && !this.connectPending && !this.swarmInstance) {
            this.connectToSwarm(userId);
        }

        return (
            <div style={style.container}>
                {!activeRoom && (
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
                        <ul style={openRoomMenuId ? {...style.roomList, ...style.roomListMenuOpen} : style.roomList}>
                            {channelList.length === 0 && !showCreateInput && (
                                <li style={style.roomHint}>
                                    {isSystemAdmin ? 'No channels yet — create one and everyone on this server will see it.' : 'No voice channels yet. A system administrator can create one.'}
                                </li>
                            )}
                            {channelList.map((r) => (
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
                            ))}
                        </ul>
                    </div>
                )}

                {activeRoom && (
                    <div style={style.section}>
                        <div style={style.inRoomHeader}>
                            <span style={style.inRoomTitle}>
                                <i
                                    className='icon fa fa-volume-up'
                                    style={style.roomIcon}
                                    aria-hidden='true'
                                />
                                <span style={style.roomTitleText}>{activeRoom.name}</span>
                            </span>
                            <span style={style.inRoomHeaderActions}>
                                {currentRoom && this.canDeleteRoom(currentRoom) && (
                                    <button
                                        type='button'
                                        style={style.deleteChannelBtn}
                                        onClick={this.handleDeleteRoom(activeRoom.roomId)}
                                        title='Delete this voice channel for everyone and leave'
                                    >
                                        {'Delete'}
                                    </button>
                                )}
                                <button
                                    type='button'
                                    style={style.leaveBtn}
                                    onClick={this.handleLeaveRoom}
                                    title='Leave voice channel'
                                >
                                    {'Leave'}
                                </button>
                            </span>
                        </div>
                        <div style={style.flexContainer}>
                            <i
                                className={audioOn ? 'icon fa fa-microphone fa-lg' : 'icon fa fa-microphone-slash  fa-lg'}
                                style={style.button}
                                onClick={this.handleAudioToggle.bind(this)}
                                role='button'
                                tabIndex={0}
                                onKeyDown={(ev) => ev.key === 'Enter' && this.handleAudioToggle()}
                            />
                            <button
                                type='button'
                                style={style.speakerButton}
                                onClick={this.handleSpeakerToggle.bind(this)}
                                title={speakerOn ? 'Disable voice channel audio' : 'Enable voice channel audio'}
                                aria-label={speakerOn ? 'Disable voice channel audio' : 'Enable voice channel audio'}
                            >
                                <span style={style.speakerIcon}>
                                    <i
                                        className='icon fa fa-volume-up fa-lg'
                                        aria-hidden='true'
                                    />
                                    {!speakerOn && (
                                        <span
                                            className='voice-channel-speaker-slash'
                                            style={style.speakerSlash}
                                            aria-hidden='true'
                                        />
                                    )}
                                </span>
                            </button>
                        </div>
                        <p style={style.hint}>{connectionHint}</p>
                        {this.renderRoster([
                            ...(swarmInitialized ? [{key: 'self', name: selfName}] : []),
                            ...Object.keys(peerStreams).map((id) => ({
                                key: id,
                                name: this.peerDisplayName(id, peerStreams[id]),
                            })),
                        ])}
                    </div>
                )}
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
    inRoomTitle: {
        color: '#fff',
        fontWeight: 600,
        fontSize: '0.95em',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        minWidth: 0,
    },
    inRoomHeaderActions: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
    },
    deleteChannelBtn: {
        padding: '4px 10px',
        borderRadius: 4,
        border: 'none',
        background: 'rgba(210, 75, 75, 0.45)',
        color: '#fff',
        cursor: 'pointer',
        fontSize: '0.82em',
        fontWeight: 600,
        fontFamily: 'inherit',
    },
    leaveBtn: {
        padding: '4px 10px',
        borderRadius: 4,
        border: '1px solid rgba(255,255,255,0.25)',
        background: 'transparent',
        color: 'rgba(255,255,255,0.9)',
        cursor: 'pointer',
        fontSize: '0.82em',
        fontFamily: 'inherit',
    },
    hint: {
        margin: '0 10px 8px',
        fontSize: '0.78em',
        color: 'rgba(255,255,255,0.45)',
        lineHeight: 1.3,
    },
    button: {
        margin: '5px',
        color: 'white',
        flexGrow: '1',
        padding: '3px',
        cursor: 'pointer',
    },
    speakerButton: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexGrow: 1,
        margin: '5px',
        padding: '3px',
        border: 'none',
        background: 'transparent',
        color: 'white',
        cursor: 'pointer',
    },
    speakerIcon: {
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 20,
        height: 18,
    },
    speakerSlash: {
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
    flexContainer: {
        display: 'flex',
        padding: '0 10px',
    },
    list: {
        listStyleType: 'none',
        margin: 0,
        padding: '0 10px',
    },
    listItem: {
        color: 'white',
        fontSize: '0.88em',
        padding: '2px 0',
    },
    online: {
        color: '#4cd6a1',
        marginRight: '10px',
    },
});
